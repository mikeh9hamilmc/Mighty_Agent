'use strict';

/**
 * Document Tools — Direct file access for specialized sub-agents.
 * Refactored into DocumentManager to allow isolated instances (Legal, Medical, etc.)
 */

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fetch = require('node-fetch');
const { SKILLS_DIR, BRAVE_API_KEY } = require('./config');
const logger = require('./logger');

const SUPPORTED_EXTS   = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.txt', '.md']);
const WRITABLE_EXTS    = new Set(['.md', '.txt']);
const EXCLUDED_FILES   = new Set(['readme.md']);

function countPdfPages(text) {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\f') count++;
  }
  return count;
}

async function extractPdfText(filePath) {
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-layout', filePath, '-'], {
      encoding:  'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      timeout:   60_000,
    });
    return stdout;
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('pdftotext not found — sudo apt-get install poppler-utils');
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
  if (ext === '.pdf') return extractPdfText(filePath);
  if (ext === '.docx' || ext === '.doc') return await extractDocxText(filePath);
  if (ext === '.xlsx' || ext === '.xls') return extractXlsxText(filePath);
  if (ext === '.txt'  || ext === '.md') return fs.readFileSync(filePath, 'utf-8');
  return null;
}

function guessDocType(filename) {
  const lower = filename.toLowerCase();
  if (/case|summary/.test(lower)) return 'case_summary';
  if (/statement|bank/.test(lower)) return 'bank_statement';
  if (/trust/.test(lower)) return 'trust_document';
  if (/lease/.test(lower)) return 'lease';
  if (/letter|email|correspondence/.test(lower)) return 'correspondence';
  if (/alta|settlement|closing/.test(lower)) return 'closing_document';
  if (/deed|title/.test(lower)) return 'deed';
  if (/motion|petition|order|filing|declaration|affidavit/.test(lower)) return 'court_filing';
  if (/medical|doctor|hospital|clinic|patient|record/.test(lower)) return 'medical_record';
  if (/lab|test|blood|result/.test(lower)) return 'lab_result';
  if (/rx|prescription|pharmacy/.test(lower)) return 'prescription';
  return 'unknown';
}

function validateWritableFilename(filename, allowedExts = WRITABLE_EXTS) {
  if (!filename || typeof filename !== 'string') return { ok: false, reason: 'Filename must be a non-empty string.' };
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return { ok: false, reason: 'Filename must not contain path separators or "..".' };
  const ext = path.extname(filename).toLowerCase();
  if (!allowedExts.has(ext)) return { ok: false, reason: `Extension "${ext}" is not allowed. Allowed: ${[...allowedExts].join(', ')}.` };
  return { ok: true };
}

const instances = new Set();

// Module-level cache for main agent memory — shared across all sub-agents.
// Populated on first access or after refreshAllManagers(); reads disk just once.
const _globalMemoryCache = { content: null };

function loadGlobalMemoryCache() {
  const mainMemoryDir = path.resolve(SKILLS_DIR, 'main', 'memory');
  let str = '';
  if (fs.existsSync(mainMemoryDir)) {
    try {
      const files = fs.readdirSync(mainMemoryDir).filter(f => f.endsWith('.md') && !EXCLUDED_FILES.has(f.toLowerCase()));
      logger.debug(`[Global Memory] Loading ${files.length} main memory file(s) into cache.`);
      for (const file of files) {
        str += `[Global Memory: ${file}]\n` + fs.readFileSync(path.join(mainMemoryDir, file), 'utf-8') + '\n\n';
      }
    } catch (err) {
      logger.error(`[Global Memory] Failed to load main memory: ${err.message}`);
    }
  } else {
    logger.debug(`[Global Memory] Main memory directory not found: ${mainMemoryDir}`);
  }
  _globalMemoryCache.content = str || '';
  return _globalMemoryCache.content;
}

class DocumentManager {
  constructor(agentName) {
    this.agentName = agentName;
    this.agentCap  = agentName.charAt(0).toUpperCase() + agentName.slice(1);
    this.dataDir   = path.resolve(SKILLS_DIR, agentName, 'data');
    this.cacheDir  = path.resolve(this.dataDir, `.${agentName}-cache`);
    this.memoryDir = path.resolve(SKILLS_DIR, agentName, 'memory');
    
    this._docIndex = new Map();
    this._initialized = false;
    this._initPromise = null;
    instances.add(this);
  }

  async ensureInitialized() {
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this.initTools().then(() => {
      this._initialized = true;
    }).catch(err => {
      this._initPromise = null;
      logger.error(`[${this.agentCap} Tools] Auto-init failed: ${err.message}`);
    });
    return this._initPromise;
  }

  getCacheFilePath(filename) {
    return path.join(this.cacheDir, path.parse(filename).name + '.txt');
  }

  isCacheFresh(sourceFile, cacheFile) {
    if (!fs.existsSync(cacheFile)) return false;
    return fs.statSync(cacheFile).mtimeMs >= fs.statSync(sourceFile).mtimeMs;
  }

  getCachedText(filename) {
    const entry = this._docIndex.get(filename);
    if (!entry) return null;
    const ext = path.extname(filename).toLowerCase();
    if (ext === '.txt' || ext === '.md') {
      return fs.existsSync(entry.filePath) ? fs.readFileSync(entry.filePath, 'utf-8') : null;
    }
    return fs.existsSync(entry.cachePath) ? fs.readFileSync(entry.cachePath, 'utf-8') : null;
  }

  updateCacheEntry(filename, filePath, text) {
    fs.mkdirSync(this.cacheDir, { recursive: true });

    const ext = path.extname(filename).toLowerCase();
    const cacheFile = this.getCacheFilePath(filename);
    const needsCache = ext !== '.txt' && ext !== '.md';

    if (needsCache && text) {
      fs.writeFileSync(cacheFile, text, 'utf-8');
    }

    const stat = fs.statSync(filePath);
    const lines = text ? text.split('\n') : [];
    const pageCount = ext === '.pdf' ? countPdfPages(text || '') : null;

    this._docIndex.set(filename, {
      filename,
      filePath,
      cachePath: needsCache ? cacheFile : filePath,
      pageCount,
      lineCount: lines.length,
      fileSize: stat.size,
      mtime: stat.mtimeMs,
      docTypeGuess: guessDocType(filename),
    });
  }

  async initTools() {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });

    // 1. Auto-convert binary files to Markdown
    const rawFiles = fs.readdirSync(this.dataDir);
    for (const f of rawFiles) {
      if (f.startsWith('.')) continue;
      const ext = path.extname(f).toLowerCase();
      const base = f.toLowerCase();
      if (SUPPORTED_EXTS.has(ext) && ext !== '.txt' && ext !== '.md' && !EXCLUDED_FILES.has(base)) {
        const filePath = path.join(this.dataDir, f);
        const mdPath = path.join(this.dataDir, path.parse(f).name + '.md');
        
        let needsExtraction = true;
        if (fs.existsSync(mdPath)) {
          const binStat = fs.statSync(filePath);
          const mdStat = fs.statSync(mdPath);
          if (mdStat.mtimeMs >= binStat.mtimeMs) {
            needsExtraction = false;
          }
        }
        
        if (needsExtraction) {
          logger.info(`[${this.agentCap} Tools] Extracting binary to MD: ${f}`);
          try {
            const text = await extractText(filePath);
            if (text && text.trim().length >= 10) {
              fs.writeFileSync(mdPath, text, 'utf-8');
              logger.info(`[${this.agentCap} Tools] Saved converted file: ${path.basename(mdPath)}`);
            } else {
              logger.warn(`[${this.agentCap} Tools] Skipping (empty/unreadable): ${f}`);
            }
          } catch (err) {
            logger.error(`[${this.agentCap} Tools] Failed to extract ${f}: ${err.message}`);
          }
        }
      }
    }

    // 2. Collect files from data/ directory (Skip binary if .md equivalent exists)
    const dataFiles = [];
    const updatedRawFiles = fs.readdirSync(this.dataDir);
    for (const f of updatedRawFiles) {
      if (f.startsWith('.')) continue;
      const ext = path.extname(f).toLowerCase();
      const base = f.toLowerCase();
      
      if (SUPPORTED_EXTS.has(ext) && !EXCLUDED_FILES.has(base)) {
        if (ext === '.txt' || ext === '.md') {
          dataFiles.push({ filename: f, filePath: path.join(this.dataDir, f) });
        } else {
          const mdPath = path.join(this.dataDir, path.parse(f).name + '.md');
          if (!fs.existsSync(mdPath)) {
            dataFiles.push({ filename: f, filePath: path.join(this.dataDir, f) });
          }
        }
      }
    }

    // Also index .md/.txt files from memory/ — so research saved via save_memory is queryable
    const memoryFiles = [];
    if (fs.existsSync(this.memoryDir)) {
      fs.readdirSync(this.memoryDir).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return (ext === '.md' || ext === '.txt') && !f.startsWith('.') && !EXCLUDED_FILES.has(f.toLowerCase());
      }).forEach(f => {
        // Prefix name to avoid collisions with data/ files
        memoryFiles.push({ filename: `memory_${f}`, filePath: path.join(this.memoryDir, f) });
      });
    }

    const allFiles = [...dataFiles, ...memoryFiles];

    if (allFiles.length === 0) {
      logger.info(`[${this.agentCap} Tools] No documents found in ${this.agentName}/data/ or memory/.`);
      this._docIndex = new Map();
      return `📂 No supported documents found in ${this.agentName}/data/.`;
    }

    let extracted = 0, cached = 0, failed = 0;
    const newIndex = new Map();

    for (const { filename, filePath } of allFiles) {
      const cacheFile = this.getCacheFilePath(filename);
      const ext = path.extname(filename).toLowerCase();
      const stat = fs.statSync(filePath);
      const needsCache = ext !== '.txt' && ext !== '.md';

      try {
        let text;
        if (!needsCache) {
          text = fs.readFileSync(filePath, 'utf-8');
          cached++;
          logger.info(`[${this.agentCap} Tools] Loaded text: ${filename}`);
        } else if (this.isCacheFresh(filePath, cacheFile)) {
          text = fs.readFileSync(cacheFile, 'utf-8');
          cached++;
          logger.info(`[${this.agentCap} Tools] Cached: ${filename}`);
        } else {
          logger.info(`[${this.agentCap} Tools] Extracting: ${filename}`);
          text = await extractText(filePath);
          if (!text || text.trim().length < 10) {
            logger.warn(`[${this.agentCap} Tools] Skipping (empty/unreadable): ${filename}`);
            failed++;
            continue;
          }
          fs.writeFileSync(cacheFile, text, 'utf-8');
          extracted++;
        }

        const lines = text.split('\n');
        const pageCount = ext === '.pdf' ? countPdfPages(text) : null;

        newIndex.set(filename, {
          filename,
          filePath,
          cachePath: needsCache ? cacheFile : filePath,
          pageCount,
          lineCount: lines.length,
          fileSize: stat.size,
          mtime: stat.mtimeMs,
          docTypeGuess: guessDocType(filename),
        });
      } catch (err) {
        logger.error(`[${this.agentCap} Tools] Failed to process ${filename}: ${err.message}`);
      }
    }

    this._docIndex = newIndex;
    this._initialized = true;

    const summary = [
      `✅ Document cache ready.`,
      `📄 ${this._docIndex.size} file(s) loaded (${extracted} extracted, ${cached} from cache, ${failed} failed).`,
    ];
    const details = [...this._docIndex.values()].map(d => {
      const pg = d.pageCount ? ` (${d.pageCount} pages)` : '';
      return `  • \`${d.filename}\`${pg} — ${d.lineCount} lines, ${(d.fileSize / 1024).toFixed(0)} KB [${d.docTypeGuess}]`;
    });
    if (details.length) summary.push('\n' + details.join('\n'));

    logger.info(`[${this.agentCap} Tools] Index built: ${this._docIndex.size} file(s).`);
    return summary.join('\n');
  }

  toolListDocuments() {
    if (this._docIndex.size === 0) {
      return { files: [], message: `No documents indexed. The cache is still loading, or run "ask ${this.agentName} read documents".` };
    }
    const files = [...this._docIndex.values()].map(d => ({
      filename: d.filename,
      file_size_kb: Math.round(d.fileSize / 1024),
      line_count: d.lineCount,
      page_count: d.pageCount,
      doc_type: d.docTypeGuess,
    }));
    return { files, total: files.length };
  }

  toolGrepDocuments({ pattern, case_sensitive = false, context_lines = 3, file_filter }) {
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

    for (const [filename, entry] of this._docIndex) {
      if (file_filter && !filename.toLowerCase().includes(file_filter.toLowerCase())) continue;
      const text = this.getCachedText(filename);
      if (!text) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (totalMatches >= MAX_MATCHES) break;
        if (regex.test(lines[i])) {
          regex.lastIndex = 0;
          const start = Math.max(0, i - context_lines);
          const end = Math.min(lines.length - 1, i + context_lines);
          const context = lines.slice(start, end + 1).map((line, idx) => {
            const lineNum = start + idx + 1;
            const marker = (start + idx === i) ? '>>>' : '   ';
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

  toolViewDocument({ filename, start_line, end_line }) {
    const entry = this._docIndex.get(filename);
    if (!entry) {
      const match = [...this._docIndex.keys()].find(k => k.toLowerCase().includes(filename.toLowerCase()));
      if (match) return this.toolViewDocument({ filename: match, start_line, end_line });
      return { error: `File not found: "${filename}". Use list_documents to see available files.` };
    }

    const text = this.getCachedText(filename);
    if (!text) return { error: `Could not read cached text for "${filename}". Try "ask ${this.agentName} read documents".` };

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

  async toolWebSearch({ query }) {
    if (!BRAVE_API_KEY) return { error: 'BRAVE_API_KEY not configured.' };
    logger.info(`[${this.agentCap}] Web search: ${query}`);
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&text_decorations=false`;
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_API_KEY,
        },
      });
      if (!res.ok) return { error: `Brave API error: ${res.status} ${res.statusText}` };
      const data = await res.json();
      const results = (data.web?.results || []).slice(0, 5).map(r => ({
        title: r.title, url: r.url, description: r.description || '',
      }));
      return { results };
    } catch (err) {
      logger.error(`[${this.agentCap}] Brave Search error: ${err.message}`);
      return { error: err.message };
    }
  }

  async toolCreateDocument({ filename, content, overwrite = false }) {
    const check = validateWritableFilename(filename, WRITABLE_EXTS);
    if (!check.ok) return { error: check.reason };
    if (!content || content.trim().length === 0) return { error: 'Content cannot be empty.' };

    const filePath = path.join(this.dataDir, filename);

    if (fs.existsSync(filePath) && !overwrite) {
      return { error: `File "${filename}" already exists. Set overwrite: true to replace it, or use edit_document to modify specific lines.` };
    }

    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
      this.updateCacheEntry(filename, filePath, content);
      logger.info(`[${this.agentCap} Tools] Created: ${filename} (${content.split('\n').length} lines)`);
      return {
        success: true,
        filename,
        path: filePath,
        line_count: content.split('\n').length,
        message: `✅ Created \`${filename}\` in ${this.agentName}/data/ and added to document cache.`,
      };
    } catch (err) {
      logger.error(`[${this.agentCap} Tools] create_document failed: ${err.message}`);
      return { error: `Failed to create file: ${err.message}` };
    }
  }

  toolEditDocument({ filename, start_line, end_line, new_content }) {
    if (!this._docIndex.has(filename)) {
      const match = [...this._docIndex.keys()].find(k => k.toLowerCase().includes(filename.toLowerCase()));
      if (match) filename = match;
      else return { error: `File not found: "${filename}". Use list_documents to see available files.` };
    }

    const entry = this._docIndex.get(filename);
    const ext = path.extname(filename).toLowerCase();

    if (!WRITABLE_EXTS.has(ext)) {
      return { error: `"${filename}" is a ${ext} file and cannot be edited as text. Only .md and .txt files are editable.` };
    }

    const currentText = this.getCachedText(filename);
    if (!currentText) return { error: `Could not read "${filename}" for editing.` };

    const lines = currentText.split('\n');
    const s = Math.max(1, start_line || 1);
    const e = Math.min(lines.length, end_line || lines.length);

    if (s > lines.length) return { error: `start_line ${s} exceeds file length (${lines.length} lines).` };

    const replacementLines = (new_content || '').split('\n');
    const updated = [...lines.slice(0, s - 1), ...replacementLines, ...lines.slice(e)];
    const updatedText = updated.join('\n');

    try {
      fs.writeFileSync(entry.filePath, updatedText, 'utf-8');
      this.updateCacheEntry(filename, entry.filePath, updatedText);
      logger.info(`[${this.agentCap} Tools] Edited: ${filename} (lines ${s}-${e} replaced, now ${updated.length} lines)`);
      return {
        success: true,
        filename,
        lines_replaced: `${s}-${e}`,
        new_line_count: updated.length,
        message: `✅ Edited \`${filename}\` — lines ${s}–${e} replaced. File now has ${updated.length} lines.`,
      };
    } catch (err) {
      logger.error(`[${this.agentCap} Tools] edit_document failed: ${err.message}`);
      return { error: `Failed to write file: ${err.message}` };
    }
  }

  async toolConvertToWord({ filename }) {
    if (!this._docIndex.has(filename)) {
      const match = [...this._docIndex.keys()].find(k => k.toLowerCase().includes(filename.toLowerCase()));
      if (match) filename = match;
      else return { error: `File not found: "${filename}". Use list_documents to see available files.` };
    }

    const entry = this._docIndex.get(filename);
    const ext = path.extname(filename).toLowerCase();

    if (ext !== '.md' && ext !== '.txt') return { error: `"${filename}" is a ${ext} file. Only .md and .txt files can be converted to Word.` };

    const base = path.parse(filename).name;
    const outputName = `${base}.docx`;
    const outputPath = path.join(this.dataDir, outputName);

    try {
      logger.info(`[${this.agentCap} Tools] Converting ${filename} → ${outputName} via pandoc`);
      await execFileAsync('pandoc', [entry.filePath, '-o', outputPath, '--from=markdown', '--to=docx'], { timeout: 60_000, encoding: 'utf-8' });
    } catch (err) {
      if (err.code === 'ENOENT') return { error: 'pandoc not found. Install it: sudo apt-get install pandoc' };
      return { error: `pandoc conversion failed: ${err.message}` };
    }

    try {
      const docxText = await extractDocxText(outputPath);
      this.updateCacheEntry(outputName, outputPath, docxText);
      logger.info(`[${this.agentCap} Tools] Converted and cached: ${outputName}`);
    } catch (err) {
      logger.warn(`[${this.agentCap} Tools] Could not cache new docx ${outputName}: ${err.message}`);
    }

    return {
      success: true,
      source: filename,
      output_filename: outputName,
      output_path: outputPath,
      message: `✅ Converted \`${filename}\` → \`${outputName}\` and saved to ${this.agentName}/data/.`,
    };
  }

  ensureMemoryDir() {
    if (!fs.existsSync(this.memoryDir)) fs.mkdirSync(this.memoryDir, { recursive: true });
  }

  toolSaveMemory({ topic, content }) {
    if (!topic || !content) {
      return { error: 'Both topic and content are required.' };
    }
    this.ensureMemoryDir();
    const safeTopic = topic.replace(/[^a-z0-9_-]/gi, '_');
    const filename = `${safeTopic}.md`;
    const filePath = path.join(this.memoryDir, filename);

    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      logger.info(`[${this.agentCap} Memory] Saved: ${filename}`);
      // Invalidate global cache so sub-agents see the new memory immediately
      if (this.agentName === 'main') {
        _globalMemoryCache.content = null;
        logger.debug('[Global Memory] Cache invalidated after main agent save_memory.');
      }
      return { success: true, message: `✅ Memory saved to \`${filename}\`.` };
    } catch (err) {
      logger.error(`[${this.agentCap} Memory] Failed to save ${filename}: ${err.message}`);
      return { error: `Failed to save memory: ${err.message}` };
    }
  }

  toolReadMemory({ topic }) {
    this.ensureMemoryDir();
    const safeTopic = topic.replace(/[^a-z0-9_.-]/gi, '_');
    const filename = topic.endsWith('.md') ? topic : `${safeTopic}.md`;
    const filePath = path.join(this.memoryDir, filename);

    // Check own memory first
    if (fs.existsSync(filePath)) {
      try {
        return { filename, content: fs.readFileSync(filePath, 'utf-8') };
      } catch (err) {
        return { error: `Failed to read memory: ${err.message}` };
      }
    }

    // Fallback: check global main memory for sub-agents
    if (this.agentName !== 'main') {
      const globalPath = path.join(path.resolve(SKILLS_DIR, 'main', 'memory'), filename);
      if (fs.existsSync(globalPath)) {
        try {
          const content = fs.readFileSync(globalPath, 'utf-8');
          logger.debug(`[${this.agentCap} Memory] Read from global memory: ${filename}`);
          return { filename, source: 'global', content };
        } catch (err) {
          return { error: `Failed to read global memory: ${err.message}` };
        }
      }
    }

    return { error: `Memory file "${filename}" not found in ${this.agentName} or global memory.` };
  }

  toolListMemories() {
    this.ensureMemoryDir();
    try {
      const ownFiles = fs.readdirSync(this.memoryDir).filter(f => f.endsWith('.md'));

      // For sub-agents, also list global main memory files
      let globalFiles = [];
      if (this.agentName !== 'main') {
        const mainMemDir = path.resolve(SKILLS_DIR, 'main', 'memory');
        if (fs.existsSync(mainMemDir)) {
          globalFiles = fs.readdirSync(mainMemDir).filter(f => f.endsWith('.md'));
        }
      }

      const result = {};
      if (ownFiles.length > 0) result.own_memories = ownFiles;
      if (globalFiles.length > 0) result.global_memories = globalFiles;
      if (ownFiles.length === 0 && globalFiles.length === 0) return { message: 'No memory files found.' };
      return result;
    } catch (err) {
      return { error: `Failed to list memories: ${err.message}` };
    }
  }

  getCoreMemory() {
    this.ensureMemoryDir();
    let memoryStr = '';

    // Global Core Memory — served from the in-memory cache (populated once at startup or refresh)
    if (this.agentName !== 'main') {
      if (_globalMemoryCache.content === null) {
        loadGlobalMemoryCache();
      }
      if (_globalMemoryCache.content) {
        memoryStr += _globalMemoryCache.content;
      }
    }

    // Domain-Specific Core Memory (read all memory files for this agent)
    if (fs.existsSync(this.memoryDir)) {
      try {
        const files = fs.readdirSync(this.memoryDir).filter(f => f.endsWith('.md') && !EXCLUDED_FILES.has(f.toLowerCase()));
        for (const file of files) {
          const filePath = path.join(this.memoryDir, file);
          memoryStr += `[${this.agentCap} Memory: ${file}]\n` + fs.readFileSync(filePath, 'utf-8') + '\n\n';
        }
      } catch (err) {
        logger.error(`[${this.agentCap} Memory] Failed to read memory dir: ${err.message}`);
      }
    }

    return memoryStr.trim() || null;
  }

  async toolSaveSessionHistory(input) {
    const session = require('./session');
    const mdContent = session.formatAsMarkdown();
    return await this.toolCreateDocument({ filename: input.filename, content: mdContent, overwrite: true });
  }

  async executeTool(name, input) {
    switch (name) {
      case 'list_documents': return this.toolListDocuments();
      case 'grep_documents': return this.toolGrepDocuments(input);
      case 'view_document': return this.toolViewDocument(input);
      case 'web_search': return await this.toolWebSearch(input);
      case 'create_document': return await this.toolCreateDocument(input);
      case 'edit_document': return this.toolEditDocument(input);
      case 'convert_to_word': return await this.toolConvertToWord(input);
      case 'save_memory': return this.toolSaveMemory(input);
      case 'read_memory': return this.toolReadMemory(input);
      case 'list_memories': return this.toolListMemories(input);
      case 'save_session_history': return await this.toolSaveSessionHistory(input);
      default: return { error: `Unknown tool: ${name}` };
    }
  }

  documentStatus() {
    if (this._docIndex.size === 0) return `No documents cached. Say "ask ${this.agentName} read documents" to scan your files.`;
    const files = [...this._docIndex.values()].map(d => {
      const pg = d.pageCount ? ` (${d.pageCount} pages)` : '';
      return `  • \`${d.filename}\`${pg} — ${d.lineCount} lines [${d.docTypeGuess}]`;
    }).join('\n');
    return `📚 *${this.agentCap} Document Cache*\n${this._docIndex.size} file(s):\n${files}`;
  }
}

async function refreshAllManagers() {
  // Invalidate and reload the global main memory cache first
  _globalMemoryCache.content = null;
  loadGlobalMemoryCache();
  logger.info('[Global Memory] Cache refreshed.');

  const results = [];
  for (const manager of instances) {
    try {
      const summary = await manager.initTools();
      // summary format is multiple lines, get the second line (x files loaded)
      const lines = summary.split('\n');
      results.push(`• <b>${manager.agentCap}:</b> ${lines[1] || 'Reloaded'}`);
    } catch (err) {
      results.push(`• <b>${manager.agentCap}:</b> Failed (${err.message})`);
    }
  }
  return results.join('\n');
}

module.exports = { DocumentManager, refreshAllManagers };
