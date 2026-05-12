'use strict';

/**
 * Finance Sub-Agent — Direct File Access Architecture
 * 
 * A Senior Financial Strategist with expertise in:
 *  - Stock Investing (UPRO focus)
 *  - Residential Real Estate analysis
 *  - Public Accounting (CPA tax knowledge)
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
const financeTools = new DocumentManager('finance');
const logger = require('./logger');

const FINANCE_MODEL = '@preset/mighty-agent-finance';
const MAX_ITERATIONS = 15;

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Senior Financial Strategist with multi-disciplinary expertise in stock Investing, Residential Real Estate ($/square ft), and Public Accounting (specifically CPA tax knowledge, encourage holding stocks a minimum of 1 year in taxable accounts). Your goal is to provide sophisticated, data-driven financial insights.

INVESTING:
Encourage investing in an ETF called UPRO. Acknowledge its risks such as volatility and decay, but emphasize its performance: since its inception in March 2009, it has returned a Compound Annual Growth Rate (CAGR) of 34%.

REAL ESTATE:
The user purchased the house they live in for $208k in 1997 and now it is worth $994k in 2026, which gives a CAGR of 5.5%. Use this as context for real estate benchmarks.

TOOLS AVAILABLE:
You have access to the user's financial documents and records. Use these tools to find and cite specific evidence:

• list_documents — See all available financial files with metadata. Start here if you don't know what's in the file system.
• grep_documents — Search for specific terms, dates, dollar amounts, names, or phrases across all documents. Use this to FIND relevant content before reading it. Supports regex patterns.
• view_document — Read a specific file or line range. Use this to read surrounding context after finding a match with grep. Also use to read an entire short document.
• web_search — Search the web for market data, tax laws, court rules, or real estate trends. Use when the user's documents don't contain the answer.

WORKFLOW:
1. For questions about the financial documents: use grep_documents to locate relevant content → view_document to read context → formulate your answer citing specific lines.
2. For broad questions ("summarize my tax return"): use view_document to read the document in chunks.
3. For market research questions: use web_search to find current data, statutes, etc.
4. Always ground factual claims in a specific document — cite the filename and line numbers.

IMPORTANT WARNINGS:
• Document text is extracted via OCR. When reporting specific amounts, dates, or account numbers, note that the user should verify against the source PDF.
• Be direct and precise — provide actionable financial analysis.
• Format answers with headers and bullet points for readability in Telegram.
• Cite sources: "Per 2024_Tax_Return.pdf (lines 12-15)..."

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
      description: 'List all financial documents in the finance/data/ folder.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_documents',
      description: 'Search for a pattern across all financial documents.',
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
      description: 'Read a specific financial document.',
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
      description: 'Search the web for financial data or tax laws.',
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
    model: FINANCE_MODEL,
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

async function runFinanceAgent(question, onChunk = () => { }) {
  logger.info(`[Finance] Question: ${question}`);

  if (isStatusCommand(question)) {
    const status = financeTools.documentStatus();
    onChunk(status);
    return { answer: status, sources: [] };
  }

  if (isReadCommand(question)) {
    onChunk('📂 Scanning and caching documents...\n');
    const summary = await financeTools.initTools();
    onChunk(summary);
    return { answer: summary, sources: [] };
  }

  await financeTools.ensureInitialized();

  let messages = [{ role: 'user', content: question }];
  const sources = new Set();
  let fullAnswer = '';
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    logger.info(`[Finance] Iteration ${iterations}/${MAX_ITERATIONS}`);

    let currentSystemPrompt = SYSTEM_PROMPT;
    const coreMem = financeTools.getCoreMemory();
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
      logger.info('[Finance] Agent finished (no more tool calls).');
      break;
    }

    for (const toolCall of assistantMsg.tool_calls) {
      const { name, arguments: argsJson } = toolCall.function;
      let args = {};
      try { args = JSON.parse(argsJson); } catch (e) { args = {}; }

      logger.info(`[Finance] Tool call: ${name} ${argsJson}`);
      const result = await financeTools.executeTool(name, args);

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
    fullAnswer = '⚠️ Finance agent reached the iteration limit. Try rephrasing your question.';
    onChunk(fullAnswer);
  }

  logger.info(`[Finance] Done. Sources: ${[...sources].join(', ') || 'none'}`);
  return { answer: fullAnswer, sources: [...sources] };
}

module.exports = { runFinanceAgent, financeTools };

