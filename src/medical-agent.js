'use strict';

/**
 * Medical Sub-Agent — Direct File Access Architecture
 *
 * An AI doctor and medical research assistant.
 *
 * Workflow (agentic tool loop):
 *  1. Receive user question.
 *  2. Claude decides which tools to call: list_documents, grep_documents,
 *     view_document, or web_search, create_document, etc.
 *  3. Execute tools, return results, repeat up to MAX_ITERATIONS.
 *  4. Stream the final answer back via onChunk callback.
 */

const fetch = require('node-fetch');
const { OPENROUTER_API_KEY } = require('./config');
const { DocumentManager } = require('./document-tools');
const medicalTools = new DocumentManager('medical');
const logger = require('./logger');

const MEDICAL_MODEL = '@preset/mighty-agent-medical';
const MAX_ITERATIONS = 15;

// ─── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are medical, an experienced doctor for the user and medical research assistant for the user.

TOOLS AVAILABLE:
You have access to the user's medical records and documents. Use these tools to find and cite specific evidence:

• grep_documents — Search for specific terms, dates, lab results, names, or phrases across all documents. THIS IS YOUR FIRST ACTION for any factual question. Supports regex patterns.
• view_document — Read a specific file or line range. Use this to read surrounding context after finding a match with grep, or to read an entire short document.
• list_documents — List all medical files with metadata. Use ONLY when the user explicitly asks "what files do you have" or "list my documents". Do NOT use this as your first step for factual questions.
• web_search — Search the web for medical conditions, studies, drug interactions, or treatments. Use when the user's documents don't contain the answer.

WORKFLOW & PRIORITY:
1. FOR FACTUAL QUESTIONS: Always start with \`grep_documents\` to search local files. Do NOT start with \`list_documents\`.
2. If \`grep_documents\` returns no relevant results, immediately use \`web_search\` to find the answer.
3. NEVER output raw tool results (file lists, metadata, line counts) to the user. Only output natural language answers.
4. Always ground factual claims in a specific document — cite the filename and line numbers.

IMPORTANT WARNINGS:
• Document text is extracted via OCR. When reporting specific lab values, dates, or dosages, note that the user should verify against the source PDF.
• Be direct and precise — give actionable medical analysis.
• Format answers with headers and bullet points for readability in Telegram.
• Cite sources: "Per Complete_Blood_Count_2025.pdf (lines 45-52)..."

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
      description:
        'List all medical documents in the medical/data/ folder with metadata: ' +
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
        'Search for a pattern (regex or literal string) across all medical documents. ' +
        'Returns matching lines with surrounding context. ' +
        'Use this to find specific dates, lab values, names, medical terms, or phrases. ' +
        'Examples: "April 2024", "glucose", "Dr. Smith".',
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
            description: 'Optional: only search files whose name contains this string (e.g. "lab" to search only lab results).',
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
            description: 'The filename to read (e.g. "Blood_Test_1-7.pdf"). Partial matches are supported.',
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
        'Search the web for medical conditions, treatments, drug interactions, or guidelines. ' +
        'Use this when the user\'s documents do not contain sufficient information to answer the question. ',
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
        'Create a new document file in the medical/data/ folder. ' +
        'Use this to draft letters, treatment plans, or any document the user needs. ' +
        'Always use .md (Markdown) format.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Filename for the new document (e.g. "Treatment_Plan.md"). Must end in .md or .txt.',
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
            description: 'The filename to edit (e.g. "Treatment_Plan.md"). Partial filename matches are supported.',
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
        'Convert a .md or .txt file in medical/data/ to a Microsoft Word .docx file using pandoc. ' +
        'The output file is saved in medical/data/ with the same base name but .docx extension. ' +
        'Always do this AFTER creating or finishing edits to a document, when the user requests a Word file.',
      parameters: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'The source .md or .txt filename to convert (e.g. "Treatment_Plan.md").',
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
            description: 'A short, safe filename for this memory (e.g., "allergies", "vaccine_timeline").',
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
            description: 'The topic/filename of the memory to read (e.g., "allergies").',
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

/** True if the message is requesting a document cache rebuild. */
function isReadCommand(msg) {
  return /\b(read|index|load|reload|scan|cache|refresh)\b.*\bdoc/i.test(msg) ||
    /\bdoc.*\b(read|index|load|reload|scan|cache|refresh)\b/i.test(msg);
}

/** True if the user is asking for document status. */
function isStatusCommand(msg) {
  return /\b(status|what.*loaded|documents.*loaded|index.*status|what files)\b/i.test(msg) ||
    /\bhow many\s+(documents|docs|files)\b/i.test(msg);
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
    model: MEDICAL_MODEL,
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
 * Run the Medical sub-agent for a given question.
 *
 * @param {string} question  The user's medical question.
 * @param {function} onChunk Callback called with each text chunk.
 * @param {function} onStatus Callback called with status updates.
 * @param {Array} history Conversation history.
 * @returns {Promise<{ answer: string, sources: string[] }>}
 */
async function runMedicalAgent(question, onChunk = () => { }, onStatus = () => { }, history = []) {
  logger.info(`[Medical] Question: ${question}`);

  // ── Special commands ──────────────────────────────────────────────────────

  if (isStatusCommand(question)) {
    const status = medicalTools.documentStatus();
    onChunk(status);
    return { answer: status, sources: [] };
  }

  if (isReadCommand(question)) {
    onChunk('📂 Scanning and caching documents...\n');
    const summary = await medicalTools.initTools();
    onChunk(summary);
    return { answer: summary, sources: [] };
  }

  // ── Ensure document cache is loaded ──────────────────────────────────────
  await medicalTools.ensureInitialized();

  // ── Agentic tool-calling loop ─────────────────────────────────────────────

  let messages = [
    ...history,
    { role: 'user', content: question }
  ];
  const sources = new Set();
  let fullAnswer = '';
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    logger.info(`[Medical] Iteration ${iterations}/${MAX_ITERATIONS}`);

    // Auto-inject core memory into the system prompt
    let currentSystemPrompt = SYSTEM_PROMPT;
    const coreMem = medicalTools.getCoreMemory();
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

    // Add assistant turn to history
    messages.push(assistantMsg);

    if (assistantMsg.content) {
      onChunk(assistantMsg.content);
      fullAnswer += assistantMsg.content;
    }

    // If no tool calls, the agent is done
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      logger.info('[Medical] Agent finished (no more tool calls).');
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

      logger.info(`[Medical] Tool call: ${name} ${argsJson}`);
      onStatus(`🛠️ Tool call: ${name}`);
      const result = await medicalTools.executeTool(name, args);

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
    fullAnswer = '⚠️ Medical agent reached the iteration limit. Try rephrasing your question.';
    onChunk(fullAnswer);
  }

  logger.info(`[Medical] Done. Sources: ${[...sources].join(', ') || 'none'}`);
  return { answer: fullAnswer, sources: [...sources] };
}

module.exports = { runMedicalAgent, medicalTools };

