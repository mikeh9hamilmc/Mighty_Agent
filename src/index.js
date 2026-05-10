'use strict';

const bot = require('./bot');
const { initScheduler } = require('./scheduler');
const { initLegalTools } = require('./legal-tools');
const logger = require('./logger');

async function main() {
  logger.info('Starting Mini OpenClaw Agent...');

  // Pre-warm legal document cache in background (non-blocking).
  // By the time the first query arrives the cache will already be populated.
  initLegalTools()
    .then(summary => {
      const line2 = summary.split('\n')[1] || 'ready';
      logger.info(`[Legal Tools] Startup: ${line2}`);
    })
    .catch(err => logger.warn(`[Legal Tools] Startup cache warning: ${err.message}`));

  // Graceful shutdown
  process.once('SIGINT', () => {
    logger.info('SIGINT received. Shutting down...');
    bot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    logger.info('SIGTERM received. Shutting down...');
    bot.stop('SIGTERM');
  });

  initScheduler(bot);
  await bot.launch();
  logger.info('Bot is online and listening for messages.');
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
