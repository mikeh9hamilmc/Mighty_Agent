require('dotenv').config();
const { decideAction } = require('./src/llm.js');
const session = require('./src/session.js');

async function testMainAgent() {
  console.log("Starting Main Agent Test...");
  const question = "What is the weather in London?";
  
  // Create a fake history
  session.addMessage('user', 'Hello');
  session.addMessage('assistant', 'Hi there! How can I help you?');
  
  console.log("Question:", question);
  
  // Run decideAction
  const result = await decideAction(
    question,
    (chunk) => process.stdout.write(chunk),
    session.getHistory()
  );
  
  console.log("\n\nFinal Result:", result);
}

testMainAgent().catch(console.error);
