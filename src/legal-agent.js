'use strict';

/**
 * Legal Sub-Agent
 *
 * An AI attorney with expertise in:
 *  - Florida: criminal law, civil litigation, family law (Pinellas County)
 *  - Texas: Family Code §2.401 informal/common-law marriage, partition lawsuits
 *
 * Workflow:
 *  1. Retrieve top-K relevant chunks from the RAG index.
 *  2. Pass them as grounding context to Claude Sonnet.
 *  3. If web search is needed (tool call), query Brave Search API.
 *  4. Stream the final answer back via the provided callback.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');
const { ANTHROPIC_API_KEY, BRAVE_API_KEY } = require('./config');
const { indexDocuments, retrieve, indexStatus } = require('./rag-engine');
const logger = require('./logger');

const client = new Anthropic.default({ apiKey: ANTHROPIC_API_KEY });

const LEGAL_MODEL = 'claude-opus-4-7';
const MAX_ITERATIONS = 8;

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Legal, an experienced attorney with expertise in:

FLORIDA (Pinellas County focus):
• Criminal law — charges, defenses, plea negotiations, trial procedure
• Civil litigation — breach of contract, torts, small claims, injunctions
• Family law — divorce, child custody/support, alimony, domestic violence injunctions, parental rights

TEXAS:
• Texas Family Code §2.401 — informal (common-law) marriage: elements, proof, challenges, putative spouse doctrine
• Partition and exchange agreements — division of community property, enforceability, partition lawsuits

GUIDELINES:
• Cite the specific statute, rule, or document source when answering (e.g., "Per Florida Statute §61.08..." or "According to [filename]...").
• If the user's documents contain relevant facts, reference them explicitly.
• Ask clarifying questions when key facts are missing.
• If you must search the web, prioritize official sources: leg.state.fl.us, statutes.leg.state.tx.us, Pinellas County court records, Westlaw-style summaries.
• Be direct and precise — give actionable legal analysis, not generic disclaimers.
• Format long answers with headers and bullet points for readability in Telegram.`;

// ─── Brave Search Tool ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'web_search',
    description:
      'Search the web for legal statutes, case law, Florida/Texas court rules, or current legal news. ' +
      'Use this when the user\'s documents do not contain sufficient information to answer the question.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query. Be specific — include jurisdiction and statute numbers when relevant.',
        },
      },
      required: ['query'],
    },
  },
];

async function toolWebSearch({ query }) {
  if (!BRAVE_API_KEY) {
    return { error: 'BRAVE_API_KEY is not configured. Add it to .env to enable web search.' };
  }

  logger.info(`[Legal] Web search: ${query}`);

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
    });

    if (!res.ok) {
      return { error: `Brave API error: ${res.status} ${res.statusText}` };
    }

    const data = await res.json();
    const results = (data.web?.results || []).slice(0, 5).map(r => ({
      title: r.title,
      url: r.url,
      description: r.description || '',
    }));

    return { results };
  } catch (err) {
    logger.error(`[Legal] Brave Search error: ${err.message}`);
    return { error: err.message };
  }
}

// ─── Special Commands ─────────────────────────────────────────────────────────

/** True if the message is requesting a document index rebuild. */
function isReadCommand(msg) {
  return /\b(read|index|load|reload|scan)\b.*\bdoc/i.test(msg) ||
    /\bdoc.*\b(read|index|load|reload|scan)\b/i.test(msg);
}

/** True if the user is asking for index status. */
function isStatusCommand(msg) {
  return /\b(how many|status|what.*loaded|documents.*loaded|index.*status)\b/i.test(msg);
}

// ─── Streaming Agent Loop ────────────────────────────────────────────────────

/**
 * Run the Legal sub-agent for a given question.
 *
 * @param {string} question  The user's legal question.
 * @param {function} onChunk Callback called with each streamed text chunk (string).
 * @returns {Promise<{ answer: string, sources: string[] }>}
 */
async function runLegalAgent(question, onChunk = () => { }) {
  logger.info(`[Legal] Question: ${question}`);

  // ── Special commands ──────────────────────────────────────────────────────

  if (isStatusCommand(question)) {
    const status = indexStatus();
    onChunk(status);
    return { answer: status, sources: [] };
  }

  if (isReadCommand(question)) {
    onChunk('📂 Scanning and indexing documents...\n');
    const summary = await indexDocuments();
    onChunk(summary);
    return { answer: summary, sources: [] };
  }

  // ── RAG retrieval ─────────────────────────────────────────────────────────

  let ragContext = '';
  const sources = new Set();

  try {
    const chunks = await retrieve(question);
    if (chunks.length > 0) {
      const relevant = chunks.filter(c => c.score > 0.35); // relevance threshold
      if (relevant.length > 0) {
        ragContext = relevant
          .map((c, i) => `[Source: ${c.source} | Relevance: ${(c.score * 100).toFixed(0)}%]\n${c.text}`)
          .join('\n\n---\n\n');
        relevant.forEach(c => sources.add(c.source));
        logger.info(`[Legal] RAG: ${relevant.length} relevant chunks from: ${[...sources].join(', ')}`);
      }
    }
  } catch (err) {
    logger.warn(`[Legal] RAG retrieval failed: ${err.message}. Proceeding without document context.`);
  }

  // ── Build initial user message ────────────────────────────────────────────

  let userContent = question;
  if (ragContext) {
    userContent =
      `The user's question: ${question}\n\n` +
      `Relevant excerpts from the user's uploaded documents:\n\n${ragContext}\n\n` +
      `Use these excerpts to ground your answer. Cite the source filename when referencing them.`;
  }

  const messages = [{ role: 'user', content: userContent }];

  // ── Agentic loop with streaming ───────────────────────────────────────────

  let fullAnswer = '';
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    logger.info(`[Legal] Iteration ${iterations}/${MAX_ITERATIONS}`);

    // Use streaming for the final text turn; use non-streaming for tool-use turns.
    const toolUseBlocks = [];

    const stream = await client.messages.stream({
      model: LEGAL_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    let iterText = '';

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          const chunk = event.delta.text;
          iterText += chunk;
          fullAnswer += chunk;
          onChunk(chunk);
        }
      }
    }

    const finalMsg = await stream.finalMessage();

    // Collect any tool use blocks
    for (const block of finalMsg.content) {
      if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
      }
    }

    // Push assistant turn
    messages.push({ role: 'assistant', content: finalMsg.content });

    // If no tool calls, we're done
    if (toolUseBlocks.length === 0) {
      logger.info('[Legal] Agent finished (no more tool calls).');
      break;
    }

    // Execute tool calls
    const toolResults = [];
    for (const block of toolUseBlocks) {
      logger.info(`[Legal] Tool call: ${block.name} ${JSON.stringify(block.input)}`);
      let result;
      if (block.name === 'web_search') {
        result = await toolWebSearch(block.input);
        if (result.results) {
          result.results.forEach(r => sources.add(r.url));
        }
      } else {
        result = { error: `Unknown tool: ${block.name}` };
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  if (!fullAnswer) {
    fullAnswer = iterations >= MAX_ITERATIONS
      ? '⚠️ Legal agent reached the iteration limit. Try rephrasing your question.'
      : '⚠️ No answer generated.';
    onChunk(fullAnswer);
  }

  logger.info(`[Legal] Done. Sources: ${[...sources].join(', ') || 'none'}`);
  return { answer: fullAnswer, sources: [...sources] };
}

module.exports = { runLegalAgent };
