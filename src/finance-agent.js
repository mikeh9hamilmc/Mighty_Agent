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

• grep_documents — Search for specific terms, dates, dollar amounts, names, or phrases across all documents. THIS IS YOUR FIRST ACTION for any factual question. Supports regex patterns.
• view_document — Read a specific file or line range. Use this to read surrounding context after finding a match with grep, or to read an entire short document.
• list_documents — List all financial files with metadata. Use ONLY when the user explicitly asks "what files do you have" or "list my documents". Do NOT use this as your first step for factual questions.
• web_search — Search the web for market data, tax laws, court rules, or real estate trends. Use when the user's documents don't contain the answer.
• create_document — Write research, notes, or information to a .md file in the finance/data/ folder.

WORKFLOW & PRIORITY:
1. FOR FACTUAL QUESTIONS: Always start with \`grep_documents\` to search local files. Do NOT start with \`list_documents\`.
2. If \`grep_documents\` returns no relevant results, immediately use \`web_search\` to find the answer.
3. NEVER output raw tool results (file lists, metadata, line counts) to the user. Only output natural language answers.
4. Always ground factual claims in a specific document — cite the filename and line numbers.
5. When asked to "write to a file" or "draft a document": use create_document.

IMPORTANT — create_document vs save_memory:
• create_document → saves to finance/data/ → QUERYABLE by the user and document tools. Use for research reports, summaries, notes, or when asked to "create a file with information" or "store information in the documents/records". (When replying to the user, say "I noted that in your records")
• save_memory → saves to finance/memory/ → private agent notes only, NOT queryable by the user. Use for brief personal strategy notes between sessions or when the user explicitly says "remember something". (When replying to the user, say "I noted that in my memory". DO NOT use the words "records" or "documents")

IMPORTANT WARNINGS:
• Document text is extracted via OCR. When reporting specific amounts, dates, or account numbers, note that the user should verify against the source PDF.
• Be direct and precise — provide actionable financial analysis.
• Format answers with headers and bullet points for readability in Telegram.
• Cite sources: "Per 2024_Tax_Return.pdf (lines 12-15)..."

MEMORY SYSTEM:
You possess persistent long-term memory. You have a private memory folder where you store your notes, timelines, and strategies.
• At the end of a conversation, or when learning a critical new fact or decision, use \`save_memory\` to record it.
• When the user explicitly asks you to "remember" a fact or "make a note" of something, you MUST call save_memory FIRST before replying. Never just say "I'll remember that" without calling the tool.
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
      name: 'create_document',
      description:
        'Create a new document file in the finance/data/ folder. ' +
        'Use this to write research, notes, or financial information. ' +
        'Always use .md (Markdown) format.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Filename for the new document (e.g. "Tax_Summary_2025.md"). Must end in .md or .txt.',
          },
          content: {
            type: 'string',
            description: 'Full content of the document, written in Markdown.',
          },
          overwrite: {
            type: 'boolean',
            description: 'Set to true to overwrite an existing file with the same name. Default: false.',
          },
        },
        required: ['filename', 'content'],
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
];

// ─── Special Commands ─────────────────────────────────────────────────────────

function isReadCommand(msg) {
  return /\b(read|index|load|reload|scan|cache|refresh)\b.*\bdoc/i.test(msg) ||
    /\bdoc.*\b(read|index|load|reload|scan|cache|refresh)\b/i.test(msg);
}

function isStatusCommand(msg) {
  return /\b(status|what.*loaded|documents.*loaded|index.*status|what files)\b/i.test(msg) ||
    /\bhow many\s+(documents|docs|files)\b/i.test(msg);
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

async function runFinanceAgent(question, onChunk = () => { }, onStatus = () => { }, history = []) {
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

  let messages = [
    ...history,
    { role: 'user', content: question }
  ];
  const sources = new Set();
  let fullAnswer = '';
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    logger.info(`[Finance] Iteration ${iterations}/${MAX_ITERATIONS}`);

    let currentSystemPrompt = SYSTEM_PROMPT;
    const coreMem = financeTools.getCoreMemory();
    if (coreMem) {
      currentSystemPrompt += '\n\n--- AUTO-INJECTED CORE MEMORY ---\n' + coreMem + '\n---------------------------------';
      sources.add('Core Memory');
    }
    if (history.length > 0) sources.add('Session Conversation');

    const systemMsg = { role: 'system', content: currentSystemPrompt };
    const conversation = [systemMsg, ...messages];

    const data = await callOpenRouter(conversation, TOOLS);
    if (!data.choices || data.choices.length === 0) {
      const errorMsg = data.error?.message || 'AI returned an empty response.';
      throw new Error(errorMsg);
    }
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
      onStatus(`🛠️ Tool call: ${name}`);
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

