const { decideAction } = require('../src/llm.js');
const fs = require('fs');
const path = require('path');
const { DocumentManager } = require('../src/document-tools.js');
const { SKILLS_DIR } = require('../src/config.js');

jest.setTimeout(60000); // Allow up to 60s for real API calls

// Helper to wait
const delay = ms => new Promise(r => setTimeout(r, ms));

jest.mock('node-fetch', () => {
  return jest.fn((url, options) => {
    if (process.env.MOCK_API === 'false') {
      const actualFetch = jest.requireActual('node-fetch');
      return actualFetch(url, options);
    }
    
    if (url.includes('api.search.brave.com')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          web: {
            results: [
              { title: 'Weather in London', description: 'Rainy', url: 'https://weather.com/london' }
            ]
          }
        })
      });
    }

    const payload = JSON.parse(options.body);
    const userPrompt = payload.messages[payload.messages.length - 1]?.content || '';
    
    let responseMessage = {
      role: 'assistant',
      content: 'This is a mocked answer from the Main Agent.'
    };

    if (userPrompt.includes('weather in London')) {
      responseMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_123',
          type: 'function',
          function: {
            name: 'web_search',
            arguments: JSON.stringify({ query: 'weather in London' })
          }
        }]
      };
    } else if (payload.messages.some(m => m.role === 'tool' && m.name === 'web_search')) {
      // Second loop after web_search
      responseMessage = {
        role: 'assistant',
        content: 'The weather in London is rainy, as usual.'
      };
    }

    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        choices: [{
          message: responseMessage
        }]
      })
    });
  });
});

describe('Test 1: User asks main agent a question', () => {
  let originalEnv;

  beforeAll(() => {
    originalEnv = process.env.MOCK_API;
    process.env.MOCK_API = process.env.MOCK_API || 'true'; 
    
    // Setup a mock memory file
    const memoryDir = path.resolve(SKILLS_DIR, 'main', 'memory');
    if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'test_memory.md'), 'The secret password is "OpenSesame".');
  });

  afterAll(() => {
    process.env.MOCK_API = originalEnv;
    // Cleanup mock memory
    const memoryDir = path.resolve(SKILLS_DIR, 'main', 'memory');
    if (fs.existsSync(path.join(memoryDir, 'test_memory.md'))) {
      fs.unlinkSync(path.join(memoryDir, 'test_memory.md'));
    }
  });

  test('Main Agent receives memory in system prompt', async () => {
    const fetchMock = require('node-fetch');
    fetchMock.mockClear();

    const history = [];
    const question = 'What is the secret password?';

    const result = await decideAction(question, () => {}, history);
    console.log(`\n[Test] Question: ${question}\n[Test] Response: ${result.text || result.reply || 'N/A'}\n`);

    expect(fetchMock).toHaveBeenCalled();
    const callArgs = fetchMock.mock.calls[0];
    const payload = JSON.parse(callArgs[1].body);
    
    const systemMsg = payload.messages[0];
    expect(systemMsg.role).toBe('system');
    expect(systemMsg.content).toContain('The secret password is "OpenSesame".');
  });

  test('Main Agent receives Session history', async () => {
    const fetchMock = require('node-fetch');
    fetchMock.mockClear();

    const history = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' }
    ];
    const question = 'What did I just say?';

    const result = await decideAction(question, () => {}, history);
    console.log(`\n[Test] Question: ${question}\n[Test] Response: ${result.text || result.reply || 'N/A'}\n`);

    const callArgs = fetchMock.mock.calls[0];
    const payload = JSON.parse(callArgs[1].body);
    
    const historyMsg = payload.messages[1];
    expect(historyMsg.role).toBe('user');
    expect(historyMsg.content).toBe('Hello');
  });

  test('Main Agent executes Web Search when required', async () => {
    const fetchMock = require('node-fetch');
    fetchMock.mockClear();

    const history = [];
    const question = 'What is the weather in London?';

    const result = await decideAction(question, () => {}, history);
    console.log(`\n[Test] Question: ${question}\n[Test] Response: ${result.text || 'N/A'}\n`);

    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 for OR query, 1 for Brave, 1 after tool execution
    
    // Check initial payload
    const payload1 = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload1.messages[payload1.messages.length - 1].content).toBe(question);

    // Check payload after tool execution (it is the 3rd fetch call)
    const payload2 = JSON.parse(fetchMock.mock.calls[2][1].body);
    const toolMsg = payload2.messages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.name).toBe('web_search');
    
    // Check final agent response
    expect(result.type).toBe('reply');
    if (process.env.MOCK_API === 'false') {
      expect(typeof result.text).toBe('string');
    } else {
      expect(result.text).toBe('The weather in London is rainy, as usual.');
    }
  });
});
