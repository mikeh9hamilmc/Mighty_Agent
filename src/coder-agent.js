'use strict';

const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { OPENROUTER_API_KEY, SKILLS_DIR, PYTHON_CMD } = require('./config');
const logger = require('./logger');
const { DocumentManager } = require('./document-tools');

const CODER_MODEL = '@preset/mighty-agent-coder';
const MAX_ITERATIONS = 15;
const PYTHON_TIMEOUT_MS = 30_000;

// Initialize DocumentManager for 'coder'
const coderTools = new DocumentManager('coder');

const SYSTEM_PROMPT = `You are a senior level programmer embedded in a modular AI agent system called "Mighty Agent". You can create skills similar to dip-buy.

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

TOOLS AVAILABLE:
You have access to the user's codebase, documents, and memory.
• write_file — Write content to a file inside the skills/ directory.
• execute_python — Execute a Python script inside skills/ to test your code.
• list_documents — See all files in the coder/data/ folder.
• grep_documents — Search for specific terms across all documents.
• view_document — Read a specific file or line range.
• web_search — Search the web for APIs, docs, or code examples.
• save_memory / read_memory / list_memories — Access persistent memory.

WORKFLOW:
1. Use grep_documents or view_document to read existing skills (like dip-buy) as a reference.
2. Write the SKILL.md and Python script using write_file.
3. Execute the script to verify it works using execute_python.
4. Fix any errors and re-execute until it passes.
5. Report what you built with a clear summary.

IMPORTANT WARNINGS:
• Always test your code before reporting success. Never report done unless execute_python returned exit code 0.
• Be direct and precise. Format answers with markdown.

MEMORY SYSTEM:
You possess persistent long-term memory. You have a private memory folder where you store notes on APIs or architectural decisions.
• Use save_memory to record important facts.
• Use list_memories and read_memory to recall previous context.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_documents',
      description: 'List all files in the coder/data/ folder.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_documents',
      description: 'Search for a pattern across all coder documents.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string', description: 'Term or regex to search for.' } },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_document',
      description: 'Read a specific document in the coder/data/ folder.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Name of the file to read.' },
          start_line: { type: 'integer', description: 'Start line (1-indexed).' },
          end_line: { type: 'integer', description: 'End line (inclusive).' },
        },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for documentation, APIs, or code examples.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Web search query.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save a note about an API pattern, architecture decision, or user preference.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Short filename for this memory.' },
          content: { type: 'string', description: 'Detailed notes in Markdown.' },
        },
        required: ['topic', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description: 'Read a specific memory file.',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string', description: 'The topic/filename to read.' } },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_memories',
      description: 'List all topics currently stored in persistent memory.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file inside the skills/ directory. Path must be relative to skills/ (e.g. "my-skill/SKILL.md" or "my-skill/scripts/my_script.py").',
      parameters: {
        type: 'object',
        properties: {
          relative_path: { type: 'string', description: 'Path relative to skills/' },
          content: { type: 'string', description: 'The full file content to write.' },
        },
        required: ['relative_path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_python',
      description: 'Execute a Python script inside skills/ to test it. Returns stdout and stderr.',
      parameters: {
        type: 'object',
        properties: {
          relative_path: { type: 'string', description: 'Path to the Python script, relative to skills/' },
          args: { type: 'array', items: { type: 'string' }, description: 'Optional CLI args.' },
        },
        required: ['relative_path'],
      },
    },
  },
];


// ─── Custom Tool Implementations ──────────────────────────────────────────────

function resolveSafe(relativePath) {
  const resolved = path.resolve(SKILLS_DIR, relativePath);
  if (!resolved.startsWith(path.resolve(SKILLS_DIR))) {
    throw new Error('Path traversal detected: "' + relativePath + '" is outside the skills/ directory.');
  }
  return resolved;
}

function toolWriteFile({ relative_path, content }) {
  try {
    const absPath = resolveSafe(relative_path);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
    logger.info('[Coder] Wrote file: ' + absPath);
    return { success: true, path: absPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function toolExecutePython({ relative_path, args = [] }) {
  return new Promise((resolve) => {
    let absPath;
    try { absPath = resolveSafe(relative_path); } catch (err) { return resolve({ success: false, error: err.message }); }

    if (!fs.existsSync(absPath)) {
      return resolve({ success: false, error: 'File not found: ' + absPath });
    }

    logger.info('[Coder] Executing: ' + PYTHON_CMD + ' ' + absPath + ' ' + args.join(' '));
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
      resolve({ success: exitCode === 0 && !timedOut, exitCode, timedOut, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ success: false, error: err.message });
    });
  });
}

// ─── OpenRouter Helper ────────────────────────────────────────────────────────

async function callOpenRouter(messages, tools) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured in .env');

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + OPENROUTER_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CODER_MODEL, messages, tools, tool_choice: 'auto' })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error('OpenRouter API error: ' + response.status + ' ' + errorText);
  }
  return await response.json();
}

function isReadCommand(text) {
  const lower = text.toLowerCase();
  return lower.includes('read document') || lower.includes('read the document') || lower.includes('index document');
}

// ─── Main Agent Loop ──────────────────────────────────────────────────────────

async function runCoderAgent(question, onChunk = () => {}) {
  logger.info('[Coder] Starting task: ' + question);

  if (isReadCommand(question)) {
    onChunk('📂 Scanning and caching documents...\n');
    const summary = await coderTools.initTools();
    onChunk(summary);
    return { answer: summary, sources: [] };
  }

  await coderTools.ensureInitialized();

  let messages = [{ role: 'user', content: question }];
  const sources = new Set();
  const filesCreated = [];
  let fullAnswer = '';
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    logger.info('[Coder] Iteration ' + iterations + '/' + MAX_ITERATIONS);

    let currentSystemPrompt = SYSTEM_PROMPT;
    const coreMem = coderTools.getCoreMemory();
    if (coreMem) {
      currentSystemPrompt += '\n\n--- AUTO-INJECTED CORE MEMORY ---\n' + coreMem + '\n---------------------------------';
    }

    const systemMsg = { role: 'system', content: currentSystemPrompt };
    const conversation = [systemMsg, ...messages];

    const data = await callOpenRouter(conversation, TOOLS);
    const assistantMsg = data.choices[0].message;
    messages.push(assistantMsg);

    if (assistantMsg.content) {
      onChunk(assistantMsg.content);
      fullAnswer += assistantMsg.content;
    }

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      logger.info('[Coder] Agent finished (no more tool calls).');
      break;
    }

    for (const toolCall of assistantMsg.tool_calls) {
      const { name, arguments: argsJson } = toolCall.function;
      let args = {};
      try { args = JSON.parse(argsJson); } catch (e) { args = {}; }

      logger.info('[Coder] Tool call: ' + name + ' ' + argsJson);

      let result;
      if (name === 'write_file') {
        result = toolWriteFile(args);
        if (result.success) filesCreated.push(result.path);
      } else if (name === 'execute_python') {
        result = await toolExecutePython(args);
      } else {
        result = await coderTools.executeTool(name, args);
      }

      if (name === 'view_document' && result.filename) sources.add(result.filename);
      if (name === 'grep_documents' && result.matches) result.matches.forEach(m => sources.add(m.file));
      if (name === 'web_search' && result.results) result.results.forEach(r => sources.add(r.url));

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: name,
        content: JSON.stringify(result),
      });
    }
  }

  if (!fullAnswer && iterations >= MAX_ITERATIONS) {
    fullAnswer = '⚠️ Coder agent reached the iteration limit. Task may be incomplete.';
    onChunk(fullAnswer);
  }

  if (filesCreated.length > 0) {
    const fileMsg = '\n\n📁 **Files created/updated:**\n' + filesCreated.map(f => '`' + f + '`').join('\n') + '\n\n⚠️ *Restart the agent to load new skills.*';
    onChunk(fileMsg);
    fullAnswer += fileMsg;
  }

  logger.info('[Coder] Done. Sources: ' + ([...sources].join(', ') || 'none'));
  return { answer: fullAnswer, sources: [...sources] };
}

module.exports = { runCoderAgent, coderTools };

