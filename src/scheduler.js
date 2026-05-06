'use strict';

const cron = require('node-cron');
const { AUTHORIZED_USER_ID } = require('./config');
const logger = require('./logger');

/**
 * Initialize all scheduled tasks for the agent.
 * @param {import('telegraf').Telegraf} bot - The bot instance to use for sending messages.
 */
function initScheduler(bot) {
  logger.info('Initializing scheduler...');

  // Task: Send "Good morning" every day at 9:00 AM
  // Cron format: minute hour day-of-month month day-of-week
  cron.schedule('0 9 * * *', async () => {
    logger.info('Running scheduled task: Morning Greeting');
    try {
      await bot.telegram.sendMessage(AUTHORIZED_USER_ID, '☀️ Good morning! I hope you have a great day. I am ready to help if you need anything.');
      logger.info('Morning greeting sent successfully.');
    } catch (err) {
      logger.error(`Failed to send morning greeting: ${err.message}`);
    }
  });

  logger.info('Daily 9:00 AM greeting task scheduled.');
}

module.exports = { initScheduler };
