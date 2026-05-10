'use strict';

/**
 * Legal Sub-Agent — Direct File Access Architecture
 *
 * An AI attorney with expertise in:
 *  - Florida: criminal law, civil litigation, family law (Pinellas County)
 *  - Texas: Family Code §2.401 informal/common-law marriage, partition lawsuits
 *
 * Workflow (agentic tool loop):
 *  1. Receive user question.
 *  2. Claude decides which tools to call: list_documents, grep_documents,
 *     view_document, or web_search.
 *  3. Execute tools, return results, repeat up to MAX_ITERATIONS.
 *  4. Stream the final answer back via onChunk callback.
 *
 * All iterations use streaming for debugging visibility.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { ANTHROPIC_API_KEY } = require('./config');
const { initLegalTools, executeTool, documentStatus } = require('./legal-tools');
const logger = require('./logger');

const client = new Anthropic.default({ apiKey: ANTHROPIC_API_KEY });

const LEGAL_MODEL = 'claude-opus-4-7';
const MAX_ITERATIONS = 15;

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Legal, an experienced attorney and legal research assistant for the active case:

  Hamilton v. Le — Manatee County partition action (Case No. 25-CA-000347)

Your expertise includes:

FLORIDA (Pinellas County / Manatee County):
• Criminal law — charges, defenses, plea negotiations, trial procedure
• Civil litigation — breach of contract, torts, small claims, injunctions, partition actions (Fla. Stat. Ch. 64)
• Family law — divorce, child custody/support, alimony, domestic violence injunctions, parental rights

TEXAS:
• Texas Family Code §2.401 — informal (common-law) marriage: elements, proof, challenges, putative spouse doctrine, 2-year separation presumption under §2.401(b)
• Partition and exchange agreements — division of community property, enforceability, partition lawsuits

TOOLS AVAILABLE:
You have access to the client's case documents. Use these tools to find and cite specific evidence:

• list_documents — See all available case files with metadata. Start here if you don't know what's in the file system.
• grep_documents — Search for specific terms, dates, dollar amounts, names, or phrases across all documents. Use this to FIND relevant content before reading it. Supports regex patterns.
• view_document — Read a specific file or line range. Use this to read surrounding context after finding a match with grep. Also use to read an entire short document.
• web_search — Search the web for statutes, case law, court rules, or legal news. Use when the client's documents don't contain the answer (e.g., statutory research, case law lookup).

WORKFLOW:
1. For questions about the case documents: use grep_documents to locate relevant content → view_document to read context → formulate your answer citing specific lines.
2. For broad questions ("summarize this document"): use view_document to read the document in chunks.
3. For legal research questions: use web_search to find statutes, case law, etc.
4. Always ground factual claims in a specific document — cite the filename and line numbers.

IMPORTANT WARNINGS:
• Document text is extracted via OCR. When reporting specific dollar amounts, dates, or case numbers that will be used in legal filings, note that the user should verify against the source PDF.
• Be direct and precise — give actionable legal analysis.
• Format answers with headers and bullet points for readability in Telegram.
• Cite sources: "Per Case Summary_1-7.pdf (lines 45-52)..." or "Per Florida Statute §61.08..."`;

// ─── Tool Definitions (Anthropic schema) ──────────────────────────────────────

const TOOLS = [
  {
    name: 'list_documents',
    description:
      'List all case documents in the legal/data/ folder with metadata: ' +
      'filename, file size, line count, page count (PDF), and document type guess. ' +
      'Use this first to see what documents are available.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'grep_documents',
    description:
      'Search for a pattern (regex or literal string) across all case documents. ' +
      'Returns matching lines with surrounding context. ' +
      'Use this to find specific dates, dollar amounts, names, legal terms, or phrases. ' +
      'Examples: "April 2024", "$516,651", "Judge Whyte", "partition".',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The search pattern (regex or literal string).',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Whether the search is case-sensitive. Default: false.',
        },
        context_lines: {
          type: 'integer',
          description: 'Number of context lines to show above/below each match. Default: 3.',
        },
        file_filter: {
          type: 'string',
          description: 'Optional: only search files whose name contains this string (e.g. "statement" to search only bank statements).',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'view_document',
    description:
      'Read a specific document or a range of lines from it. ' +
      'If no range is specified: returns the entire file if under 2000 lines, ' +
      'otherwise returns the first 200 lines with a note about total length. ' +
      'Use start_line/end_line to view specific sections.',
    input_schema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'The filename to read (e.g. "Case Summary_1-7.pdf"). Partial matches are supported.',
        },
        start_line: {
          type: 'integer',
          description: 'Start line number (1-indexed). Optional.',
        },
        end_line: {
          type: 'integer',
          description: 'End line number (1-indexed). Optional.',
        },
      },
      required: ['filename'],
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web for legal statutes, case law, Florida/Texas court rules, or current legal news. ' +
      'Use this when the client\'s documents do not contain sufficient information to answer the question. ' +
      'Be specific — include jurisdiction and statute numbers when relevant.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query.',
        },
      },
      required: ['query'],
    },
  },
];

// ─── Special Commands ─────────────────────────────────────────────────────────

/** True if the message is requesting a document cache rebuild. */
function isReadCommand(msg) {
  return /\b(read|index|load|reload|scan|cache|refresh)\b.*\bdoc/i.test(msg) ||
    /\bdoc.*\b(read|index|load|reload|scan|cache|refresh)\b/i.test(msg);
}

/** True if the user is asking for document status. */
function isStatusCommand(msg) {
  return /\b(how many|status|what.*loaded|documents.*loaded|index.*status|what files)\b/i.test(msg);
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
    const status = documentStatus();
    onChunk(status);
    return { answer: status, sources: [] };
  }

  if (isReadCommand(question)) {
    onChunk('📂 Scanning and caching documents...\n');
    const summary = await initLegalTools();
    onChunk(summary);
    return { answer: summary, sources: [] };
  }

  // ── Agentic tool-calling loop ─────────────────────────────────────────────

  const messages = [{ role: 'user', content: question }];
  const sources = new Set();
  let fullAnswer = '';
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    logger.info(`[Legal] Iteration ${iterations}/${MAX_ITERATIONS}`);

    // Stream ALL turns for debugging visibility
    const stream = await client.messages.stream({
      model: LEGAL_MODEL,
      max_tokens: 8192,
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

    // Collect tool-use blocks
    const toolUseBlocks = finalMsg.content.filter(b => b.type === 'tool_use');

    // Push assistant turn
    messages.push({ role: 'assistant', content: finalMsg.content });

    // If no tool calls, the agent is done
    if (toolUseBlocks.length === 0) {
      logger.info('[Legal] Agent finished (no more tool calls).');
      break;
    }

    // Execute tool calls
    const toolResults = [];
    for (const block of toolUseBlocks) {
      logger.info(`[Legal] Tool call: ${block.name} ${JSON.stringify(block.input)}`);

      const result = await executeTool(block.name, block.input);

      // Track sources from document tools
      if (block.name === 'view_document' && result.filename) {
        sources.add(result.filename);
      }
      if (block.name === 'grep_documents' && result.matches) {
        result.matches.forEach(m => sources.add(m.file));
      }
      if (block.name === 'web_search' && result.results) {
        result.results.forEach(r => sources.add(r.url));
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
