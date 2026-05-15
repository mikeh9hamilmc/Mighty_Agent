require('dotenv').config();
const { runTravelAgent } = require('./src/travel-agent');

async function test() {
  console.log("Asking travel agent...");
  const result = await runTravelAgent(
    "how many islands are in the galapagos",
    (chunk) => process.stdout.write(chunk),
    (status) => console.log("\n[Status] " + status),
    []
  );
  console.log("\n\nResult:\n", result);
}
test().catch(console.error);
