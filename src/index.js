'use strict';

const bot = require('./bot');
const { initScheduler } = require('./scheduler');
const { DocumentManager } = require('./document-tools');
const logger = require('./logger');

async function main() {
  logger.info('Starting Mighty Agent...');

  // Pre-warm document caches in background (non-blocking).
  const legalTools = new DocumentManager('legal');
  const medicalTools = new DocumentManager('medical');
  const financeTools = new DocumentManager('finance');

  const coderTools = new DocumentManager('coder');
  const travelTools = new DocumentManager('travel');
  const mainTools = new DocumentManager('main');

  Promise.all([
    legalTools.initTools(),
    medicalTools.initTools(),
    financeTools.initTools(),
    coderTools.initTools(),
    travelTools.initTools(),
    mainTools.initTools()
  ]).then(() => {
    logger.info('Document caches pre-warmed for all agents.');
  }).catch(err => {
    logger.error('Failed to pre-warm caches: ' + err.message);
  });

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
