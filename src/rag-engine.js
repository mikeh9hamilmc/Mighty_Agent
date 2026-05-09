'use strict';

/**
 * RAG Engine for the Legal sub-agent.
 *
 * Responsibilities:
 *  - Scan LEGAL_DATA_DIR for supported documents (PDF, DOCX, DOC, XLSX, XLS, TXT, MD)
 *  - Parse text from each file using pdf-parse / mammoth / xlsx
 *  - Split text into overlapping chunks (~500 tokens each)
 *  - Embed chunks with Voyage AI voyage-law-2 (legal-optimised model)
 *  - Persist the index to LEGAL_INDEX_FILE as JSON
 *  - Load the persisted index on startup (skip re-embedding unchanged files)
 *  - Retrieve top-K chunks for a query via cosine similarity
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LEGAL_DATA_DIR, LEGAL_INDEX_FILE, VOYAGE_API_KEY } = require('./config');
const logger = require('./logger');

// ─── Constants ────────────────────────────────────────────────────────────────

const CHUNK_SIZE    = 500;   // approximate tokens (we use words as proxy)
const CHUNK_OVERLAP = 60;    // words to overlap between chunks
const TOP_K         = 6;     // chunks returned per query

// ─── Voyage AI client (lazy) ──────────────────────────────────────────────────

let _voyageClient = null;

function getVoyageClient() {
  if (_voyageClient) return _voyageClient;
  if (!VOYAGE_API_KEY) {
    throw new Error('VOYAGE_API_KEY is not set. Add it to .env to enable RAG embeddings.');
  }
  const { VoyageAIClient } = require('voyageai');
  _voyageClient = new VoyageAIClient({ apiKey: VOYAGE_API_KEY });
  return _voyageClient;
}

// ─── In-memory index ──────────────────────────────────────────────────────────
// Structure: Map<filePath, { hash, source, chunks: [{text, embedding}] }>

let _index = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Split text into overlapping word-based chunks. */
function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push(words.slice(start, end).join(' '));
    if (end === words.length) break;
    start += chunkSize - overlap;
  }
  return chunks;
}

/** Cosine similarity between two embedding vectors. */
function cosine(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Text Extraction ──────────────────────────────────────────────────────────

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    let pdfParse = require('pdf-parse');
    // Handle both default export styles (CommonJS vs ESM interop)
    if (typeof pdfParse !== 'function' && pdfParse.default) pdfParse = pdfParse.default;
    const buf = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    return data.text;
  }

  if (ext === '.docx' || ext === '.doc') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(filePath);
    return wb.SheetNames
      .map(name => {
        const ws = wb.Sheets[name];
        return `[Sheet: ${name}]\n` + XLSX.utils.sheet_to_csv(ws);
      })
      .join('\n\n');
  }

  if (ext === '.txt' || ext === '.md') {
    return fs.readFileSync(filePath, 'utf-8');
  }

  return null; // unsupported type
}

// ─── Embedding ────────────────────────────────────────────────────────────────

/**
 * Embed an array of text strings using Voyage AI voyage-law-2.
 * Returns an array of float32 arrays.
 */
async function embedBatch(texts) {
  const client = getVoyageClient();
  const response = await client.embed({
    input: texts,
    model: 'voyage-law-2',
    inputType: 'document',
  });
  // Voyage AI SDK returns { data: [{ embedding: [...] }, ...] }
  return response.data.map(d => d.embedding);
}

async function embedQuery(text) {
  const client = getVoyageClient();
  const response = await client.embed({
    input: [text],
    model: 'voyage-law-2',
    inputType: 'query',
  });
  return response.data[0].embedding;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function saveIndex() {
  const serialisable = [];
  for (const [filePath, entry] of _index.entries()) {
    serialisable.push({ filePath, ...entry });
  }
  fs.mkdirSync(path.dirname(LEGAL_INDEX_FILE), { recursive: true });
  fs.writeFileSync(LEGAL_INDEX_FILE, JSON.stringify(serialisable, null, 2), 'utf-8');
  logger.info(`[RAG] Index saved: ${serialisable.length} file(s).`);
}

function loadIndex() {
  if (!fs.existsSync(LEGAL_INDEX_FILE)) {
    logger.info('[RAG] No persisted index found, starting fresh.');
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(LEGAL_INDEX_FILE, 'utf-8'));
    _index = new Map(data.map(entry => {
      const { filePath, ...rest } = entry;
      return [filePath, rest];
    }));
    const totalChunks = [..._index.values()].reduce((s, e) => s + e.chunks.length, 0);
    logger.info(`[RAG] Loaded persisted index: ${_index.size} file(s), ${totalChunks} chunks.`);
  } catch (err) {
    logger.warn(`[RAG] Failed to load persisted index: ${err.message}. Starting fresh.`);
    _index = new Map();
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan LEGAL_DATA_DIR, parse + embed any new or changed files.
 * Skips files whose SHA-256 hash matches the stored hash.
 * Returns a summary string.
 */
async function indexDocuments() {
  if (!fs.existsSync(LEGAL_DATA_DIR)) {
    fs.mkdirSync(LEGAL_DATA_DIR, { recursive: true });
    return '📂 legal/data/ folder created but is empty. Drop your documents in and run "ask legal read documents" again.';
  }

  const SUPPORTED = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.txt', '.md']);
  const EXCLUDED   = new Set(['readme.md']); // never index meta/documentation files
  const files = fs.readdirSync(LEGAL_DATA_DIR)
    .filter(f => {
      const ext  = path.extname(f).toLowerCase();
      const base = f.toLowerCase();
      return SUPPORTED.has(ext) && !EXCLUDED.has(base) && !f.startsWith('.');
    })
    .map(f => path.join(LEGAL_DATA_DIR, f));

  if (files.length === 0) {
    return '📂 No supported documents found in legal/data/. Supported: PDF, DOCX, XLSX, TXT, MD.';
  }

  let added = 0, skipped = 0, failed = 0;
  const newFiles = [];

  for (const filePath of files) {
    const hash = fileHash(filePath);
    const existing = _index.get(filePath);
    if (existing && existing.hash === hash) {
      skipped++;
      continue;
    }

    try {
      logger.info(`[RAG] Processing: ${path.basename(filePath)}`);
      const text = await extractText(filePath);
      if (!text || text.trim().length < 50) {
        logger.warn(`[RAG] Skipping (too short / unreadable): ${path.basename(filePath)}`);
        failed++;
        continue;
      }

      const chunks = chunkText(text.trim());
      logger.info(`[RAG] ${path.basename(filePath)}: ${chunks.length} chunks, embedding...`);

      // Embed in batches of 8 (Voyage AI limit per request is 128, but keep batches small)
      const embeddings = [];
      const BATCH = 8;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = await embedBatch(chunks.slice(i, i + BATCH));
        embeddings.push(...batch);
      }

      _index.set(filePath, {
        hash,
        source: path.basename(filePath),
        chunks: chunks.map((text, i) => ({ text, embedding: embeddings[i] })),
      });

      newFiles.push(path.basename(filePath));
      added++;
    } catch (err) {
      logger.error(`[RAG] Failed to process ${path.basename(filePath)}: ${err.message}`);
      failed++;
    }
  }

  // Remove stale entries (files that were deleted)
  const fileSet = new Set(files);
  for (const key of _index.keys()) {
    if (!fileSet.has(key)) {
      _index.delete(key);
      logger.info(`[RAG] Removed stale entry: ${key}`);
    }
  }

  saveIndex();

  const totalChunks = [..._index.values()].reduce((s, e) => s + e.chunks.length, 0);
  const lines = [
    `✅ RAG index updated.`,
    `📄 Files indexed: ${_index.size} (${added} new/updated, ${skipped} unchanged, ${failed} failed)`,
    `🧩 Total chunks: ${totalChunks}`,
  ];
  if (newFiles.length > 0) lines.push(`\nNewly indexed:\n${newFiles.map(f => `  • ${f}`).join('\n')}`);
  return lines.join('\n');
}

/**
 * Retrieve the top-K most relevant chunks for a query.
 * Returns an array of { source, text, score } objects.
 */
async function retrieve(query, k = TOP_K) {
  const totalChunks = [..._index.values()].reduce((s, e) => s + e.chunks.length, 0);
  if (totalChunks === 0) {
    return [];
  }

  const qEmb = await embedQuery(query);

  const scored = [];
  for (const entry of _index.values()) {
    for (const chunk of entry.chunks) {
      scored.push({
        source: entry.source,
        text: chunk.text,
        score: cosine(qEmb, chunk.embedding),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** Return a quick status string about the current index state. */
function indexStatus() {
  const fileCount = _index.size;
  const totalChunks = [..._index.values()].reduce((s, e) => s + e.chunks.length, 0);
  if (fileCount === 0) {
    return 'No documents indexed yet. Say "ask legal read documents" to index your files.';
  }
  const files = [..._index.values()].map(e => `  • ${e.source} (${e.chunks.length} chunks)`).join('\n');
  return `📚 *Legal RAG Index*\n${fileCount} file(s), ${totalChunks} total chunks:\n${files}`;
}

// Load any persisted index at module load time
loadIndex();

module.exports = { indexDocuments, retrieve, indexStatus };
