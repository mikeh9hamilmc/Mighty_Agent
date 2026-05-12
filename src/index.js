'use strict';

const bot = require('./bot');
const { initScheduler } = require('./scheduler');
const { DocumentManager } = require('./document-tools');
const logger = require('./logger');

async function main() {
  logger.info('Starting Mini OpenClaw Agent...');

  // Pre-warm document caches in background (non-blocking).
  const legalTools = new DocumentManager('legal');
  legalTools.initTools()
    .then(summary => {
      const line2 = summary.split('\n')[1] || 'ready';
      logger.info(`[Legal Tools] Startup: ${line2}`);
    })
    .catch(err => logger.warn(`[Legal Tools] Startup cache warning: ${err.message}`));

  const medicalTools = new DocumentManager('medical');
  medicalTools.initTools()
    .then(summary => {
      const line2 = summary.split('\n')[1] || 'ready';
      logger.info(`[Medical Tools] Startup: ${line2}`);
    })
    .catch(err => logger.warn(`[Medical Tools] Startup cache warning: ${err.message}`));

  const financeTools = new DocumentManager('finance');
  financeTools.initTools()
    .then(summary => {
      const line2 = summary.split('\n')[1] || 'ready';
      logger.info(`[Finance Tools] Startup: ${line2}`);
    })
    .catch(err => logger.warn(`[Finance Tools] Startup cache warning: ${err.message}`));

  const coderTools = new DocumentManager('coder');
  coderTools.initTools()
    .then(summary => {
      const line2 = summary.split('\n')[1] || 'ready';
      logger.info(`[Coder Tools] Startup: ${line2}`);
    })
    .catch(err => logger.warn(`[Coder Tools] Startup cache warning: ${err.message}`));

  const mainTools = new DocumentManager('main');
  mainTools.initTools()
    .then(summary => {
      const line2 = summary.split('\n')[1] || 'ready';
      logger.info(`[Main Tools] Startup: ${line2}`);
    })
    .catch(err => logger.warn(`[Main Tools] Startup cache warning: ${err.message}`));

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
