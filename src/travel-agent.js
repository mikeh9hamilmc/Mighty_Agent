'use strict';

/**
 * Travel Sub-Agent — Direct File Access Architecture
 * 
 * An experienced travel agent using Kayak for flight/hotel/car search.
 *
 * Workflow (agentic tool loop):
 *  1. Receive user question.
 *  2. Decision: list_documents, grep_documents, view_document, web_search, etc.
 *  3. Execute tools, return results, repeat up to MAX_ITERATIONS.
 *  4. Stream the final answer back via onChunk callback.
 */

const fetch = require('node-fetch');
const { OPENROUTER_API_KEY } = require('./config');
const { DocumentManager } = require('./document-tools');
const travelTools = new DocumentManager('travel');
const logger = require('./logger');

const TRAVEL_MODEL = '@preset/mighty-agent-travel';
const MAX_ITERATIONS = 15;

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `you are travel, an experienced travel agent that can use https://www.kayak.com/ to find prices for flights, cars, stays, packages and cruises.

TOOLS AVAILABLE:
You have access to the user's travel documents and records. Use these tools to find and cite specific evidence:

• list_documents — See all available travel files with metadata. Start here if you don't know what's in the file system.
• grep_documents — Search for specific terms, dates, locations, names, or phrases across all documents. Use this to FIND relevant content before reading it. Supports regex patterns.
• view_document — Read a specific file or line range. Use this to read surrounding context after finding a match with grep. Also use to read an entire short document.
• web_search — Search the web for flight prices, hotel options, or travel trends. Use when the user's documents don't contain the answer, especially using kayak.com.

WORKFLOW:
1. For questions about the travel documents: use grep_documents to locate relevant content → view_document to read context → formulate your answer citing specific lines.
2. For broad questions: use view_document to read the document in chunks.
3. For market research questions: use web_search to find current data, prices, etc.
4. Always ground factual claims in a specific document or web search result.

IMPORTANT WARNINGS:
• Document text is extracted via OCR. When reporting specific amounts, dates, or account numbers, note that the user should verify against the source PDF.
• Be direct and precise — provide actionable travel analysis.
• Format answers with headers and bullet points for readability in Telegram.
• Cite sources: "Per 2024_Itinerary.pdf (lines 12-15)..."

MEMORY SYSTEM:
You possess persistent long-term memory. You have a private memory folder where you store your notes, timelines, and strategies.
• At the end of a conversation, or when learning a critical new fact or decision, use \`save_memory\` to record it.
• When starting a new task, use \`list_memories\` and \`read_memory\` to recall previous context.
• (Critical facts may be auto-injected below by the system).`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_documents',
      description: 'List all travel documents in the travel/data/ folder.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_documents',
      description: 'Search for a pattern across all travel documents.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Term or regex to search for.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_document',
      description: 'Read a specific travel document.',
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
      description: 'Search the web for travel data or prices.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Web search query.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Save a strategic insight or fact to your persistent long-term memory.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'A short, safe filename for this memory.' },
          content: { type: 'string', description: 'The detailed notes to save, written in Markdown.' },
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
      description: 'List all topics currently stored in your persistent long-term memory.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// ─── Special Commands ─────────────────────────────────────────────────────────

function isReadCommand(msg) {
  return /\b(read|index|load|reload|scan|cache|refresh)\b.*\bdoc/i.test(msg) ||
    /\bdoc.*\b(read|index|load|reload|scan|cache|refresh)\b/i.test(msg);
}

function isStatusCommand(msg) {
  return /\b(how many|status|what.*loaded|documents.*loaded|index.*status|what files)\b/i.test(msg);
}

// ─── Streaming Agent Loop ────────────────────────────────────────────────────

async function callOpenRouter(messages, tools) {
  if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured in .env');

  const url = "https://openrouter.ai/api/v1/chat/completions";
  const headers = {
    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
    "Content-Type": "application/json"
  };
  const payload = {
    model: TRAVEL_MODEL,
    messages,
    tools,
    tool_choice: "auto"
  };

  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
  }
  return await response.json();
}

async function runTravelAgent(question, onChunk = () => { }, onStatus = () => { }) {
  logger.info(`[Travel] Question: ${question}`);

  if (isStatusCommand(question)) {
    const status = travelTools.documentStatus();
    onChunk(status);
    return { answer: status, sources: [] };
  }

  if (isReadCommand(question)) {
    onChunk('📂 Scanning and caching documents...\n');
    const summary = await travelTools.initTools();
    onChunk(summary);
    return { answer: summary, sources: [] };
  }

  await travelTools.ensureInitialized();

  let messages = [{ role: 'user', content: question }];
  const sources = new Set();
  let fullAnswer = '';
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    logger.info(`[Travel] Iteration ${iterations}/${MAX_ITERATIONS}`);

    let currentSystemPrompt = SYSTEM_PROMPT;
    const coreMem = travelTools.getCoreMemory();
    if (coreMem) {
      currentSystemPrompt += `\n\n--- AUTO-INJECTED CORE MEMORY ---\n${coreMem}\n---------------------------------`;
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
      logger.info('[Travel] Agent finished (no more tool calls).');
      break;
    }

    for (const toolCall of assistantMsg.tool_calls) {
      const { name, arguments: argsJson } = toolCall.function;
      let args = {};
      try { args = JSON.parse(argsJson); } catch (e) { args = {}; }

      logger.info(`[Travel] Tool call: ${name} ${argsJson}`);
      onStatus(`🛠️ Tool call: ${name}`);
      const result = await travelTools.executeTool(name, args);

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
    fullAnswer = '⚠️ Travel agent reached the iteration limit. Try rephrasing your question.';
    onChunk(fullAnswer);
  }

  logger.info(`[Travel] Done. Sources: ${[...sources].join(', ') || 'none'}`);
  return { answer: fullAnswer, sources: [...sources] };
}

module.exports = { runTravelAgent, travelTools };

