'use strict';

/**
 * Legal Tools — Direct file access for the Legal sub-agent.
 *
 * Provides four tools:
 *   list_documents  — list files in legal/data/ with metadata
 *   grep_documents  — regex search across all document text
 *   view_document   — read a file or line range
 *   web_search      — Brave Search API fallback
 *
 * Text extraction:
 *   - PDF: pdftotext -layout (from poppler-utils) → cached to .legal-cache/
 *   - DOCX: mammoth
 *   - XLSX: xlsx
 *   - TXT/MD: fs.readFileSync
 *
 * Cache invalidation: mtime comparison (re-extract only if source is newer).
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fetch = require('node-fetch');
const { LEGAL_DATA_DIR, LEGAL_CACHE_DIR, BRAVE_API_KEY } = require('./config');
const logger = require('./logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_EXTS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.txt', '.md']);
const EXCLUDED_FILES = new Set(['readme.md']);

// ─── In-memory document index ─────────────────────────────────────────────────
// Built on init, refreshed on demand.
// Map<filename, { filename, filePath, cachePath, pageCount, lineCount, fileSize, mtime, docTypeGuess }>

let _docIndex = new Map();

// ─── Doc type guessing ────────────────────────────────────────────────────────

function guessDocType(filename) {
  const lower = filename.toLowerCase();
  if (/case|summary/.test(lower))             return 'case_summary';
  if (/statement|bank/.test(lower))           return 'bank_statement';
  if (/trust/.test(lower))                    return 'trust_document';
  if (/lease/.test(lower))                    return 'lease';
  if (/letter|email|correspondence/.test(lower)) return 'correspondence';
  if (/alta|settlement|closing/.test(lower))  return 'closing_document';
  if (/deed|title/.test(lower))               return 'deed';
  if (/motion|petition|order|filing/.test(lower)) return 'court_filing';
  return 'unknown';
}

// ─── Text extraction ──────────────────────────────────────────────────────────

/**
 * Count pages in a PDF by counting form-feed characters in pdftotext output.
 * Each page boundary produces a form-feed (\f).
 */
function countPdfPages(text) {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\f') count++;
  }
  return count;
}

/**
 * Extract text from a PDF using pdftotext -layout.
 * Returns the raw text string.
 */
function extractPdfText(filePath) {
  try {
    const stdout = execFileSync('pdftotext', ['-layout', filePath, '-'], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024, // 50 MB
      timeout: 60_000,
    });
    return stdout;
  } catch (err) {
    // If pdftotext is not installed, give a clear error
    if (err.code === 'ENOENT') {
      throw new Error(
        'pdftotext not found. Install poppler-utils: sudo apt-get install poppler-utils'
      );
    }
    throw err;
  }
}

/**
 * Extract text from a DOCX file using mammoth.
 */
async function extractDocxText(filePath) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

/**
 * Extract text from an XLSX file using xlsx.
 */
function extractXlsxText(filePath) {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath);
  return wb.SheetNames
    .map(name => {
      const ws = wb.Sheets[name];
      return `[Sheet: ${name}]\n` + XLSX.utils.sheet_to_csv(ws);
    })
    .join('\n\n');
}

/**
 * Extract text from any supported file.
 * Returns the text string, or null if unsupported.
 */
async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf')                     return extractPdfText(filePath);
  if (ext === '.docx' || ext === '.doc')  return await extractDocxText(filePath);
  if (ext === '.xlsx' || ext === '.xls')  return extractXlsxText(filePath);
  if (ext === '.txt'  || ext === '.md')   return fs.readFileSync(filePath, 'utf-8');

  return null;
}

// ─── Cache management ─────────────────────────────────────────────────────────

/**
 * Get the cache file path for a given source file.
 */
function cachePath(filename) {
  const base = path.parse(filename).name;
  return path.join(LEGAL_CACHE_DIR, `${base}.txt`);
}

/**
 * Check if the cache is fresh (source mtime <= cache mtime).
 */
function isCacheFresh(sourceFile, cacheFile) {
  if (!fs.existsSync(cacheFile)) return false;
  const srcMtime   = fs.statSync(sourceFile).mtimeMs;
  const cacheMtime = fs.statSync(cacheFile).mtimeMs;
  return cacheMtime >= srcMtime;
}

/**
 * Get the cached text for a file. If the file is a plain text file,
 * reads it directly. Otherwise reads from the cache directory.
 */
function getCachedText(filename) {
  const entry = _docIndex.get(filename);
  if (!entry) return null;

  const ext = path.extname(filename).toLowerCase();

  // Plain text files are read directly — no cache needed
  if (ext === '.txt' || ext === '.md') {
    return fs.readFileSync(entry.filePath, 'utf-8');
  }

  // All other types use cached text files
  if (!fs.existsSync(entry.cachePath)) return null;
  return fs.readFileSync(entry.cachePath, 'utf-8');
}

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Scan legal/data/, extract text from new/changed files, build the index.
 * Call at startup and on "read documents" command.
 * Returns a summary string suitable for sending to the user.
 */
async function initLegalTools() {
  // Ensure directories exist
  if (!fs.existsSync(LEGAL_DATA_DIR)) {
    fs.mkdirSync(LEGAL_DATA_DIR, { recursive: true });
  }
  fs.mkdirSync(LEGAL_CACHE_DIR, { recursive: true });

  const files = fs.readdirSync(LEGAL_DATA_DIR).filter(f => {
    const ext  = path.extname(f).toLowerCase();
    const base = f.toLowerCase();
    return SUPPORTED_EXTS.has(ext) && !EXCLUDED_FILES.has(base) && !f.startsWith('.');
  });

  if (files.length === 0) {
    logger.info('[Legal Tools] No documents found in legal/data/.');
    _docIndex = new Map();
    return '📂 No supported documents found in legal/data/. Supported: PDF, DOCX, XLSX, TXT, MD.';
  }

  let extracted = 0, cached = 0, failed = 0;
  const newIndex = new Map();

  for (const filename of files) {
    const filePath  = path.join(LEGAL_DATA_DIR, filename);
    const cacheFile = cachePath(filename);
    const ext       = path.extname(filename).toLowerCase();
    const stat      = fs.statSync(filePath);
    const needsCache = ext !== '.txt' && ext !== '.md';

    try {
      let text;
      if (needsCache && isCacheFresh(filePath, cacheFile)) {
        // Cache is fresh — read from cache
        text = fs.readFileSync(cacheFile, 'utf-8');
        cached++;
        logger.info(`[Legal Tools] Cached: ${filename}`);
      } else {
        // Extract text
        logger.info(`[Legal Tools] Extracting: ${filename}`);
        text = await extractText(filePath);
        if (!text || text.trim().length < 10) {
          logger.warn(`[Legal Tools] Skipping (empty/unreadable): ${filename}`);
          failed++;
          continue;
        }
        // Write to cache (skip for plain text files)
        if (needsCache) {
          fs.writeFileSync(cacheFile, text, 'utf-8');
        }
        extracted++;
      }

      const lines     = text.split('\n');
      const pageCount = ext === '.pdf' ? countPdfPages(text) : null;

      newIndex.set(filename, {
        filename,
        filePath,
        cachePath: needsCache ? cacheFile : filePath,
        pageCount,
        lineCount: lines.length,
        fileSize:  stat.size,
        mtime:     stat.mtimeMs,
        docTypeGuess: guessDocType(filename),
      });
    } catch (err) {
      logger.error(`[Legal Tools] Failed to process ${filename}: ${err.message}`);
      failed++;
    }
  }

  _docIndex = newIndex;

  const summary = [
    '✅ Document cache updated.',
    `📄 Files: ${_docIndex.size} (${extracted} extracted, ${cached} cached, ${failed} failed)`,
  ];
  const details = [..._docIndex.values()].map(d => {
    const pg = d.pageCount ? ` (${d.pageCount} pages)` : '';
    return `  • \`${d.filename}\`${pg} — ${d.lineCount} lines, ${(d.fileSize / 1024).toFixed(0)} KB [${d.docTypeGuess}]`;
  });
  if (details.length > 0) summary.push('\n' + details.join('\n'));

  logger.info(`[Legal Tools] Index built: ${_docIndex.size} file(s).`);
  return summary.join('\n');
}

// ─── Tool Implementations ─────────────────────────────────────────────────────

/**
 * list_documents — List all files in legal/data/ with metadata.
 */
function toolListDocuments() {
  if (_docIndex.size === 0) {
    return { files: [], message: 'No documents indexed. Run "ask legal read documents" first.' };
  }

  const files = [..._docIndex.values()].map(d => ({
    filename:     d.filename,
    file_size_kb: Math.round(d.fileSize / 1024),
    line_count:   d.lineCount,
    page_count:   d.pageCount,
    doc_type:     d.docTypeGuess,
  }));

  return { files, total: files.length };
}

/**
 * grep_documents — Search across all document text.
 *
 * @param {object} input
 * @param {string} input.pattern — regex or literal string to search for
 * @param {boolean} [input.case_sensitive=false]
 * @param {number} [input.context_lines=3]
 * @param {string} [input.file_filter] — glob-like filter (e.g. "statement" matches filenames containing "statement")
 */
function toolGrepDocuments({ pattern, case_sensitive = false, context_lines = 3, file_filter }) {
  const flags = case_sensitive ? 'g' : 'gi';
  let regex;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    // If the pattern is not valid regex, escape it and treat as literal
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, flags);
  }

  const results = [];
  const MAX_MATCHES = 50;
  let totalMatches = 0;

  for (const [filename, entry] of _docIndex) {
    // Apply file filter
    if (file_filter && !filename.toLowerCase().includes(file_filter.toLowerCase())) {
      continue;
    }

    const text = getCachedText(filename);
    if (!text) continue;

    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (totalMatches >= MAX_MATCHES) break;

      if (regex.test(lines[i])) {
        regex.lastIndex = 0; // reset for next test

        const start = Math.max(0, i - context_lines);
        const end   = Math.min(lines.length - 1, i + context_lines);
        const context = lines.slice(start, end + 1).map((line, idx) => {
          const lineNum = start + idx + 1; // 1-indexed
          const marker  = (start + idx === i) ? '>>>' : '   ';
          return `${marker} ${lineNum}: ${line}`;
        }).join('\n');

        results.push({
          file: filename,
          line: i + 1, // 1-indexed
          context,
        });
        totalMatches++;
      }
    }

    if (totalMatches >= MAX_MATCHES) break;
  }

  return {
    pattern,
    total_matches: totalMatches,
    truncated: totalMatches >= MAX_MATCHES,
    matches: results,
  };
}

/**
 * view_document — Read a document or a line range from it.
 *
 * @param {object} input
 * @param {string} input.filename — the filename to read
 * @param {number} [input.start_line] — 1-indexed start line
 * @param {number} [input.end_line] — 1-indexed end line
 */
function toolViewDocument({ filename, start_line, end_line }) {
  const entry = _docIndex.get(filename);
  if (!entry) {
    // Try a fuzzy match
    const match = [..._docIndex.keys()].find(k =>
      k.toLowerCase().includes(filename.toLowerCase())
    );
    if (match) {
      return toolViewDocument({ filename: match, start_line, end_line });
    }
    return { error: `File not found: "${filename}". Use list_documents to see available files.` };
  }

  const text = getCachedText(filename);
  if (!text) {
    return { error: `Could not read cached text for "${filename}". Try "ask legal read documents" to rebuild the cache.` };
  }

  const lines = text.split('\n');

  // If no range specified
  if (start_line == null && end_line == null) {
    if (lines.length <= 2000) {
      // Small file — return the whole thing
      const numbered = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
      return { filename, total_lines: lines.length, content: numbered };
    } else {
      // Large file — return first 200 lines with a note
      const numbered = lines.slice(0, 200).map((l, i) => `${i + 1}: ${l}`).join('\n');
      return {
        filename,
        total_lines: lines.length,
        showing: '1-200',
        note: `File has ${lines.length} lines. Showing first 200. Use start_line/end_line to view specific ranges.`,
        content: numbered,
      };
    }
  }

  // Range specified
  const s = Math.max(1, start_line || 1);
  const e = Math.min(lines.length, end_line || lines.length);
  const slice = lines.slice(s - 1, e);
  const numbered = slice.map((l, i) => `${s + i}: ${l}`).join('\n');

  return {
    filename,
    total_lines: lines.length,
    showing: `${s}-${e}`,
    content: numbered,
  };
}

/**
 * web_search — Brave Search API.
 *
 * @param {object} input
 * @param {string} input.query — the search query
 */
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

// ─── Tool dispatcher ──────────────────────────────────────────────────────────

async function executeTool(name, input) {
  switch (name) {
    case 'list_documents':  return toolListDocuments();
    case 'grep_documents':  return toolGrepDocuments(input);
    case 'view_document':   return toolViewDocument(input);
    case 'web_search':      return await toolWebSearch(input);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ─── Document status (for quick status queries) ───────────────────────────────

function documentStatus() {
  if (_docIndex.size === 0) {
    return 'No documents cached. Say "ask legal read documents" to scan your files.';
  }
  const files = [..._docIndex.values()].map(d => {
    const pg = d.pageCount ? ` (${d.pageCount} pages)` : '';
    return `  • \`${d.filename}\`${pg} — ${d.lineCount} lines [${d.docTypeGuess}]`;
  }).join('\n');
  return `📚 *Legal Document Cache*\n${_docIndex.size} file(s):\n${files}`;
}

module.exports = {
  initLegalTools,
  executeTool,
  documentStatus,
  toolListDocuments,
  toolGrepDocuments,
  toolViewDocument,
  toolWebSearch,
};
