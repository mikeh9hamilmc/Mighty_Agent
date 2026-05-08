'use strict';

const bot = require('./bot');
const { initScheduler } = require('./scheduler');
const logger = require('./logger');

async function main() {
  logger.info('Starting Mini OpenClaw Agent...');

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
