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

const fetch = require('node-fetch');
const { OPENROUTER_API_KEY } = require('./config');
const { DocumentManager } = require('./document-tools');
const legalTools = new DocumentManager('legal');
const logger = require('./logger');

const LEGAL_MODEL = '@preset/mighty-agent-legal';
const MAX_ITERATIONS = 15;

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Legal, an experienced attorney for Michael Hamilton and legal research assistant for the active case:

  Hamilton v. Le — Manatee County partition action (Case No. 25-CA-000347)

Michael Hamilton is the plaintiff in this case. Your job is to find evidence that there is no Texas common law marriage between Michael and Jenne.

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
• Cite sources: "Per Case Summary_1-7.pdf (lines 45-52)..." or "Per Florida Statute §61.08..."

MEMORY SYSTEM:
You possess persistent long-term memory. You have a private memory folder where you store your notes, case timelines, and strategies.
• At the end of a conversation, or when learning a critical new fact or decision, use \`save_memory\` to record it.
• When starting a new task, use \`list_memories\` and \`read_memory\` to recall previous context.
• (Critical facts may be auto-injected below by the system).`;

// ─── Tool Definitions (Anthropic schema) ──────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_documents',
      description:
        'List all case documents in the legal/data/ folder with metadata: ' +
        'filename, file size, line count, page count (PDF), and document type guess. ' +
        'Use this first to see what documents are available.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_documents',
      description:
        'Search for a pattern (regex or literal string) across all case documents. ' +
        'Returns matching lines with surrounding context. ' +
        'Use this to find specific dates, dollar amounts, names, legal terms, or phrases. ' +
        'Examples: "April 2024", "$516,651", "Judge Whyte", "partition".',
      parameters: {
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
  },
  {
    type: 'function',
    function: {
      name: 'view_document',
      description:
        'Read a specific document or a range of lines from it. ' +
        'If no range is specified: returns the entire file if under 2000 lines, ' +
        'otherwise returns the first 200 lines with a note about total length. ' +
        'Use start_line/end_line to view specific sections.',
      parameters: {
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
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for legal statutes, case law, Florida/Texas court rules, or current legal news. ' +
        'Use this when the client\'s documents do not contain sufficient information to answer the question. ' +
        'Be specific — include jurisdiction and statute numbers when relevant.',
      parameters: {
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
  },
  {
    type: 'function',
    function: {
      name: 'create_document',
      description:
        'Create a new document file in the legal/data/ folder. ' +
        'Use this to draft legal motions, declarations, letters, or any document the client needs. ' +
        'Always use .md (Markdown) format — it preserves headers, bold text, bullets, and numbered lists, ' +
        'and can be converted to Word with convert_to_word. ' +
        'Write the FULL document content in one call. ' +
        'Example filenames: "Motion_Declaratory_Judgment.md", "Affidavit_Hamilton.md".',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Filename for the new document (e.g. "Motion_Strike_Marriage_Claim.md"). Must end in .md or .txt.',
          },
          content: {
            type: 'string',
            description: 'Full content of the document, written in Markdown. Include proper legal formatting: case caption, title, numbered sections, signature block.',
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
      name: 'edit_document',
      description:
        'Replace a specific range of lines in an existing .md or .txt document. ' +
        'Use view_document first to see line numbers, then call this to replace the target lines. ' +
        'The new_content replaces everything from start_line through end_line (inclusive).',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'The filename to edit (e.g. "Motion_Strike.md"). Partial filename matches are supported.',
          },
          start_line: {
            type: 'integer',
            description: '1-indexed line number where the replacement starts.',
          },
          end_line: {
            type: 'integer',
            description: '1-indexed line number where the replacement ends (inclusive).',
          },
          new_content: {
            type: 'string',
            description: 'Replacement text for the specified line range. Can be multiple lines.',
          },
        },
        required: ['filename', 'start_line', 'end_line', 'new_content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'convert_to_word',
      description:
        'Convert a .md or .txt file in legal/data/ to a Microsoft Word .docx file using pandoc. ' +
        'The output file is saved in legal/data/ with the same base name but .docx extension. ' +
        'Always do this AFTER creating or finishing edits to a document, when the user requests a Word file.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'The source .md or .txt filename to convert (e.g. "Motion_Strike.md").',
          },
        },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description:
        'Save important facts, decisions, or summaries to your persistent long-term memory. ' +
        'Use this at the end of a conversation or when you learn something you need to remember for future chats.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'A short, safe filename for this memory (e.g., "case_strategy", "jenne_timeline").',
          },
          content: {
            type: 'string',
            description: 'The detailed notes to save, written in Markdown.',
          },
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
          topic: {
            type: 'string',
            description: 'The topic/filename of the memory to read (e.g., "case_strategy").',
          },
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
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
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
    model: LEGAL_MODEL,
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
 * Run the Legal sub-agent for a given question.
 *
 * @param {string} question  The user's legal question.
 * @param {function} onChunk Callback called with each text chunk.
 * @returns {Promise<{ answer: string, sources: string[] }>}
 */
async function runLegalAgent(question, onChunk = () => { }) {
  logger.info(`[Legal] Question: ${question}`);

  // ── Special commands ──────────────────────────────────────────────────────

  if (isStatusCommand(question)) {
    const status = legalTools.documentStatus();
    onChunk(status);
    return { answer: status, sources: [] };
  }

  if (isReadCommand(question)) {
    onChunk('📂 Scanning and caching documents...\n');
    const summary = await legalTools.initTools();
    onChunk(summary);
    return { answer: summary, sources: [] };
  }

  // ── Ensure document cache is loaded ──────────────────────────────────────
  await legalTools.ensureInitialized();

  // ── Agentic tool-calling loop ─────────────────────────────────────────────

  let messages = [{ role: 'user', content: question }];
  const sources = new Set();
  let fullAnswer = '';
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    logger.info(`[Legal] Iteration ${iterations}/${MAX_ITERATIONS}`);

    // Auto-inject core memory into the system prompt
    let currentSystemPrompt = SYSTEM_PROMPT;
    const coreMem = legalTools.getCoreMemory();
    if (coreMem) {
      currentSystemPrompt += `\n\n--- AUTO-INJECTED CORE MEMORY ---\n${coreMem}\n---------------------------------`;
    }

    const systemMsg = { role: 'system', content: currentSystemPrompt };
    const conversation = [systemMsg, ...messages];

    const data = await callOpenRouter(conversation, TOOLS);
    const assistantMsg = data.choices[0].message;

    // Add assistant turn to history
    messages.push(assistantMsg);

    if (assistantMsg.content) {
      onChunk(assistantMsg.content);
      fullAnswer += assistantMsg.content;
    }

    // If no tool calls, the agent is done
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      logger.info('[Legal] Agent finished (no more tool calls).');
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

      logger.info(`[Legal] Tool call: ${name} ${argsJson}`);
      const result = await legalTools.executeTool(name, args);

      // Track sources from document tools
      if (name === 'view_document' && result.filename) {
        sources.add(result.filename);
      }
      if (name === 'grep_documents' && result.matches) {
        result.matches.forEach(m => sources.add(m.file));
      }
      if (name === 'web_search' && result.results) {
        result.results.forEach(r => sources.add(r.url));
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: name,
        content: JSON.stringify(result),
      });
    }
  }

  if (!fullAnswer && iterations >= MAX_ITERATIONS) {
    fullAnswer = '⚠️ Legal agent reached the iteration limit. Try rephrasing your question.';
    onChunk(fullAnswer);
  }

  logger.info(`[Legal] Done. Sources: ${[...sources].join(', ') || 'none'}`);
  return { answer: fullAnswer, sources: [...sources] };
}

module.exports = { runLegalAgent };
