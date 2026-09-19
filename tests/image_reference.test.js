const fs = require('fs');
const path = require('path');
const session = require('../src/session');
const { SKILLS_DIR } = require('../src/config');

describe('Conversational Image Reference Support', () => {
  beforeEach(() => {
    session.clear();
  });

  afterEach(() => {
    session.clear();
  });

  test('SessionManager stores multimodal messages with image_url and text', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const userContent = [
      { type: 'text', text: 'Can you analyze this diagram?' },
      { type: 'image_url', image_url: { url: dataUrl } }
    ];

    session.addMessage('user', userContent);
    session.addMessage('assistant', 'This diagram shows a simple logic gate circuit.');

    const history = session.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].role).toBe('user');
    expect(Array.isArray(history[0].content)).toBe(true);
    expect(history[0].content[0].text).toBe('Can you analyze this diagram?');
    expect(history[0].content[1].image_url.url).toBe(dataUrl);

    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('This diagram shows a simple logic gate circuit.');
  });

  test('formatAsMarkdown cleanly renders multimodal content without [object Object]', () => {
    const dataUrl = 'data:image/jpeg;base64,dummybase64string';
    const userContent = [
      { type: 'text', text: 'What is this skin rash?' },
      { type: 'image_url', image_url: { url: dataUrl } }
    ];

    session.addMessage('user', userContent);
    session.addMessage('assistant', 'The image appears to show contact dermatitis.');

    const md = session.formatAsMarkdown();
    expect(md).not.toContain('[object Object]');
    expect(md).toContain('What is this skin rash?');
    expect(md).toContain('[Image attached for reference]');
    expect(md).toContain('The image appears to show contact dermatitis.');
  });

  test('Preserves image reference across multiple follow-up conversation turns', () => {
    const dataUrl = 'data:image/png;base64,sampleimage';
    
    // Turn 1: User uploads image with prompt
    session.addMessage('user', [
      { type: 'text', text: 'Analyze this chart.' },
      { type: 'image_url', image_url: { url: dataUrl } }
    ]);
    session.addMessage('assistant', 'The chart indicates an upward trend in Q3.');

    // Turn 2: Follow-up question without re-uploading image
    session.addMessage('user', 'What was the peak percentage in that chart?');
    session.addMessage('assistant', 'The peak in Q3 reached 42%.');

    const history = session.getHistory();
    expect(history.length).toBe(4);

    // Initial image is still retained in history[0]
    expect(history[0].content[1].image_url.url).toBe(dataUrl);
    // Follow-up question is in history[2]
    expect(history[2].content).toBe('What was the peak percentage in that chart?');
  });

  test('Session clear wipes image reference and history', () => {
    session.addMessage('user', [
      { type: 'text', text: 'Look at this.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
    ]);
    expect(session.getHistory().length).toBe(1);

    session.clear();
    expect(session.getHistory().length).toBe(0);
    expect(session.formatAsMarkdown()).toContain('No conversation history');
  });

  test('Images are not written to data or memory folders of any agent', () => {
    const agents = ['main', 'legal', 'medical', 'finance', 'beauty', 'travel', 'coder'];
    
    // Check all agent data and memory folders to ensure no image files (.png, .jpg, .jpeg) exist
    for (const agent of agents) {
      const dataDir = path.join(SKILLS_DIR, agent, 'data');
      const memDir = path.join(SKILLS_DIR, agent, 'memory');

      if (fs.existsSync(dataDir)) {
        const dataFiles = fs.readdirSync(dataDir).filter(f => /\.(png|jpe?g)$/i.test(f));
        expect(dataFiles.length).toBe(0);
      }

      if (fs.existsSync(memDir)) {
        const memFiles = fs.readdirSync(memDir).filter(f => /\.(png|jpe?g)$/i.test(f));
        expect(memFiles.length).toBe(0);
      }
    }
  });
});
