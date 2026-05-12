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

const MAIN_MODEL = '@preset/mighty-agent-main';
const MAX_ITERATIONS = 10;

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
  const AGENT_FOLDERS = new Set(['legal', 'medical', 'finance', 'main', 'coder']);

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

const ALL_SKILLS = loadSkills();
const SKILLS = ALL_SKILLS.filter(s => s.enabled);

if (SKILLS.length === 0) {
  logger.warn('No enabled skills found in the skills/ directory.');
} else {
  logger.info('Loaded ' + SKILLS.length + ' skill(s): ' + SKILLS.map(s => s.name).join(', '));
  const disabled = ALL_SKILLS.filter(s => !s.enabled);
  if (disabled.length > 0) {
    logger.info('Disabled skill(s): ' + disabled.map(s => s.name).join(', '));
  }
}


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
        description: 'Delegate the user\'s question to a specialized sub-agent. Use "legal" for law/court questions, "medical" for health/medical questions, "finance" for investing/tax/real estate questions, "coder" for programming tasks.',
        parameters: {
          type: 'object',
          properties: {
            agent: {
              type: 'string',
              enum: ['legal', 'medical', 'finance', 'coder'],
              description: 'The specialized agent to delegate to.',
            },
            task: {
              type: 'string',
              description: 'The full user question or task to forward to the sub-agent.',
            },
          },
          required: ['agent', 'task'],
        },
      },
    },
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
    case 'web_search': return await mainDocs.toolWebSearch(args);
    case 'save_memory': return mainDocs.toolSaveMemory(args);
    case 'read_memory': return mainDocs.toolReadMemory(args);
    case 'list_memories': return mainDocs.toolListMemories();
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
3. Runnable Python skills on the user's machine.

Workflow:
• For casual conversation — just reply directly. No tool calls needed.
• Before answering personal questions, check your memory with list_memories / read_memory.
• For domain-specific questions (legal/medical/finance/code) — use ask_agent to delegate.
• For tasks the Python skills handle — use run_skill.
• Always check your memory when the user references past conversations or preferences.

MEMORY RULES (CRITICAL — never break these):
• When the user asks you to remember, note, save, or store ANY information — you MUST call save_memory FIRST, then confirm. Never just say "I'll remember that" without calling the tool.
• When the user shares personal facts (their name, preferences, dates, decisions) — proactively save them using save_memory without being asked.
• Memory filenames should be short and descriptive (e.g. "user-name", "user-preferences", "important-dates").`;


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
async function decideAction(userMessage, onStatus = () => { }) {
  const TOOLS = buildTools();

  let coreMemory = '';
  try {
    const cm = mainDocs.getCoreMemory();
    if (cm) coreMemory = `\n\n--- CORE MEMORY ---\n${cm}\n-------------------`;
  } catch (_) { }

  const messages = [
    { role: 'user', content: userMessage },
  ];

  let iterations = 0;

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++;
      logger.info(`[Main] Iteration ${iterations}/${MAX_ITERATIONS}`);
      onStatus(`🤔 Thinking... (Step ${iterations})`);

      const systemMsg = { role: 'system', content: SYSTEM_PROMPT + coreMemory };
      const data = await callOpenRouter([systemMsg, ...messages], TOOLS);
      const assistantMsg = data.choices[0].message;

      messages.push(assistantMsg);

      // No tool calls → plain conversational reply
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        const text = assistantMsg.content || "I wasn't sure what to do. Could you rephrase?";
        logger.info(`[Main] Conversational reply: ${text.slice(0, 80)}`);
        return { type: 'reply', text };
      }

      // Process each tool call
      for (const toolCall of assistantMsg.tool_calls) {
        const { name, arguments: argsJson } = toolCall.function;
        let args = {};
        try { args = JSON.parse(argsJson); } catch (_) { }

        logger.info(`[Main] Tool call: ${name} ${argsJson}`);

        // ── Routing tools: return immediately without adding tool result ──
        if (name === 'run_skill') {
          return {
            type: 'run',
            skill: args.skill,
            args: Array.isArray(args.args) ? args.args : [],
          };
        }

        if (name === 'ask_agent') {
          const agentMap = { legal: 'legal', medical: 'medical', finance: 'finance', coder: 'coder' };
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
        onStatus(`🛠️ Using tool: ${name}...`);
        const result = await executeLocalTool(name, args);
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
    return { type: 'error', text: `LLM error: ${err.message}` };
  }
}

module.exports = { decideAction, loadSkills, SKILLS, ALL_SKILLS };
