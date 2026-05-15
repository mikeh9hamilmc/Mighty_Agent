const fs = require('fs');
const path = require('path');
const { decideAction } = require('../src/llm.js');
const { runLegalAgent } = require('../src/legal-agent.js');
const { runFinanceAgent } = require('../src/finance-agent.js');
const { SKILLS_DIR } = require('../src/config.js');
const { DocumentManager } = require('../src/document-tools.js');

jest.setTimeout(60000);

// Global Setup/Teardown for all tests
let originalEnv;
const mainMemoryDir = path.resolve(SKILLS_DIR, 'main', 'memory');
const legalMemoryDir = path.resolve(SKILLS_DIR, 'legal', 'memory');
const mainDataDir = path.resolve(SKILLS_DIR, 'main', 'data');
const legalDataDir = path.resolve(SKILLS_DIR, 'legal', 'data');

beforeAll(() => {
  originalEnv = process.env.MOCK_API;
  process.env.MOCK_API = process.env.MOCK_API || 'true';
  
  [mainMemoryDir, legalMemoryDir, mainDataDir, legalDataDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  // Test 2 setup: create memory files
  fs.writeFileSync(path.join(mainMemoryDir, 'global_test.md'), 'Global fact: User likes cats.');
  fs.writeFileSync(path.join(legalMemoryDir, 'legal_test.md'), 'Legal fact: User lives in Texas.');
  
  // Test 7 setup: local data
  fs.writeFileSync(path.join(mainDataDir, 'personal_records.md'), 'My personal record ID is 12345.');
});

afterAll(() => {
  process.env.MOCK_API = originalEnv;
  // Cleanup test files
  const filesToDelete = [
    path.join(mainMemoryDir, 'global_test.md'),
    path.join(legalMemoryDir, 'legal_test.md'),
    path.join(mainDataDir, 'personal_records.md'),
    path.join(mainDataDir, 'session_log.md'),
    path.join(legalDataDir, 'session_log.md'),
    path.join(mainMemoryDir, 'test-topic.md'),
    path.join(legalMemoryDir, 'legal-topic.md')
  ];
  
  filesToDelete.forEach(file => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
});

jest.mock('node-fetch', () => {
  return jest.fn((url, options) => {
    if (process.env.MOCK_API === 'false') {
      const actualFetch = jest.requireActual('node-fetch');
      return actualFetch(url, options);
    }
    
    if (url.includes('api.search.brave.com')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ web: { results: [{ title: 'Mock Result', description: 'Mock Description' }] } })
      });
    }

    const payload = JSON.parse(options.body);
    const userPrompt = payload.messages[payload.messages.length - 1]?.content || '';
    
    let responseMessage = { role: 'assistant', content: 'Mocked generic response.' };

    if (userPrompt.includes('what is the update on my case')) {
      responseMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_2', type: 'function',
          function: { name: 'web_search', arguments: JSON.stringify({ query: 'texas family code status' }) }
        }]
      };
    } else if (payload.messages.some(m => m.role === 'tool' && m.name === 'web_search')) {
      responseMessage = { role: 'assistant', content: 'Web search completed.' };
    } else if (userPrompt.includes('save session for main')) {
      responseMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_3', type: 'function',
          function: { name: 'save_session_history', arguments: JSON.stringify({ filename: 'session_log.md' }) }
        }]
      };
    } else if (payload.messages.some(m => m.role === 'tool' && m.name === 'save_session_history')) {
       responseMessage = { role: 'assistant', content: 'Session saved.' };
    } else if (userPrompt.includes('save session for legal')) {
      responseMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_4', type: 'function',
          function: { name: 'save_session_history', arguments: JSON.stringify({ filename: 'session_log.md' }) }
        }]
      };
    } else if (userPrompt.includes('save main memory')) {
      responseMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_5', type: 'function',
          function: { name: 'save_memory', arguments: JSON.stringify({ topic: 'test-topic', content: 'test content' }) }
        }]
      };
    } else if (payload.messages.some(m => m.role === 'tool' && m.name === 'save_memory')) {
       responseMessage = { role: 'assistant', content: 'Memory saved.' };
    } else if (userPrompt.includes('save legal memory')) {
      responseMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_6', type: 'function',
          function: { name: 'save_memory', arguments: JSON.stringify({ topic: 'legal-topic', content: 'legal test content' }) }
        }]
      };
    } else if (userPrompt.includes('my personal record')) {
      responseMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_7', type: 'function',
          function: { name: 'grep_documents', arguments: JSON.stringify({ pattern: '12345' }) }
        }]
      };
    } else if (payload.messages.some(m => m.role === 'tool' && m.name === 'grep_documents')) {
       responseMessage = { role: 'assistant', content: 'Grep completed. Record is 12345.' };
    }

    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: responseMessage }] })
    });
  });
});

describe('Mighty Agent Test Suite', () => {
  
  test('Test 2: Legal Agent receives global and local memory, session history, and executes web_search', async () => {
    const fetchMock = require('node-fetch');
    fetchMock.mockClear();

    const history = [{ role: 'user', content: 'Initial question' }];
    const question = 'what is the update on my case';

    await runLegalAgent(question, () => {}, () => {}, history);

    expect(fetchMock).toHaveBeenCalled();
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    
    const systemPrompt = payload.messages[0].content;
    expect(systemPrompt).toContain('Global fact: User likes cats.');
    expect(systemPrompt).toContain('Legal fact: User lives in Texas.');
    
    const historyMsg = payload.messages[1];
    expect(historyMsg.content).toBe('Initial question');

    const toolMsg = JSON.parse(fetchMock.mock.calls[2][1].body).messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.name).toBe('web_search');
  });

  test('Test 3: Direct Skill Execution via executor (simulated)', async () => {
    // Test the executor.runSkill function directly without mocking spawn
    // This proves the executor successfully spawns the local Python script
    const { runSkill } = require('../src/executor.js');
    
    const result = await runSkill('date_time', []);
    
    expect(result.exitCode).toBe(0);
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });

  test('Test 4: Main Agent Session Save', async () => {
    const fetchMock = require('node-fetch');
    fetchMock.mockClear();

    await decideAction('save session for main', () => {}, []);
    
    expect(fs.existsSync(path.join(mainDataDir, 'session_log.md'))).toBe(true);
  });

  test('Test 5: Sub-Agent Session Save', async () => {
    const fetchMock = require('node-fetch');
    fetchMock.mockClear();

    await runLegalAgent('save session for legal', () => {}, () => {}, []);
    
    expect(fs.existsSync(path.join(legalDataDir, 'session_log.md'))).toBe(true);
  });

  test('Test 6: Memory Storage Routing', async () => {
    const fetchMock = require('node-fetch');
    fetchMock.mockClear();

    // Main memory
    await decideAction('save main memory', () => {}, []);
    expect(fs.existsSync(path.join(mainMemoryDir, 'test-topic.md'))).toBe(true);

    // Legal memory
    await runLegalAgent('save legal memory', () => {}, () => {}, []);
    expect(fs.existsSync(path.join(legalMemoryDir, 'legal-topic.md'))).toBe(true);
  });

  test('Test 7: Local Data Priority (No Web Search)', async () => {
    const fetchMock = require('node-fetch');
    fetchMock.mockClear();

    await decideAction('my personal record', () => {}, []);

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const systemPrompt = payload.messages[0].content;
    
    // Assert strictly no web search tool call in the flow
    const allCalls = fetchMock.mock.calls;
    allCalls.forEach(call => {
      const callBody = JSON.parse(call[1].body);
      const toolCall = callBody.messages.find(m => m.role === 'assistant' && m.tool_calls);
      if (toolCall) {
        expect(toolCall.tool_calls[0].function.name).not.toBe('web_search');
      }
    });
  });

});
