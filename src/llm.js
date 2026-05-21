'use strict';

/**
 * Main Agent — Agentic Router
 *
 * The primary orchestrator. Runs a tool-calling loop that can:
 *  1. Consult its own documents (skills/main/data/) and memory.
 *  2. Route to specialized sub-agents (legal, medical, finance, coder).
 *  3. Run Python skills directly.
 *  4. Reply conversationally.
 *
 * The `decideAction` function is still the public interface for bot.js,
 * but internally it now uses a full agentic loop rather than a one-shot call.
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { OPENROUTER_API_KEY, SKILLS_DIR } = require('./config');
const { DocumentManager } = require('./document-tools');
const logger = require('./logger');
const cancellation = require('./cancellation');

const MAIN_MODEL = '@preset/mighty-agent-main';
const MAX_ITERATIONS = 30;

// ─── Document/Memory access for Main Agent ────────────────────────────────────

const mainDocs = new DocumentManager('main');
mainDocs.ensureInitialized().catch(err => {
  logger.warn(`[Main] Doc init failed: ${err.message}`);
});

// ─── Skill loading ────────────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^"|"$/g, '');
    if (key && value) result[key] = value;
  }
  return result;
}

function loadEnabledConfig() {
  const configPath = path.join(SKILLS_DIR, 'enabled_skills.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (err) {
    logger.warn('Failed to read enabled_skills.json: ' + err.message);
  }
  return { skills: {} };
}

function saveEnabledConfig(config) {
  const configPath = path.join(SKILLS_DIR, 'enabled_skills.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  } catch (err) {
    logger.warn('Failed to write enabled_skills.json: ' + err.message);
  }
}

function loadSkills() {
  if (!fs.existsSync(SKILLS_DIR)) {
    logger.warn('Skills directory not found: ' + SKILLS_DIR);
    return [];
  }

  // Sub-agent skill folders don't have runnable scripts — exclude them from the skills list
  const AGENT_FOLDERS = new Set(['legal', 'medical', 'finance', 'main', 'coder', 'travel', 'refresh', 'beauty']);


  const config = loadEnabledConfig();
  let configDirty = false;
  const allSkills = [];

  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (AGENT_FOLDERS.has(entry.name)) continue;

    const skillMdPath = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const fm = parseFrontmatter(content);
      if (!fm || !fm.name || !fm.description) {
        logger.warn('Skipping skill "' + entry.name + '": SKILL.md missing name or description');
        continue;
      }

      // Auto-register new skills into enabled_skills.json
      if (!config.skills[fm.name]) {
        config.skills[fm.name] = { enabled: true, description: fm.description };
        configDirty = true;
        logger.info('Auto-registered new skill in enabled_skills.json: ' + fm.name);
      }

      allSkills.push({
        name: fm.name,
        description: fm.description,
        scriptDir: path.join(SKILLS_DIR, entry.name, 'scripts'),
        enabled: config.skills[fm.name]?.enabled !== false,
      });
    } catch (err) {
      logger.warn('Failed to read SKILL.md for "' + entry.name + '": ' + err.message);
    }
  }

  if (configDirty) saveEnabledConfig(config);
  return allSkills;
}

let ALL_SKILLS = [];
let SKILLS = [];

function refreshSkills() {
  ALL_SKILLS = loadSkills();
  SKILLS = ALL_SKILLS.filter(s => s.enabled);

  if (SKILLS.length === 0) {
    logger.warn('No enabled skills found in the skills/ directory.');
  } else {
    logger.info('Loaded ' + SKILLS.length + ' skill(s): ' + SKILLS.map(s => s.name).join(', '));
    const disabled = ALL_SKILLS.filter(s => !s.enabled);
    if (disabled.length > 0) {
      logger.info('Disabled skill(s): ' + disabled.map(s => s.name).join(', '));
    }
  }
  return { ALL_SKILLS, SKILLS };
}

// Initial load
refreshSkills();



// ─── Tool Definitions ─────────────────────────────────────────────────────────

function buildTools() {
  const skillNames = SKILLS.map(s => s.name);

  return [
    // ── Document tools ──────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'list_documents',
        description: 'List all documents in your personal data folder (skills/main/data/). Use this to see what reference documents are available to you.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep_documents',
        description: 'Search for a pattern across your personal data documents.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Text or regex to search for.' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'view_document',
        description: 'Read a specific document from your personal data folder.',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Name of the file to read.' },
            start_line: { type: 'integer', description: 'Start line (1-indexed). Optional.' },
            end_line: { type: 'integer', description: 'End line (inclusive). Optional.' },
          },
          required: ['filename'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_document',
        description: 'Create a new document file in the main/data/ folder. Use this to write research, notes, or information. Always use .md (Markdown) format.',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Filename for the new document (e.g. "Research.md"). Must end in .md or .txt.' },
            content: { type: 'string', description: 'Full content of the document, written in Markdown.' },
            overwrite: { type: 'boolean', description: 'Set to true to overwrite an existing file with the same name. Default: false.' },
          },
          required: ['filename', 'content'],
        },
      },
    },
    // ── Memory tools ────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'save_memory',
        description: 'Save a note or fact to your persistent long-term memory.',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'Short filename for this memory (e.g. "user-preferences").' },
            content: { type: 'string', description: 'The content to save, written in Markdown.' },
          },
          required: ['topic', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_memory',
        description: 'Read a specific memory file from your persistent long-term memory.',
        parameters: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'The topic/filename of the memory to read.' },
          },
          required: ['topic'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_memories',
        description: 'List all topics stored in your persistent long-term memory.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Perform a live web search for current information.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query.' },
          },
          required: ['query'],
        },
      },
    },
    // ── Session tools ───────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'save_session_history',
        description: 'Save the current conversation history for the active session to a Markdown file in your personal data folder.',
        parameters: {
          type: 'object',
          properties: {
            filename: { type: 'string', description: 'Name of the file to create (e.g. "session_log_2024.md").' },
          },
          required: ['filename'],
        },
      },
    },
    // ── Routing tools ────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'run_skill',
        description: `Run a local Python skill on the user's machine. Available skills: ${skillNames.length > 0 ? skillNames.join(', ') : 'none'}. Use this when the user asks for a task one of these skills can fulfill.`,
        parameters: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: 'The exact skill name to run.' },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional CLI arguments to pass to the skill.',
            },
          },
          required: ['skill'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ask_agent',
      description: 'Delegate the question to a specialized sub-agent. This gives the sub-agent full autonomy to run a multi-step research loop using its own documents and memory.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            enum: ['legal', 'medical', 'finance', 'coder', 'travel', 'beauty'],
            description: 'The specialized agent to use.'
          },
          task: { type: 'string', description: 'The specific task, question, or request for the sub-agent.' }
        },
        required: ['agent', 'task'],
      },
    }
  }
];
}

// ─── OpenRouter helper ────────────────────────────────────────────────────────

async function callOpenRouter(messages, tools) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured.');

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MAIN_MODEL,
      messages,
      tools,
      tool_choice: "auto"
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter error: ${response.status} ${errorText}`);
  }

  return await response.json();
}

// ─── Tool executor ────────────────────────────────────────────────────────────

async function executeLocalTool(name, args) {
  switch (name) {
    case 'list_documents': return mainDocs.toolListDocuments();
    case 'grep_documents': return mainDocs.toolGrepDocuments(args);
    case 'view_document': return mainDocs.toolViewDocument(args);
    case 'create_document': return await mainDocs.toolCreateDocument(args);
    case 'web_search': return await mainDocs.toolWebSearch(args);
    case 'save_memory': return mainDocs.toolSaveMemory(args);
    case 'read_memory': return mainDocs.toolReadMemory(args);
    case 'list_memories': return mainDocs.toolListMemories();
    case 'save_session_history': return await mainDocs.toolSaveSessionHistory(args);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ─── Main decision loop ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a friendly, knowledgeable personal assistant for the user. Your primary mode is conversation — chat naturally, answer questions, and be helpful.

You have access to:
1. Your own documents and memory (skills/main/data/) — consult these for personal context before answering.
2. Specialized sub-agents you can delegate to:
   • "legal"   — law, court cases, contracts, attorneys, property disputes
   • "medical" — health, lab results, symptoms, prescriptions, doctor notes
   • "finance" — investing, UPRO/ETF strategy, real estate, taxes, CPA advice
   • "coder"    — writing Python scripts, creating new agent skills, programming tasks
   • "beauty"   — skincare, makeup, botox, and anti-aging advice
3. Runnable Python skills on the user's machine.

Workflow:
• For casual conversation — just reply directly. No tool calls needed.
• Before answering personal questions, check your memory with list_memories / read_memory.
• For domain-specific questions (legal/medical/finance/code) — use ask_agent to delegate.
• For tasks the Python skills handle — use run_skill.
• Always check your memory when the user references past conversations or preferences.

MEMORY RULES (CRITICAL — never break these):
• When the user explicitly asks you to remember, note, or store ANY information as a memory — you MUST call save_memory FIRST, then confirm. Never just say "I'll remember that" without calling the tool.
• When the user shares personal facts (their name, preferences, dates, decisions) — proactively save them using save_memory without being asked.
• Memory filenames should be short and descriptive (e.g. "user-name", "user-preferences", "important-dates").
• ANY memory files listed in your CORE MEMORY section below are ALREADY FULLY LOADED. You can read them directly. DO NOT use \`view_document\`, \`grep_documents\`, or \`read_memory\` to read them. Just answer the user's question.

IMPORTANT — create_document vs save_memory:
• create_document → saves to main/data/ → QUERYABLE by the user and document tools. Use when asked to "create a file with information", "save this to a file", or "store information in the documents".
• save_memory → saves to main/memory/ → private agent notes. Use when the user explicitly says "remember something" or shares personal facts.`;


/**
 * Run the main agent agentic loop for a given user message.
 *
 * Returns one of:
 *   { type: 'reply',   text: '...' }
 *   { type: 'run',     skill: '...', args: [] }
 *   { type: 'code',    task: '...' }
 *   { type: 'legal',   task: '...' }
 *   { type: 'medical', task: '...' }
 *   { type: 'finance', task: '...' }
 *   { type: 'error',   text: '...' }
 */
async function decideAction(userMessage, onStatus = () => { }, history = []) {
  cancellation.setActive(true);
  try {
    const TOOLS = buildTools();

    let coreMemory = '';
    let sources = new Set();
    if (history.length > 0) sources.add('Session Conversation');

    try {
      const cm = mainDocs.getCoreMemory();
      if (cm) {
        coreMemory = `\n\n--- CORE MEMORY ---\n${cm}\n-------------------`;
        sources.add('Core Memory');
      }
    } catch (_) { }

    const messages = [
      ...history,
      { role: 'user', content: userMessage },
    ];

    let iterations = 0;

    try {
      while (iterations < MAX_ITERATIONS) {
        cancellation.check();
        iterations++;
        logger.info(`[Main] Iteration ${iterations}/${MAX_ITERATIONS}`);
        onStatus(`🤔 Thinking... (Step ${iterations})`);

        const systemMsg = { role: 'system', content: SYSTEM_PROMPT + coreMemory };
        const data = await callOpenRouter([systemMsg, ...messages], TOOLS);
        cancellation.check();
        if (!data.choices || data.choices.length === 0) {
          const errorMsg = data.error?.message || 'AI returned an empty response.';
          throw new Error(errorMsg);
        }
        const assistantMsg = data.choices[0].message;

        messages.push(assistantMsg);

        // No tool calls → plain conversational reply
        if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
          const text = assistantMsg.content || "I wasn't sure what to do. Could you rephrase?";
          const sourcesStr = sources.size > 0 ? Array.from(sources).join(', ') : 'Internal Knowledge';
          logger.info(`[Main] Conversational reply [Sources: ${sourcesStr}]: ${text.slice(0, 80)}`);
          return { type: 'reply', text };
        }

        // Process each tool call
        for (const toolCall of assistantMsg.tool_calls) {
          cancellation.check();
          const { name, arguments: argsJson } = toolCall.function;
          let args = {};
          try { args = JSON.parse(argsJson); } catch (_) { }

          logger.info(`[Main] Tool call: ${name} ${argsJson}`);
          
          if (name === 'web_search') sources.add('Web Search');
          if (name === 'read_memory' || name === 'list_memories') sources.add('Memory Tool');
          if (name === 'view_document' || name === 'grep_documents' || name === 'list_documents') sources.add('Data File');

          // ── Routing tools: return immediately without adding tool result ──
          if (name === 'run_skill') {
            return {
              type: 'run',
              skill: args.skill,
              args: Array.isArray(args.args) ? args.args : [],
            };
          }

          if (name === 'ask_agent') {
            const agentMap = { legal: 'legal', medical: 'medical', finance: 'finance', coder: 'coder', travel: 'travel', beauty: 'beauty' };
            const type = agentMap[args.agent] || 'reply';
            if (type === 'reply') return { type: 'reply', text: "I wasn't sure which agent to use." };

            // Inject main memory so sub-agents have user context (name, preferences, etc.)
            let task = args.task;
            const mainMemory = mainDocs.getCoreMemory();
            if (mainMemory) {
              task = `[Context from main agent memory — use this to personalise your response]\n${mainMemory}\n\n[User request]\n${task}`;
            }
            return { type, task };
          }

          // ── Local tool: execute and feed result back ──────────────────────
          onStatus(`🛠️ Tool call: ${name}`);
          const result = await executeLocalTool(name, args);
          cancellation.check();
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name,
            content: JSON.stringify(result),
          });
        }
      }

      return { type: 'reply', text: '⚠️ Main agent reached the iteration limit. Try rephrasing.' };

    } catch (err) {
      logger.error(`[Main] Error: ${err.message}`);
      if (err.message === 'Interrupted') {
        return { type: 'error', text: 'Thinking interrupted.' };
      }
      return { type: 'error', text: `LLM error: ${err.message}` };
    }
  } finally {
    cancellation.setActive(false);
  }
}

module.exports = {
  decideAction,
  loadSkills,
  refreshSkills,
  mainDocs,
  get SKILLS() { return SKILLS; },
  get ALL_SKILLS() { return ALL_SKILLS; }
};

