'use strict';

const { CronJob } = require('cron');
const { AUTHORIZED_USER_ID } = require('./config');
const logger = require('./logger');
const { runSkill } = require('./executor');
const { SKILLS } = require('./llm');

function isSkillEnabled(name) {
  return SKILLS.some(s => s.name === name);
}

/**
 * Initialize all scheduled tasks for the agent.
 * @param {import('telegraf').Telegraf} bot - The bot instance to use for sending messages.
 */
function initScheduler(bot) {
  logger.info('Initializing scheduler...');

  // Task: Send "Good morning" (using good-morning skill) every day at 9:00 AM
  new CronJob('0 9 * * *', async () => {
    if (!isSkillEnabled('good-morning')) {
      logger.info('[Scheduler] Skipping good-morning: skill is disabled.');
      return;
    }
    logger.info('Running scheduled task: Morning Greeting');
    try {
      const { output } = await runSkill('good-morning');
      await bot.telegram.sendMessage(AUTHORIZED_USER_ID, output, { parse_mode: 'Markdown' });
      logger.info('Morning greeting skill executed successfully.');
    } catch (err) {
      logger.error('Failed to execute morning greeting skill: ' + err.message);
    }
  }).start();

  // Task: Run "dip-buy" every hour from 4:00 AM to 8:00 PM on weekdays.
  // Guard prevents overlapping runs if a previous execution is still in progress.
  let dipBuyRunning = false;
  new CronJob('0 4-20 * * 1-5', async () => {
    if (!isSkillEnabled('dip-buy')) {
      logger.info('[Scheduler] Skipping dip-buy: skill is disabled.');
      return;
    }
    if (dipBuyRunning) {
      logger.warn('[Scheduler] Skipping dip-buy: previous run still in progress.');
      return;
    }
    dipBuyRunning = true;
    logger.info('Running scheduled task: Hourly Dip-Buy Check');
    try {
      const { output } = await runSkill('dip-buy', ['--silent']);
      if (output && output.trim().length > 0) {
        await bot.telegram.sendMessage(AUTHORIZED_USER_ID, output, { parse_mode: 'Markdown' });
        logger.info('Dip-buy skill output sent to user.');
      }
    } catch (err) {
      logger.error('Failed to execute dip-buy skill: ' + err.message);
    } finally {
      dipBuyRunning = false;
    }
  }).start();

  logger.info('Scheduled tasks initialized (9 AM Greeting, Hourly Weekday Dip-Buy).');
}

module.exports = { initScheduler };
