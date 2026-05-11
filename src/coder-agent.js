'use strict';

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { OPENROUTER_API_KEY, SKILLS_DIR, PYTHON_CMD } = require('./config');
const logger = require('./logger');

const CODER_MODEL = '@preset/mighty-agent-coder';
const MAX_ITERATIONS = 15;
const PYTHON_TIMEOUT_MS = 30_000;

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a file inside the skills/ directory. Creates directories as needed. ' +
        'Use this to create SKILL.md files and Python scripts for new skills. ' +
        'Path must be relative to the skills/ directory (e.g. "my-skill/SKILL.md" or "my-skill/scripts/my_script.py").',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Path relative to the skills/ directory (e.g. "my-skill/scripts/my_script.py")',
          },
          content: {
            type: 'string',
            description: 'The full file content to write.',
          },
        },
        required: ['relative_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read the content of a file. Path must be relative to the skills/ directory. ' +
        'Useful for reading existing skill files as a reference.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Path relative to the skills/ directory.',
          },
        },
        required: ['relative_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        'List files and directories. Path must be relative to the skills/ directory. ' +
        'Defaults to listing the top-level skills/ directory if no path is given.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Path relative to skills/ directory. Omit or use "" to list all skills.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_python',
      description:
        'Execute a Python script and return its stdout and stderr. ' +
        'Path must be relative to the skills/ directory. ' +
        'Use this to test scripts you have written before declaring the task complete.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: {
            type: 'string',
            description: 'Path to the Python script, relative to the skills/ directory.',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional CLI arguments to pass to the script.',
          },
        },
        required: ['relative_path'],
      },
    },
  },
];

// ─── Tool Implementations ─────────────────────────────────────────────────────

/**
 * Resolve and validate a relative path inside SKILLS_DIR.
 * Throws if the resolved path escapes SKILLS_DIR.
 */
function resolveSafe(relativePath) {
  const resolved = path.resolve(SKILLS_DIR, relativePath);
  if (!resolved.startsWith(path.resolve(SKILLS_DIR))) {
    throw new Error(`Path traversal detected: "${relativePath}" is outside the skills/ directory.`);
  }
  return resolved;
}

function toolWriteFile({ relative_path, content }) {
  try {
    const absPath = resolveSafe(relative_path);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
    logger.info(`[Coder] Wrote file: ${absPath}`);
    return { success: true, path: absPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function toolReadFile({ relative_path }) {
  try {
    const absPath = resolveSafe(relative_path);
    const content = fs.readFileSync(absPath, 'utf-8');
    return { success: true, content };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function toolListFiles({ relative_path = '' }) {
  try {
    const absPath = resolveSafe(relative_path || '.');
    const entries = fs.readdirSync(absPath, { withFileTypes: true });
    const listing = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
    }));
    return { success: true, path: absPath, entries: listing };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function toolExecutePython({ relative_path, args = [] }) {
  return new Promise((resolve) => {
    let absPath;
    try {
      absPath = resolveSafe(relative_path);
    } catch (err) {
      return resolve({ success: false, error: err.message });
    }

    if (!fs.existsSync(absPath)) {
      return resolve({ success: false, error: `File not found: ${absPath}` });
    }

    logger.info(`[Coder] Executing: ${PYTHON_CMD} ${absPath} ${args.join(' ')}`);

    const child = spawn(PYTHON_CMD, [absPath, ...args], {
      cwd: path.dirname(absPath),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, PYTHON_TIMEOUT_MS);

    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        success: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.on('error', err => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
  });
}

async function executeTool(name, input) {
  switch (name) {
    case 'write_file':    return toolWriteFile(input);
    case 'read_file':     return toolReadFile(input);
    case 'list_files':    return toolListFiles(input);
    case 'execute_python': return toolExecutePython(input);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ─── Coder Agent Loop ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert software engineer embedded in a modular AI agent system called "Mighty Agent".

Your role is to create and modify agent skills. Each skill lives in its own folder under skills/:
  skills/<skill-name>/
    SKILL.md              ← skill metadata (required)
    scripts/
      <script_name>.py    ← entry point Python script (required)

SKILL.md format (use exactly):
---
name: <skill-name>
description: <one sentence description for the LLM to understand when to use this skill>
license: MIT
compatibility: Requires Python 3.x
metadata:
  author: indotraq-agent
  version: "1.0"
allowed-tools: Bash(python:*)
---

# <skill-name>

<brief description>

## When to use
- <use case>

## Instructions
1. Run the script \`scripts/<script_name>.py\`.
2. Return output to the user.

Python script requirements:
- Start with: #!/usr/bin/env python3
- Force UTF-8: if hasattr(sys.stdout, 'reconfigure'): sys.stdout.reconfigure(encoding='utf-8')
- All output goes to stdout via print()
- Use a main() function and \`if __name__ == "__main__": main()\`

Workflow:
1. List existing skills to understand the project structure.
2. Read a similar existing skill's files as a reference if helpful.
3. Write the SKILL.md and Python script.
4. Execute the script to verify it works.
5. Fix any errors and re-execute until it passes.
6. Report what you built with a clear summary.

Always test your code before reporting success. Never report done unless execute_python returned exit code 0.`;

/**
 * Helper to call OpenRouter API.
 */
async function callOpenRouter(messages, tools) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured in .env');

  const url = "https://openrouter.ai/api/v1/chat/completions";
  const headers = {
    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
    "Content-Type": "application/json"
  };
  const payload = {
    model: CODER_MODEL,
    messages: messages,
    tools: tools,
    tool_choice: "auto"
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
  }

  return await response.json();
}

/**
 * Run the Coder sub-agent for a given task.
 * Returns { summary: string, filesCreated: string[] }
 */
async function runCoderAgent(task) {
  logger.info(`[Coder] Starting task: ${task}`);

  let messages = [
    { role: 'user', content: task },
  ];

  const filesCreated = [];
  let iterations = 0;
  let finalSummary = '';

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    logger.info(`[Coder] Iteration ${iterations}/${MAX_ITERATIONS}`);

    const systemMsg = { role: 'system', content: SYSTEM_PROMPT };
    const conversation = [systemMsg, ...messages];

    const data = await callOpenRouter(conversation, TOOLS);
    const assistantMsg = data.choices[0].message;

    // Add assistant turn to history
    messages.push(assistantMsg);

    // If no tool calls, the agent is done
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      finalSummary = assistantMsg.content || '';
      logger.info('[Coder] Agent finished (no more tool calls).');
      break;
    }

    // Execute tool calls
    for (const toolCall of assistantMsg.tool_calls) {
      const { name, arguments: argsJson } = toolCall.function;
      let args;
      try {
        args = JSON.parse(argsJson);
      } catch (e) {
        args = {};
      }

      logger.info(`[Coder] Tool call: ${name} ${argsJson}`);
      const result = await executeTool(name, args);

      // Track created files
      if (name === 'write_file' && result.success) {
        filesCreated.push(result.path);
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: name,
        content: JSON.stringify(result),
      });
    }
  }

  if (!finalSummary) {
    finalSummary = iterations >= MAX_ITERATIONS
      ? '⚠️ Coder reached the maximum iteration limit. Task may be incomplete.'
      : '✅ Task complete.';
  }

  logger.info(`[Coder] Done. Files created: ${filesCreated.join(', ') || 'none'}`);
  return { summary: finalSummary, filesCreated };
}

module.exports = { runCoderAgent };
