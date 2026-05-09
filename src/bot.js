'use strict';

const { Telegraf } = require('telegraf');
const { TELEGRAM_TOKEN, AUTHORIZED_USER_ID } = require('./config');
const { runSkill } = require('./executor');
const { decideAction, SKILLS } = require('./llm');
const { runCoderAgent } = require('./coder-agent');
const { runLegalAgent } = require('./legal-agent');
const logger = require('./logger');

const bot = new Telegraf(TELEGRAM_TOKEN);
const startTime = Date.now();

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
    `👋 *Mini OpenClaw Agent* is online!\n\n` +
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
  if (SKILLS.length === 0) {
    return ctx.reply('📂 No skills found in the skills/ directory yet.');
  }
  const lines = SKILLS.map(s => `🔧 *${s.name}*\n   ${s.description}`);
  await ctx.reply(`*Available Skills:*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
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
 * Stream a Legal agent response back to Telegram.
 * Edits the initial "thinking" message with accumulating text every 800ms.
 */
async function streamLegalResponse(ctx, thinkingMsgId, question) {
  let accumulated = '';
  let lastEdit    = Date.now();
  const EDIT_INTERVAL_MS = 800;

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
    const result = await runLegalAgent(question, (chunk) => {
      accumulated += chunk;
    });
    sources = result.sources || [];
  } finally {
    clearInterval(interval);
  }

  // Final edit with full answer
  const finalText = accumulated.slice(0, 4000) || '_No response._';
  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id, thinkingMsgId, undefined,
      finalText,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    logger.warn(`[Legal] Telegram Markdown error on final edit: ${err.message}. Retrying as plain text.`);
    try {
      // Fallback: send without markdown if Telegram's strict parser rejected it
      await ctx.telegram.editMessageText(
        ctx.chat.id, thinkingMsgId, undefined,
        finalText
      );
    } catch (fallbackErr) {
      logger.error(`[Legal] Final edit fallback also failed: ${fallbackErr.message}`);
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
  const rawMessage = ctx.message.text;
  logger.info(`Message from ${ctx.from.id}: ${rawMessage}`);

  // ── "ask <agent>" prefix routing ──────────────────────────────────────────
  // Supports: "ask legal ...", "ask medical ...", etc.
  const askMatch = rawMessage.match(/^ask\s+(\w+)[:\s]+(.+)/is);
  if (askMatch) {
    const agentName = askMatch[1].toLowerCase();
    const question  = askMatch[2].trim();

    if (agentName === 'legal') {
      const thinking = await ctx.reply('⚖️ Legal is thinking...');
      await streamLegalResponse(ctx, thinking.message_id, question);
      return;
    }

    // Future agents: 'medical', 'financial', etc.
    // For now, fall through to normal LLM routing
  }

  const userMessage = rawMessage;

  const thinking = await ctx.reply('🤔 Thinking...');

  const decision = await decideAction(userMessage);

  if (decision.type === 'reply') {
    await ctx.telegram.editMessageText(ctx.chat.id, thinking.message_id, undefined, decision.text);
    return;
  }

  if (decision.type === 'error') {
    await ctx.telegram.editMessageText(ctx.chat.id, thinking.message_id, undefined, `❌ ${decision.text}`);
    return;
  }

  // type === 'code' — delegate to Coder sub-agent
  if (decision.type === 'code') {
    await ctx.telegram.editMessageText(
      ctx.chat.id, thinking.message_id, undefined,
      '🧑‍💻 Consulting the Coder sub-agent (Claude Opus)... this may take a moment.'
    );

    const { summary, filesCreated } = await runCoderAgent(decision.task);

    let result = summary;
    if (filesCreated.length > 0) {
      result += `\n\n📁 *Files created/updated:*\n${filesCreated.map(f => `\`${f}\``).join('\n')}`;
      result += '\n\n⚠️ *Restart the agent to load any new skills.*';
    }

    await ctx.reply(result, { parse_mode: 'Markdown' });
    return;
  }

  // type === 'legal' — delegate to Legal sub-agent
  if (decision.type === 'legal') {
    await ctx.telegram.editMessageText(
      ctx.chat.id, thinking.message_id, undefined,
      '⚖️ Legal is thinking...'
    );
    await streamLegalResponse(ctx, thinking.message_id, decision.task);
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
});

module.exports = bot;
