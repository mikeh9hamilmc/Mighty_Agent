'use strict';

const { Telegraf } = require('telegraf');
const { TELEGRAM_TOKEN, AUTHORIZED_USER_ID } = require('./config');
const { runSkill } = require('./executor');
const { decideAction, SKILLS, ALL_SKILLS } = require('./llm');
const { runCoderAgent } = require('./coder-agent');
const { runLegalAgent } = require('./legal-agent');
const { runMedicalAgent } = require('./medical-agent');
const { runFinanceAgent } = require('./finance-agent');
const { runTravelAgent } = require('./travel-agent');
const logger = require('./logger');

const bot = new Telegraf(TELEGRAM_TOKEN);
const startTime = Date.now();

// ─── API Error Formatter ────────────────────────────────────────────────────
/**
 * Convert raw API errors into user-friendly Telegram messages.
 * Handles known conditions (low credits, rate limits) gracefully.
 */
function formatApiError(err) {
  const msg = err.message || '';
  if (msg.includes('credit balance is too low') || msg.includes('Your credit balance')) {
    return '⚠️ Out of AI credits. Please top up your OpenRouter account at https://openrouter.ai/settings/billing then try again.';
  }
  if (msg.includes('rate_limit') || msg.includes('rate limit')) {
    return '⚠️ AI rate limit reached. Please wait a moment and try again.';
  }
  if (msg.includes('overloaded')) {
    return '⚠️ The AI is currently overloaded. Please try again in a few seconds.';
  }
  return `❌ Error: ${msg.slice(0, 200)}`;
}

// ─── Security Middleware ────────────────────────────────────────────────────
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId !== AUTHORIZED_USER_ID) {
    logger.warn(`Rejected message from unauthorized user ID: ${userId}`);
    return; // silently ignore
  }
  return next();
});

// ─── /start ────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  await ctx.reply(
    `👋 *Mighty Agent* is online!\n\n` +
    `Just send me a message in natural language and I'll figure out which skill to use.\n\n` +
    `*Commands:*\n` +
    `/list — show available skills\n` +
    `/run <skill-name> [args] — run a skill directly\n` +
    `/status — show uptime info\n\n` +
    `_Example: "What time is it?"_`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /list ──────────────────────────────────────────────────────────────────
bot.command('list', async (ctx) => {
  if (ALL_SKILLS.length === 0) {
    return ctx.reply('📂 No skills found in the skills/ directory yet.');
  }
  const lines = ALL_SKILLS.map(s => {
    const icon = s.enabled ? '✅' : '⛔';
    return icon + ' *' + s.name + '*\n   ' + s.description;
  });
  const enabled = ALL_SKILLS.filter(s => s.enabled).length;
  const total = ALL_SKILLS.length;
  const header = '*Skills (' + enabled + '/' + total + ' enabled):*';
  await ctx.reply(header + '\n\n' + lines.join('\n\n'), { parse_mode: 'Markdown' });
});

// ─── /run ───────────────────────────────────────────────────────────────────
bot.command('run', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/).slice(1); // remove "/run"
  if (parts.length === 0) {
    return ctx.reply('Usage: `/run <skill-name> [args...]`', { parse_mode: 'Markdown' });
  }

  const [skillName, ...args] = parts;

  const skill = SKILLS.find(s => s.name === skillName);
  if (!skill) {
    const available = SKILLS.length > 0
      ? SKILLS.map(s => `\`${s.name}\``).join(', ')
      : '_none_';
    return ctx.reply(
      `❌ Unknown skill: \`${skillName}\`\n\nAvailable: ${available}`,
      { parse_mode: 'Markdown' }
    );
  }

  await ctx.reply(`⚙️ Running skill \`${skillName}\`...`, { parse_mode: 'Markdown' });
  const { output, exitCode, timedOut } = await runSkill(skillName, args);

  let result = '';
  if (timedOut) result += '⏱ *Skill timed out.*\n\n';
  result += output.length > 0 ? `\`\`\`\n${output.slice(0, 3800)}\n\`\`\`` : '_No output._';
  if (exitCode !== 0 && !timedOut) result += `\n\n⚠️ Exit code: ${exitCode}`;

  await ctx.reply(result, { parse_mode: 'Markdown' });
});

// ─── /status ────────────────────────────────────────────────────────────────
bot.command('status', async (ctx) => {
  const uptimeMs = Date.now() - startTime;
  const uptimeSec = Math.floor(uptimeMs / 1000);
  const h = Math.floor(uptimeSec / 3600);
  const m = Math.floor((uptimeSec % 3600) / 60);
  const s = uptimeSec % 60;
  await ctx.reply(
    `✅ *Bot Status: Online*\n⏱ Uptime: ${h}h ${m}m ${s}s`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Natural Language → LLM → Skill ––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––

/**
 * Stream an Agent response back to Telegram.
 * Edits the initial "thinking" message with accumulating text every 800ms.
 */
async function streamAgentResponse(ctx, thinkingMsgId, question, agentName) {
  let accumulated = '';
  let lastEdit = Date.now();
  const EDIT_INTERVAL_MS = 800;
  const agentCap = agentName.charAt(0).toUpperCase() + agentName.slice(1);

  // Streaming edit loop
  const editIfDue = async () => {
    const now = Date.now();
    if (now - lastEdit >= EDIT_INTERVAL_MS && accumulated.length > 0) {
      try {
        await ctx.telegram.editMessageText(
          ctx.chat.id, thinkingMsgId, undefined,
          accumulated.slice(0, 4000), // Telegram limit
          { parse_mode: 'Markdown' }
        );
        lastEdit = now;
      } catch (err) {
        // If it's a markdown error, it might recover on the next chunk, so just ignore
        lastEdit = now;
      }
    }
  };

  const interval = setInterval(editIfDue, EDIT_INTERVAL_MS);

  let sources = [];
  try {
    let runAgent;
    if (agentName === 'legal') runAgent = runLegalAgent;
    else if (agentName === 'medical') runAgent = runMedicalAgent;
    else if (agentName === 'finance') runAgent = runFinanceAgent;
    else if (agentName === 'coder') runAgent = runCoderAgent;
    else if (agentName === 'travel') runAgent = runTravelAgent;

    const result = await runAgent(question, (chunk) => {
      accumulated += chunk;
    });
    sources = result.sources || [];
  } finally {
    clearInterval(interval);
  }

  // Final edit with full answer (split if over Telegram's 4096 limit)
  const messageChunks = [];
  for (let i = 0; i < accumulated.length; i += 4000) {
    messageChunks.push(accumulated.slice(i, i + 4000));
  }
  if (messageChunks.length === 0) messageChunks.push('_No response._');

  // 1. Update the original thinking message with the first chunk
  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id, thinkingMsgId, undefined,
      messageChunks[0],
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    if (!err.message.includes('message is not modified')) {
      logger.warn(`[${agentCap}] Telegram Markdown error on final edit: ${err.message}. Retrying as plain text.`);
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, thinkingMsgId, undefined, messageChunks[0]);
      } catch (fallbackErr) {
        logger.error(`[${agentCap}] Final edit fallback also failed: ${fallbackErr.message}`);
      }
    }
  }

  // 2. Send any remaining chunks as new messages
  for (let i = 1; i < messageChunks.length; i++) {
    try {
      await ctx.reply(messageChunks[i], { parse_mode: 'Markdown' });
    } catch (err) {
      logger.warn(`[${agentCap}] Telegram Markdown error on follow-up chunk: ${err.message}. Retrying as plain text.`);
      try {
        await ctx.reply(messageChunks[i]);
      } catch (fallbackErr) {
        logger.error(`[${agentCap}] Follow-up chunk fallback also failed: ${fallbackErr.message}`);
      }
    }
  }

  // If there are document sources, send a follow-up message
  if (sources.length > 0) {
    const srcText = sources
      .slice(0, 5)
      .map(s => `• \`${s.length > 80 ? s.slice(0, 77) + '...' : s}\``)
      .join('\n');
    await ctx.reply(`📚 *Sources used:*\n${srcText}`, { parse_mode: 'Markdown' });
  }
}

bot.on('text', async (ctx) => {
  try {
    const rawMessage = ctx.message.text;
    logger.info(`Message from ${ctx.from.id}: ${rawMessage}`);

    // ── "ask <agent>" prefix routing ──────────────────────────────────────────
    // Supports: "ask legal ...", "ask legal, ...", "ask legal: ..."
    const askMatch = rawMessage.match(/^ask\s+(\w+)[.,;:\s]+(.+)/is);
    if (askMatch) {
      const agentName = askMatch[1].toLowerCase();
      const question = askMatch[2].trim();

      if (agentName === 'legal') {
        const thinking = await ctx.reply('⚖️ Legal is thinking...');
        // Fire in background — do NOT await. Telegraf has a 90s handler timeout
        // and agent queries can take several minutes across many tool iterations.
        streamAgentResponse(ctx, thinking.message_id, question, 'legal').catch(err => {
          logger.error(`[Legal] Background stream error: ${err.message}`);
          ctx.reply(formatApiError(err)).catch(() => { });
        });
        return;
      }

      if (agentName === 'medical') {
        const thinking = await ctx.reply('🩺 Medical is thinking...');
        streamAgentResponse(ctx, thinking.message_id, question, 'medical').catch(err => {
          logger.error(`[Medical] Background stream error: ${err.message}`);
          ctx.reply(formatApiError(err)).catch(() => { });
        });
        return;
      }

      if (agentName === 'finance') {
        const thinking = await ctx.reply('💰 Finance is thinking...');
        streamAgentResponse(ctx, thinking.message_id, question, 'finance').catch(err => {
          logger.error(`[Finance] Background stream error: ${err.message}`);
          ctx.reply(formatApiError(err)).catch(() => { });
        });
        return;
      }

      if (agentName === 'travel') {
        const thinking = await ctx.reply('✈️ Travel is thinking...');
        streamAgentResponse(ctx, thinking.message_id, question, 'travel').catch(err => {
          logger.error(`[Travel] Background stream error: ${err.message}`);
          ctx.reply(formatApiError(err)).catch(() => { });
        });
        return;
      }

      // Future agents: 'real-estate', etc.
    }

    const userMessage = rawMessage;

    const thinking = await ctx.reply('🤔 Thinking...');
    let lastStatus = '';

    const decision = await decideAction(userMessage, (statusText) => {
      if (statusText !== lastStatus) {
        lastStatus = statusText;
        ctx.telegram.editMessageText(ctx.chat.id, thinking.message_id, undefined, statusText).catch(() => { });
      }
    });

    if (decision.type === 'reply') {
      await ctx.telegram.editMessageText(ctx.chat.id, thinking.message_id, undefined, decision.text);
      return;
    }

    if (decision.type === 'error') {
      await ctx.telegram.editMessageText(ctx.chat.id, thinking.message_id, undefined, `❌ ${decision.text}`);
      return;
    }

    // type === 'coder' — delegate to Coder sub-agent
    if (decision.type === 'coder') {
      await ctx.telegram.editMessageText(
        ctx.chat.id, thinking.message_id, undefined,
        '🧑‍💻 Coder is thinking...'
      );
      streamAgentResponse(ctx, thinking.message_id, decision.task, 'coder').catch(err => {
        logger.error(`[Coder] Background stream error: ${err.message}`);
        ctx.reply(formatApiError(err)).catch(() => { });
      });
      return;
    }

    // type === 'legal' — delegate to Legal sub-agent
    if (decision.type === 'legal') {
      await ctx.telegram.editMessageText(
        ctx.chat.id, thinking.message_id, undefined,
        '⚖️ Legal is thinking...'
      );
      // Fire in background — do NOT await (same timeout reason as above)
      streamAgentResponse(ctx, thinking.message_id, decision.task, 'legal').catch(err => {
        logger.error(`[Legal] Background stream error: ${err.message}`);
        ctx.reply(`❌ Legal agent error: ${err.message}`).catch(() => { });
      });
      return;
    }

    // type === 'medical' — delegate to Medical sub-agent
    if (decision.type === 'medical') {
      await ctx.telegram.editMessageText(
        ctx.chat.id, thinking.message_id, undefined,
        '🩺 Medical is thinking...'
      );
      // Fire in background — do NOT await
      streamAgentResponse(ctx, thinking.message_id, decision.task, 'medical').catch(err => {
        logger.error(`[Medical] Background stream error: ${err.message}`);
        ctx.reply(`❌ Medical agent error: ${err.message}`).catch(() => { });
      });
      return;
    }
    // type === 'finance' — delegate to Finance sub-agent
    if (decision.type === 'finance') {
      await ctx.telegram.editMessageText(
        ctx.chat.id, thinking.message_id, undefined,
        '💰 Finance is thinking...'
      );
      // Fire in background
      streamAgentResponse(ctx, thinking.message_id, decision.task, 'finance').catch(err => {
        logger.error(`[Finance] Background stream error: ${err.message}`);
        ctx.reply(`❌ Finance agent error: ${err.message}`).catch(() => { });
      });
      return;
    }

    // type === 'travel' — delegate to Travel sub-agent
    if (decision.type === 'travel') {
      await ctx.telegram.editMessageText(
        ctx.chat.id, thinking.message_id, undefined,
        '✈️ Travel is thinking...'
      );
      streamAgentResponse(ctx, thinking.message_id, decision.task, 'travel').catch(err => {
        logger.error(`[Travel] Background stream error: ${err.message}`);
        ctx.reply(`❌ Travel agent error: ${err.message}`).catch(() => { });
      });
      return;
    }

    // type === 'run'
    const { skill, args } = decision;

    await ctx.telegram.editMessageText(
      ctx.chat.id, thinking.message_id, undefined,
      `⚙️ Running skill \`${skill}\`${args.length ? ` with args: ${args.join(' ')}` : ''}...`,
      { parse_mode: 'Markdown' }
    );

    const { output, exitCode, timedOut } = await runSkill(skill, args);

    let result = `✅ \`${skill}\`\n\n`;
    if (timedOut) result = `⏱ *Skill timed out.*\n\n`;
    result += output.length > 0 ? `\`\`\`\n${output.slice(0, 3800)}\n\`\`\`` : '_No output._';
    if (exitCode !== 0 && !timedOut) result += `\n\n⚠️ Exit code: ${exitCode}`;

    await ctx.reply(result, { parse_mode: 'Markdown' });

  } catch (err) {
    logger.error(`[Bot] Unhandled text handler error: ${err.message}`);
    try { await ctx.reply(`❌ Unexpected error: ${err.message}`); } catch (_) { }
  }
});

// ─── Global error handler — prevents fatal crashes ──────────────────────────
// Catches any unhandled middleware/handler rejections Telegraf surfaces.
bot.catch((err, ctx) => {
  logger.error(`[Bot] Global error for update ${ctx?.update?.update_id}: ${err.message}`);
  if (ctx) {
    ctx.reply(`❌ Something went wrong: ${err.message}`).catch(() => { });
  }
});

module.exports = bot;
