const fs = require('fs');
const path = require('path');
const { DocumentManager, getManager, getAllManagers } = require('../src/document-tools.js');
const { SKILLS_DIR } = require('../src/config.js');

describe('Document Upload & Download Exchange System', () => {
  const mainManager = new DocumentManager('main');
  const legalManager = new DocumentManager('legal');

  const testMdFile = 'test_upload_contract.md';
  const testSubAgentFile = 'test_legal_brief.txt';

  let sentDocuments = [];

  beforeAll(async () => {
    // Ensure directories exist
    if (!fs.existsSync(mainManager.dataDir)) fs.mkdirSync(mainManager.dataDir, { recursive: true });
    if (!fs.existsSync(legalManager.dataDir)) fs.mkdirSync(legalManager.dataDir, { recursive: true });

    // Configure mock Telegram sender
    sentDocuments = [];
    DocumentManager.setTelegramSender(async (filePath, filename) => {
      sentDocuments.push({ filePath, filename });
      return { message_id: 999 };
    });

    await mainManager.ensureInitialized();
    await legalManager.ensureInitialized();
  });

  afterAll(() => {
    // Clean up test files
    const mainFile = path.join(mainManager.dataDir, testMdFile);
    const legalFile = path.join(legalManager.dataDir, testSubAgentFile);

    if (fs.existsSync(mainFile)) fs.unlinkSync(mainFile);
    if (fs.existsSync(legalFile)) fs.unlinkSync(legalFile);
  });

  test('getManager and getAllManagers retrieve registered singletons', () => {
    const mgr = getManager('main');
    expect(mgr).toBeDefined();
    expect(mgr.agentName).toBe('main');

    const legal = getManager('legal');
    expect(legal).toBeDefined();
    expect(legal.agentName).toBe('legal');

    const all = getAllManagers();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test('saveUploadedDocument saves file to target data folder and updates index', async () => {
    const content = '# Contract Agreement\nThis is an agreement for testing document submission.';
    const buffer = Buffer.from(content, 'utf-8');

    const result = await mainManager.saveUploadedDocument(testMdFile, buffer);

    expect(result.filename).toBe(testMdFile);
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.readFileSync(result.filePath, 'utf-8')).toBe(content);

    // Verify file is indexed in document cache
    const docList = mainManager.toolListDocuments();
    const foundInList = docList.files.some(f => f.filename === testMdFile);
    expect(foundInList).toBe(true);
  });

  test('findDocument finds exact, case-insensitive, and partial matches', () => {
    // Exact match
    const exact = mainManager.findDocument(testMdFile);
    expect(exact.found).toBe(true);
    expect(exact.filename).toBe(testMdFile);
    expect(exact.agentName).toBe('main');

    // Case-insensitive match
    const caseMatch = mainManager.findDocument(testMdFile.toUpperCase());
    expect(caseMatch.found).toBe(true);
    expect(caseMatch.filename).toBe(testMdFile);

    // Partial match
    const partial = mainManager.findDocument('upload_contract');
    expect(partial.found).toBe(true);
    expect(partial.filename).toBe(testMdFile);
  });

  test('findDocument falls back to search other agent data folders', async () => {
    // Save a file into legal data folder
    const legalContent = 'Legal Brief: Texas Common-Law Marriage Analysis';
    const buffer = Buffer.from(legalContent, 'utf-8');
    await legalManager.saveUploadedDocument(testSubAgentFile, buffer);

    // Query from mainManager should find the legal document via cross-agent fallback
    const crossMatch = mainManager.findDocument(testSubAgentFile);
    expect(crossMatch.found).toBe(true);
    expect(crossMatch.filename).toBe(testSubAgentFile);
    expect(crossMatch.agentName).toBe('legal');
  });

  test('toolSendDocument sends document via registered Telegram sender', async () => {
    sentDocuments = [];

    const sendResult = await mainManager.toolSendDocument({ filename: testMdFile });
    expect(sendResult.success).toBe(true);
    expect(sendResult.filename).toBe(testMdFile);

    expect(sentDocuments.length).toBe(1);
    expect(sentDocuments[0].filename).toBe(testMdFile);
    expect(fs.existsSync(sentDocuments[0].filePath)).toBe(true);
  });

  test('toolSendDocument returns friendly error when document does not exist', async () => {
    const sendResult = await mainManager.toolSendDocument({ filename: 'non_existent_file_98765.pdf' });
    expect(sendResult.error).toBeDefined();
    expect(sendResult.error).toContain('non_existent_file_98765.pdf');
  });

  test('executeTool handles send_document action', async () => {
    sentDocuments = [];

    const result = await mainManager.executeTool('send_document', { filename: testMdFile });
    expect(result.success).toBe(true);
    expect(sentDocuments.length).toBe(1);
  });

  test('moveDocument transfers a file from one agent to another and re-indexes', async () => {
    // testMdFile currently in mainManager
    expect(fs.existsSync(path.join(mainManager.dataDir, testMdFile))).toBe(true);

    const moveRes = await mainManager.moveDocument(testMdFile, legalManager);
    expect(moveRes.success).toBe(true);
    expect(moveRes.toAgent).toBe('legal');

    // Should no longer exist in main
    expect(fs.existsSync(path.join(mainManager.dataDir, testMdFile))).toBe(false);
    // Should exist in legal
    expect(fs.existsSync(path.join(legalManager.dataDir, testMdFile))).toBe(true);

    // Document index in legal should have it
    const searchInLegal = legalManager.findDocument(testMdFile);
    expect(searchInLegal.found).toBe(true);
    expect(searchInLegal.agentName).toBe('legal');
  });
});

