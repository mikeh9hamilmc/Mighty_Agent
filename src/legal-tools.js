'use strict';

/**
 * Legal Tools — Direct file access for the Legal sub-agent.
 *
 * READ tools:
 *   list_documents   — list files in legal/data/ with metadata
 *   grep_documents   — regex search across all document text
 *   view_document    — read a file or line range
 *   web_search       — Brave Search API fallback
 *
 * WRITE tools:
 *   create_document  — create a new .md or .txt file in legal/data/
 *   edit_document    — replace a line range in an existing file
 *   convert_to_word  — convert a .md/.txt file to .docx via pandoc
 *
 * Auto-init:
 *   ensureInitialized() — call before any query; no-ops if already done.
 *   initLegalTools()    — force a full rescan (used by "read documents" command).
 *
 * Text extraction:
 *   PDF   → pdftotext -layout (poppler-utils) → cached to .legal-cache/
 *   DOCX  → mammoth
 *   XLSX  → xlsx (sheet_to_csv)
 *   MD/TXT → fs.readFileSync (no separate cache file needed)
 *
 * Cache invalidation: mtime comparison — re-extract only if source is newer.
 */

const fs   = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fetch = require('node-fetch');
const { LEGAL_DATA_DIR, LEGAL_CACHE_DIR, BRAVE_API_KEY } = require('./config');
const logger = require('./logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_EXTS   = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.txt', '.md']);
const WRITABLE_EXTS    = new Set(['.md', '.txt']); // agent may create these
const EXCLUDED_FILES   = new Set(['readme.md']);

// ─── In-memory document index ─────────────────────────────────────────────────
// Map<filename, { filename, filePath, cachePath, pageCount, lineCount, fileSize, mtime, docTypeGuess }>

let _docIndex = new Map();

// ─── Auto-init state ──────────────────────────────────────────────────────────

let _initialized = false;   // true once initLegalTools() has completed
let _initPromise = null;    // in-flight init (prevents parallel duplicate runs)

/**
 * Ensure the document cache is loaded.
 * Safe to call multiple times — no-ops after first successful init.
 * Awaiting this is sufficient; it deduplicates parallel callers.
 */
async function ensureInitialized() {
  if (_initialized) return;
  if (_initPromise)  return _initPromise;
  _initPromise = initLegalTools().then(() => {
    _initialized = true;
  }).catch(err => {
    // Don't lock the system on failure — allow retry next query
    _initPromise = null;
    logger.error(`[Legal Tools] Auto-init failed: ${err.message}`);
  });
  return _initPromise;
}

// ─── Doc type guessing ────────────────────────────────────────────────────────

function guessDocType(filename) {
  const lower = filename.toLowerCase();
  if (/case|summary/.test(lower))               return 'case_summary';
  if (/statement|bank/.test(lower))             return 'bank_statement';
  if (/trust/.test(lower))                      return 'trust_document';
  if (/lease/.test(lower))                      return 'lease';
  if (/letter|email|correspondence/.test(lower)) return 'correspondence';
  if (/alta|settlement|closing/.test(lower))    return 'closing_document';
  if (/deed|title/.test(lower))                 return 'deed';
  if (/motion|petition|order|filing|declaration|affidavit/.test(lower)) return 'court_filing';
  return 'unknown';
}

// ─── Text extraction ──────────────────────────────────────────────────────────

function countPdfPages(text) {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\f') count++;
  }
  return count;
}

/**
 * Extract text from a PDF using pdftotext -layout.
 * Async — does NOT block the event loop.
 */
async function extractPdfText(filePath) {
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-layout', filePath, '-'], {
      encoding:  'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout:   60_000,
    });
    return stdout;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('pdftotext not found — sudo apt-get install poppler-utils');
    }
    throw err;
  }
}

async function extractDocxText(filePath) {
  const mammoth = require('mammoth');
  const result  = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

function extractXlsxText(filePath) {
  const XLSX = require('xlsx');
  const wb   = XLSX.readFile(filePath);
  return wb.SheetNames
    .map(name => `[Sheet: ${name}]\n` + XLSX.utils.sheet_to_csv(wb.Sheets[name]))
    .join('\n\n');
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf')                     return extractPdfText(filePath);
  if (ext === '.docx' || ext === '.doc')  return await extractDocxText(filePath);
  if (ext === '.xlsx' || ext === '.xls')  return extractXlsxText(filePath);
  if (ext === '.txt'  || ext === '.md')   return fs.readFileSync(filePath, 'utf-8');
  return null;
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

function getCacheFilePath(filename) {
  return path.join(LEGAL_CACHE_DIR, path.parse(filename).name + '.txt');
}

function isCacheFresh(sourceFile, cacheFile) {
  if (!fs.existsSync(cacheFile)) return false;
  return fs.statSync(cacheFile).mtimeMs >= fs.statSync(sourceFile).mtimeMs;
}

function getCachedText(filename) {
  const entry = _docIndex.get(filename);
  if (!entry) return null;
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.txt' || ext === '.md') {
    return fs.existsSync(entry.filePath) ? fs.readFileSync(entry.filePath, 'utf-8') : null;
  }
  return fs.existsSync(entry.cachePath) ? fs.readFileSync(entry.cachePath, 'utf-8') : null;
}

/**
 * Write text to the .legal-cache and update _docIndex for one file.
 * Used after create_document and edit_document.
 */
function updateCacheEntry(filename, filePath, text) {
  fs.mkdirSync(LEGAL_CACHE_DIR, { recursive: true });

  const ext       = path.extname(filename).toLowerCase();
  const cacheFile = getCacheFilePath(filename);
  const needsCache = ext !== '.txt' && ext !== '.md';

  if (needsCache && text) {
    fs.writeFileSync(cacheFile, text, 'utf-8');
  }

  const stat      = fs.statSync(filePath);
  const lines     = text ? text.split('\n') : [];
  const pageCount = ext === '.pdf' ? countPdfPages(text || '') : null;

  _docIndex.set(filename, {
    filename,
    filePath,
    cachePath:    needsCache ? cacheFile : filePath,
    pageCount,
    lineCount:    lines.length,
    fileSize:     stat.size,
    mtime:        stat.mtimeMs,
    docTypeGuess: guessDocType(filename),
  });
}

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Full rescan: compare data/ vs .legal-cache/, extract new/changed files.
 * Returns a human-readable summary string.
 * Sets _initialized = true when done (via ensureInitialized wrapper).
 */
async function initLegalTools() {
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
    return '📂 No supported documents found in legal/data/.';
  }

  let extracted = 0, cached = 0, failed = 0;
  const newIndex = new Map();

  for (const filename of files) {
    const filePath  = path.join(LEGAL_DATA_DIR, filename);
    const cacheFile = getCacheFilePath(filename);
    const ext       = path.extname(filename).toLowerCase();
    const stat      = fs.statSync(filePath);
    const needsCache = ext !== '.txt' && ext !== '.md';

    try {
      let text;
      if (needsCache && isCacheFresh(filePath, cacheFile)) {
        text = fs.readFileSync(cacheFile, 'utf-8');
        cached++;
        logger.info(`[Legal Tools] Cached: ${filename}`);
      } else {
        logger.info(`[Legal Tools] Extracting: ${filename}`);
        text = await extractText(filePath);
        if (!text || text.trim().length < 10) {
          logger.warn(`[Legal Tools] Skipping (empty/unreadable): ${filename}`);
          failed++;
          continue;
        }
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
        cachePath:    needsCache ? cacheFile : filePath,
        pageCount,
        lineCount:    lines.length,
        fileSize:     stat.size,
        mtime:        stat.mtimeMs,
        docTypeGuess: guessDocType(filename),
      });
    } catch (err) {
      logger.error(`[Legal Tools] Failed to process ${filename}: ${err.message}`);
      failed++;
    }
  }

  _docIndex = newIndex;
  _initialized = true;

  const summary = [
    `✅ Document cache ready.`,
    `📄 ${_docIndex.size} file(s) loaded (${extracted} extracted, ${cached} from cache, ${failed} failed).`,
  ];
  const details = [..._docIndex.values()].map(d => {
    const pg = d.pageCount ? ` (${d.pageCount} pages)` : '';
    return `  • \`${d.filename}\`${pg} — ${d.lineCount} lines, ${(d.fileSize / 1024).toFixed(0)} KB [${d.docTypeGuess}]`;
  });
  if (details.length) summary.push('\n' + details.join('\n'));

  logger.info(`[Legal Tools] Index built: ${_docIndex.size} file(s).`);
  return summary.join('\n');
}

// ─── Filename sanitizer ───────────────────────────────────────────────────────

/**
 * Validate a filename is safe to write inside legal/data/.
 * Returns { ok, reason } — reason is set on failure.
 */
function validateWritableFilename(filename, allowedExts = WRITABLE_EXTS) {
  if (!filename || typeof filename !== 'string') {
    return { ok: false, reason: 'Filename must be a non-empty string.' };
  }
  // No path separators
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return { ok: false, reason: 'Filename must not contain path separators or "..".' };
  }
  // Allowed extension
  const ext = path.extname(filename).toLowerCase();
  if (!allowedExts.has(ext)) {
    return { ok: false, reason: `Extension "${ext}" is not allowed. Allowed: ${[...allowedExts].join(', ')}.` };
  }
  return { ok: true };
}

// ─── READ Tool Implementations ────────────────────────────────────────────────

function toolListDocuments() {
  if (_docIndex.size === 0) {
    return { files: [], message: 'No documents indexed. The cache is still loading, or run "ask legal read documents".' };
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

function toolGrepDocuments({ pattern, case_sensitive = false, context_lines = 3, file_filter }) {
  const flags = case_sensitive ? 'g' : 'gi';
  let regex;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regex = new RegExp(escaped, flags);
  }

  const results = [];
  const MAX_MATCHES = 50;
  let totalMatches = 0;

  for (const [filename, entry] of _docIndex) {
    if (file_filter && !filename.toLowerCase().includes(file_filter.toLowerCase())) continue;
    const text = getCachedText(filename);
    if (!text) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (totalMatches >= MAX_MATCHES) break;
      if (regex.test(lines[i])) {
        regex.lastIndex = 0;
        const start   = Math.max(0, i - context_lines);
        const end     = Math.min(lines.length - 1, i + context_lines);
        const context = lines.slice(start, end + 1).map((line, idx) => {
          const lineNum = start + idx + 1;
          const marker  = (start + idx === i) ? '>>>' : '   ';
          return `${marker} ${lineNum}: ${line}`;
        }).join('\n');
        results.push({ file: filename, line: i + 1, context });
        totalMatches++;
      }
    }
    if (totalMatches >= MAX_MATCHES) break;
  }

  return { pattern, total_matches: totalMatches, truncated: totalMatches >= MAX_MATCHES, matches: results };
}

function toolViewDocument({ filename, start_line, end_line }) {
  const entry = _docIndex.get(filename);
  if (!entry) {
    const match = [..._docIndex.keys()].find(k => k.toLowerCase().includes(filename.toLowerCase()));
    if (match) return toolViewDocument({ filename: match, start_line, end_line });
    return { error: `File not found: "${filename}". Use list_documents to see available files.` };
  }

  const text = getCachedText(filename);
  if (!text) return { error: `Could not read cached text for "${filename}". Try "ask legal read documents".` };

  const lines = text.split('\n');

  if (start_line == null && end_line == null) {
    if (lines.length <= 2000) {
      return { filename, total_lines: lines.length, content: lines.map((l, i) => `${i + 1}: ${l}`).join('\n') };
    }
    return {
      filename,
      total_lines: lines.length,
      showing: '1-200',
      note: `File has ${lines.length} lines. Showing first 200. Use start_line/end_line for more.`,
      content: lines.slice(0, 200).map((l, i) => `${i + 1}: ${l}`).join('\n'),
    };
  }

  const s = Math.max(1, start_line || 1);
  const e = Math.min(lines.length, end_line || lines.length);
  return {
    filename,
    total_lines: lines.length,
    showing: `${s}-${e}`,
    content: lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join('\n'),
  };
}

async function toolWebSearch({ query }) {
  if (!BRAVE_API_KEY) return { error: 'BRAVE_API_KEY not configured.' };
  logger.info(`[Legal] Web search: ${query}`);
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`;
    const res  = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
    });
    if (!res.ok) return { error: `Brave API error: ${res.status} ${res.statusText}` };
    const data    = await res.json();
    const results = (data.web?.results || []).slice(0, 5).map(r => ({
      title: r.title, url: r.url, description: r.description || '',
    }));
    return { results };
  } catch (err) {
    logger.error(`[Legal] Brave Search error: ${err.message}`);
    return { error: err.message };
  }
}

// ─── WRITE Tool Implementations ───────────────────────────────────────────────

/**
 * create_document — Write a new .md or .txt file to legal/data/.
 *
 * @param {object} input
 * @param {string} input.filename   — e.g. "Motion_Declaratory_Judgment.md"
 * @param {string} input.content    — full file content
 * @param {boolean} [input.overwrite=false] — allow overwriting existing file
 */
async function toolCreateDocument({ filename, content, overwrite = false }) {
  const check = validateWritableFilename(filename, WRITABLE_EXTS);
  if (!check.ok) return { error: check.reason };
  if (!content || content.trim().length === 0) return { error: 'Content cannot be empty.' };

  const filePath = path.join(LEGAL_DATA_DIR, filename);

  if (fs.existsSync(filePath) && !overwrite) {
    return {
      error: `File "${filename}" already exists. Set overwrite: true to replace it, or use edit_document to modify specific lines.`,
    };
  }

  try {
    fs.mkdirSync(LEGAL_DATA_DIR, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    updateCacheEntry(filename, filePath, content);
    logger.info(`[Legal Tools] Created: ${filename} (${content.split('\n').length} lines)`);
    return {
      success:   true,
      filename,
      path:      filePath,
      line_count: content.split('\n').length,
      message:   `✅ Created \`${filename}\` in legal/data/ and added to document cache.`,
    };
  } catch (err) {
    logger.error(`[Legal Tools] create_document failed: ${err.message}`);
    return { error: `Failed to create file: ${err.message}` };
  }
}

/**
 * edit_document — Replace a range of lines in an existing .md or .txt file.
 *
 * @param {object} input
 * @param {string} input.filename     — file to edit (must exist in legal/data/)
 * @param {number} input.start_line   — 1-indexed start line to replace
 * @param {number} input.end_line     — 1-indexed end line to replace (inclusive)
 * @param {string} input.new_content  — replacement text for the specified range
 */
function toolEditDocument({ filename, start_line, end_line, new_content }) {
  // Resolve fuzzy match
  if (!_docIndex.has(filename)) {
    const match = [..._docIndex.keys()].find(k => k.toLowerCase().includes(filename.toLowerCase()));
    if (match) filename = match;
    else return { error: `File not found: "${filename}". Use list_documents to see available files.` };
  }

  const entry = _docIndex.get(filename);
  const ext   = path.extname(filename).toLowerCase();

  if (!WRITABLE_EXTS.has(ext)) {
    return { error: `"${filename}" is a ${ext} file and cannot be edited as text. Only .md and .txt files are editable.` };
  }

  const currentText = getCachedText(filename);
  if (!currentText) return { error: `Could not read "${filename}" for editing.` };

  const lines = currentText.split('\n');
  const s     = Math.max(1, start_line || 1);
  const e     = Math.min(lines.length, end_line || lines.length);

  if (s > lines.length) {
    return { error: `start_line ${s} exceeds file length (${lines.length} lines).` };
  }

  const replacementLines = (new_content || '').split('\n');
  const updated = [
    ...lines.slice(0, s - 1),
    ...replacementLines,
    ...lines.slice(e),
  ];
  const updatedText = updated.join('\n');

  try {
    fs.writeFileSync(entry.filePath, updatedText, 'utf-8');
    updateCacheEntry(filename, entry.filePath, updatedText);
    logger.info(`[Legal Tools] Edited: ${filename} (lines ${s}-${e} replaced, now ${updated.length} lines)`);
    return {
      success:        true,
      filename,
      lines_replaced: `${s}-${e}`,
      new_line_count: updated.length,
      message:        `✅ Edited \`${filename}\` — lines ${s}–${e} replaced. File now has ${updated.length} lines.`,
    };
  } catch (err) {
    logger.error(`[Legal Tools] edit_document failed: ${err.message}`);
    return { error: `Failed to write file: ${err.message}` };
  }
}

/**
 * convert_to_word — Convert a .md or .txt file in legal/data/ to a .docx file
 * using pandoc. The output .docx is saved alongside the source in legal/data/.
 *
 * @param {object} input
 * @param {string} input.filename — source .md or .txt file
 */
async function toolConvertToWord({ filename }) {
  // Fuzzy match
  if (!_docIndex.has(filename)) {
    const match = [..._docIndex.keys()].find(k => k.toLowerCase().includes(filename.toLowerCase()));
    if (match) filename = match;
    else return { error: `File not found: "${filename}". Use list_documents to see available files.` };
  }

  const entry  = _docIndex.get(filename);
  const ext    = path.extname(filename).toLowerCase();

  if (ext !== '.md' && ext !== '.txt') {
    return { error: `"${filename}" is a ${ext} file. Only .md and .txt files can be converted to Word.` };
  }

  const base       = path.parse(filename).name;
  const outputName = `${base}.docx`;
  const outputPath = path.join(LEGAL_DATA_DIR, outputName);

  try {
    logger.info(`[Legal Tools] Converting ${filename} → ${outputName} via pandoc`);
    await execFileAsync('pandoc', [entry.filePath, '-o', outputPath, '--from=markdown', '--to=docx'], {
      timeout:  60_000,
      encoding: 'utf-8',
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { error: 'pandoc not found. Install it: sudo apt-get install pandoc' };
    }
    return { error: `pandoc conversion failed: ${err.message}` };
  }

  // Extract text from the new docx and add to index
  try {
    const docxText = await extractDocxText(outputPath);
    updateCacheEntry(outputName, outputPath, docxText);
    logger.info(`[Legal Tools] Converted and cached: ${outputName}`);
  } catch (err) {
    // Non-fatal — the file was created, just not cached for reading
    logger.warn(`[Legal Tools] Could not cache new docx ${outputName}: ${err.message}`);
  }

  return {
    success:         true,
    source:          filename,
    output_filename: outputName,
    output_path:     outputPath,
    message:         `✅ Converted \`${filename}\` → \`${outputName}\` and saved to legal/data/.`,
  };
}

// ─── Tool dispatcher ──────────────────────────────────────────────────────────

async function executeTool(name, input) {
  switch (name) {
    case 'list_documents':   return toolListDocuments();
    case 'grep_documents':   return toolGrepDocuments(input);
    case 'view_document':    return toolViewDocument(input);
    case 'web_search':       return await toolWebSearch(input);
    case 'create_document':  return await toolCreateDocument(input);
    case 'edit_document':    return toolEditDocument(input);
    case 'convert_to_word':  return await toolConvertToWord(input);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ─── Document status ──────────────────────────────────────────────────────────

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
  ensureInitialized,
  executeTool,
  documentStatus,
  // Individual tools (exported for testing)
  toolListDocuments,
  toolGrepDocuments,
  toolViewDocument,
  toolWebSearch,
  toolCreateDocument,
  toolEditDocument,
  toolConvertToWord,
};
