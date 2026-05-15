require('dotenv').config();
const { runTravelAgent } = require('./src/travel-agent');

async function test() {
  console.log("Testing with isStatusCommand...");
  const msg = "how many islands are in the galapagos";
  
  // Re-run the exact regex from travel-agent.js
  const isStatus = /\b(status|what.*loaded|documents.*loaded|index.*status|what files)\b/i.test(msg) ||
    (/\bhow many\b/i.test(msg) && /\b(documents|docs|files|loaded)\b/i.test(msg));
  console.log("isStatus:", isStatus);
}
test().catch(console.error);
