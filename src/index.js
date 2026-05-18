const bot = require('./bot');
const { syncTelegramCommands } = require('./bot');
const { initScheduler } = require('./scheduler');
const logger = require('./logger');

// Import the singleton DocumentManager instances from each agent module.
// This avoids creating duplicate instances which would cause double-refresh.
const { legalTools }   = require('./legal-agent');
const { medicalTools } = require('./medical-agent');
const { financeTools } = require('./finance-agent');
const { coderTools }   = require('./coder-agent');
const { travelTools }  = require('./travel-agent');
const { beautyTools }  = require('./beauty-agent');
const { mainDocs }     = require('./llm');

async function main() {
  logger.info('Starting Mighty Agent...');

  // Pre-warm document caches in background (non-blocking).
  Promise.all([
    legalTools.ensureInitialized(),
    medicalTools.ensureInitialized(),
    financeTools.ensureInitialized(),
    coderTools.ensureInitialized(),
    travelTools.ensureInitialized(),
    beautyTools.ensureInitialized(),
    mainDocs.ensureInitialized(),
  ]).then(() => {
    logger.info('Document caches pre-warmed for all agents.');
  }).catch(err => {
    logger.error('Failed to pre-warm caches: ' + err.message);
  });

  // Graceful shutdown
  process.once('SIGINT', () => {
    logger.info('SIGINT received. Shutting down...');
    bot.stop('SIGINT');
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    logger.info('SIGTERM received. Shutting down...');
    bot.stop('SIGTERM');
    process.exit(0);
  });

  initScheduler(bot);
  await bot.launch();
  logger.info('Bot is online and listening for messages.');
  // Sync command menu with Telegram on every startup
  await syncTelegramCommands();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
