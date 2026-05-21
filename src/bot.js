'use strict';

const { Telegraf } = require('telegraf');
const { TELEGRAM_TOKEN, AUTHORIZED_USER_ID } = require('./config');
const { runSkill } = require('./executor');
const llm = require('./llm');
const { refreshAllManagers } = require('./document-tools');
const { runCoderAgent } = require('./coder-agent');
const { runLegalAgent } = require('./legal-agent');
const { runMedicalAgent } = require('./medical-agent');
const { runFinanceAgent } = require('./finance-agent');
const { runTravelAgent } = require('./travel-agent');
const { runBeautyAgent } = require('./beauty-agent');
const logger = require('./logger');
const session = require('./session');
const cancellation = require('./cancellation');

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

// ─── Chat Action Helper ─────────────────────────────────────────────────────
/**
 * Repeatedly sends the 'typing' chat action to Telegram to keep the
 * "typing..." indicator (the three dots) visible in the header.
 */
function startTyping(ctx) {
  ctx.sendChatAction('typing').catch(() => { });
  const interval = setInterval(() => {
    ctx.sendChatAction('typing').catch(() => { });
  }, 4000);
  return () => clearInterval(interval);
}


// ─── /start ────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  await ctx.reply(
    `👋 *Mighty Agent* is online!\n\n` +
    `Just send me a message in natural language and I'll figure out which skill to use.\n\n` +
    `*Commands:*\n` +
    `/list — show available skills\n` +
    `/refresh — reload all agent data and memory\n` +
    `/status — show uptime info\n\n` +
    `Each enabled skill also has its own command (see /list).\n\n` +
    `_Example: "What time is it?"_`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /list ──────────────────────────────────────────────────────────────────
// Escape HTML entities to avoid Telegram parsing errors in HTML mode.
function htmlEscape(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

bot.command('list', async (ctx) => {
  const allSkills = llm.ALL_SKILLS;
  if (allSkills.length === 0) {
    return ctx.reply('📂 No skills found in the skills/ directory yet.');
  }
  const lines = allSkills.map(s => {
    const icon = s.enabled ? '✅' : '⛔';
    return `${icon} <b>${htmlEscape(s.name)}</b> — /${htmlEscape(s.name)}\n   ${htmlEscape(s.description)}`;
  });
  const enabled = allSkills.filter(s => s.enabled).length;
  const total = allSkills.length;
  const header = `<b>Skills (${enabled}/${total} enabled):</b>`;
  await ctx.reply(header + '\n\n' + lines.join('\n\n'), { parse_mode: 'HTML' });
});

// ─── /refresh ───────────────────────────────────────────────────────────────
bot.command('refresh', async (ctx) => {
  await ctx.reply('🔄 Refreshing all agent data and memory...');
  try {
    const summary = await refreshAllManagers();
    llm.refreshSkills();
    const cmdCount = await syncTelegramCommands();
    await ctx.reply(`✅ *Agent Data Refreshed:*\n\n${summary}\n\n🤖 _Menu synced (${cmdCount} commands)_`, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error(`[Refresh] Failed: ${err.message}`);
    await ctx.reply(`❌ Refresh failed: ${err.message}`);
  }
});

// ─── Per-skill commands ────────────────────────────────────────────────────────
// Registers one /command per enabled skill (skill names use underscores).
function registerSkillCommands() {
  const subAgents = ['legal', 'medical', 'finance', 'coder', 'travel', 'beauty'];
  const nativeCommands = ['start', 'list', 'refresh', 'status', 'clear'];
  // Register handlers for ALL discovered skills.
  // We check if they are enabled AT RUNTIME.
  for (const skill of llm.ALL_SKILLS) {
    if (nativeCommands.includes(skill.name)) continue;

    bot.command(skill.name, async (ctx) => {
      // Find current skill state
      const currentSkill = llm.ALL_SKILLS.find(s => s.name === skill.name);
      if (!currentSkill || !currentSkill.enabled) {
        return ctx.reply(`⛔ Skill \`${skill.name}\` is currently disabled.`);
      }

      const args = ctx.message.text.trim().split(/\s+/).slice(1);
      await ctx.reply(`⚙️ Running \`${skill.name}\`${args.length ? ' with args: ' + args.join(' ') : ''}...`, { parse_mode: 'Markdown' });

      // Show typing indicator for the duration of the skill run
      const stopTyping = startTyping(ctx);
      try {
        const { output, exitCode, timedOut } = await runSkill(skill.name, args);
        let result = `✅ \`${skill.name}\`\n\n`;
        if (timedOut) result = `⏱ *Skill timed out.*\n\n`;
        result += output.length > 0 ? `\`\`\`\n${output.slice(0, 3800)}\n\`\`\`` : '_No output._';
        if (exitCode !== 0 && !timedOut) result += `\n\n⚠️ Exit code: ${exitCode}`;
        await ctx.reply(result, { parse_mode: 'Markdown' });
      } finally {
        stopTyping();
      }
    });
  }
}
registerSkillCommands();

// ─── Telegram Command Menu Sync ──────────────────────────────────────────────────────
/**
 * Push the current command list to Telegram so the / menu stays in sync.
 * Called at startup and after /refresh.
 */
async function syncTelegramCommands() {
  const systemCommands = [
    { command: 'start',   description: 'Show welcome message and command list' },
    { command: 'list',    description: 'List all available skills' },
    { command: 'refresh', description: 'Reload all agent data and memory' },
    { command: 'status',  description: 'Show bot uptime and system info' },
    { command: 'clear',   description: 'Clear the current session context and start fresh' },
    { command: 'stop',    description: 'Stop current thinking/execution' },
  ];

  const skillCommands = llm.SKILLS
    .filter(s => !systemCommands.some(sys => sys.command === s.name))
    .map(s => ({
      command: s.name.toLowerCase(),
      description: s.description.slice(0, 256), // Telegram max is 256 chars
    }));

  const allCommands = [...systemCommands, ...skillCommands];

  try {
    // 1. Set default scope
    await bot.telegram.setMyCommands(allCommands);
    // 2. Set all_private_chats scope (overrides chat-specific caches for DMs)
    await bot.telegram.setMyCommands(allCommands, { scope: { type: 'all_private_chats' } });
    logger.info(`[Bot] Synced ${allCommands.length} commands to Telegram menu.`);
    return allCommands.length;
  } catch (err) {
    logger.error(`[Bot] Failed to sync Telegram commands: ${err.message}`);
    throw new Error(`Telegram API rejected commands: ${err.message}`);
  }
}

// ─── /clear ─────────────────────────────────────────────────────────────────
bot.command('clear', async (ctx) => {
  session.clear();
  logger.info('[Session] Cleared by user via /clear command.');
  await ctx.reply('🧹 *Session cleared.* Starting fresh!', { parse_mode: 'Markdown' });
});

// ─── /stop ──────────────────────────────────────────────────────────────────
bot.command('stop', async (ctx) => {
  if (cancellation.isActive()) {
    cancellation.requestStop();
    logger.info('[Bot] Stop requested via /stop command.');
    await ctx.reply('🛑 *Interrupting thinking...*', { parse_mode: 'Markdown' });
  } else {
    await ctx.reply('ℹ️ No active thinking session to stop.', { parse_mode: 'Markdown' });
  }
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
  let currentStatus = '';
  let lastEdit = Date.now();
  const EDIT_INTERVAL_MS = 800;
  const agentCap = agentName.charAt(0).toUpperCase() + agentName.slice(1);

  let lastTextSent = '';
  const stopTyping = startTyping(ctx);

  // Streaming edit loop
  const editIfDue = async () => {
    const now = Date.now();
    if (now - lastEdit >= EDIT_INTERVAL_MS) {
      let textToEdit = '';
      let isMarkdown = false;

      if (accumulated.length > 0) {
        textToEdit = accumulated;
        isMarkdown = true;
      } else if (currentStatus.length > 0) {
        textToEdit = currentStatus;
        isMarkdown = false;
      }

      if (textToEdit.length > 0 && textToEdit !== lastTextSent) {
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id, thinkingMsgId, undefined,
            textToEdit.slice(0, 4000), // Telegram limit
            isMarkdown ? { parse_mode: 'Markdown' } : undefined
          );
          lastTextSent = textToEdit;
          lastEdit = now;
        } catch (err) {
          // If it's a markdown error, it might recover on the next chunk, so just ignore
          lastEdit = now;
        }
      }
    }
  };

  const interval = setInterval(editIfDue, EDIT_INTERVAL_MS);

  let sources = [];
  const history = session.getHistory();

  try {
    let runAgent;
    if (agentName === 'legal') runAgent = runLegalAgent;
    else if (agentName === 'medical') runAgent = runMedicalAgent;
    else if (agentName === 'finance') runAgent = runFinanceAgent;
    else if (agentName === 'coder') runAgent = runCoderAgent;
    else if (agentName === 'travel') runAgent = runTravelAgent;
    else if (agentName === 'beauty') runAgent = runBeautyAgent;

    cancellation.setActive(true);
    const result = await runAgent(
      question,
      (chunk) => { accumulated += chunk; },
      (status) => { currentStatus = status; },
      history
    );
    sources = result.sources || [];
    
    // Add interaction to session history
    if (accumulated.length > 0) {
      session.addMessage('user', question);
      session.addMessage('assistant', accumulated);
    }
  } catch (err) {
    if (err.message === 'Interrupted') {
      accumulated = '🛑 *Thinking interrupted.*';
    } else {
      throw err;
    }
  } finally {
    clearInterval(interval);
    stopTyping();
    cancellation.setActive(false);
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

/**
 * Executes the main agent loop and processes the resulting decision in the background.
 */
async function handleMainAgent(ctx, thinkingMsgId, userMessage, stopTyping) {
  let lastStatus = '';
  try {
    const decision = await llm.decideAction(
      userMessage,
      (statusText) => {
        if (statusText !== lastStatus) {
          lastStatus = statusText;
          ctx.telegram.editMessageText(ctx.chat.id, thinkingMsgId, undefined, statusText).catch(() => { });
        }
      },
      session.getHistory()
    );

    if (decision.type === 'reply') {
      const messageChunks = [];
      for (let i = 0; i < decision.text.length; i += 4000) {
        messageChunks.push(decision.text.slice(i, i + 4000));
      }
      if (messageChunks.length === 0) messageChunks.push('_No response._');

      await ctx.telegram.editMessageText(ctx.chat.id, thinkingMsgId, undefined, messageChunks[0]);
      
      for (let i = 1; i < messageChunks.length; i++) {
        await ctx.reply(messageChunks[i]);
      }

      session.addMessage('user', userMessage);
      session.addMessage('assistant', decision.text);
      return;
    }

    if (decision.type === 'error') {
      const displayMsg = decision.text === 'Thinking interrupted.' ? '🛑 *Thinking interrupted.*' : `❌ ${decision.text}`;
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        thinkingMsgId,
        undefined,
        displayMsg,
        decision.text === 'Thinking interrupted.' ? { parse_mode: 'Markdown' } : undefined
      );
      return;
    }

    // type === 'coder' — delegate to Coder sub-agent
    if (decision.type === 'coder') {
      await ctx.telegram.editMessageText(
        ctx.chat.id, thinkingMsgId, undefined,
        '🧑‍💻 Coder is thinking...'
      );
      await streamAgentResponse(ctx, thinkingMsgId, decision.task, 'coder');
      return;
    }

    // type === 'legal' — delegate to Legal sub-agent
    if (decision.type === 'legal') {
      await ctx.telegram.editMessageText(
        ctx.chat.id, thinkingMsgId, undefined,
        '⚖️ Legal is thinking...'
      );
      await streamAgentResponse(ctx, thinkingMsgId, decision.task, 'legal');
      return;
    }

    // type === 'medical' — delegate to Medical sub-agent
    if (decision.type === 'medical') {
      await ctx.telegram.editMessageText(
        ctx.chat.id, thinkingMsgId, undefined,
        '🩺 Medical is thinking...'
      );
      await streamAgentResponse(ctx, thinkingMsgId, decision.task, 'medical');
      return;
    }

    // type === 'finance' — delegate to Finance sub-agent
    if (decision.type === 'finance') {
      await ctx.telegram.editMessageText(
        ctx.chat.id, thinkingMsgId, undefined,
        '💰 Finance is thinking...'
      );
      await streamAgentResponse(ctx, thinkingMsgId, decision.task, 'finance');
      return;
    }

    // type === 'travel' — delegate to Travel sub-agent
    if (decision.type === 'travel') {
      await ctx.telegram.editMessageText(
        ctx.chat.id, thinkingMsgId, undefined,
        '✈️ Travel is thinking...'
      );
      await streamAgentResponse(ctx, thinkingMsgId, decision.task, 'travel');
      return;
    }

    // type === 'beauty' — delegate to Beauty sub-agent
    if (decision.type === 'beauty') {
      await ctx.telegram.editMessageText(
        ctx.chat.id, thinkingMsgId, undefined,
        '💄 Beauty is thinking...'
      );
      await streamAgentResponse(ctx, thinkingMsgId, decision.task, 'beauty');
      return;
    }

    // type === 'run'
    const { skill, args } = decision;

    await ctx.telegram.editMessageText(
      ctx.chat.id, thinkingMsgId, undefined,
      `⚙️ Running skill \`${skill}\`${args.length ? ` with args: ${args.join(' ')}` : ''}...`,
      { parse_mode: 'Markdown' }
    );

    const { output, exitCode, timedOut } = await runSkill(skill, args);

    let result = `✅ \`${skill}\`\n\n`;
    if (timedOut) result = `⏱ *Skill timed out.*\n\n`;
    result += output.length > 0 ? `\`\`\`\n${output.slice(0, 3800)}\n\`\`\`` : '_No output._';
    if (exitCode !== 0 && !timedOut) result += `\n\n⚠️ Exit code: ${exitCode}`;

    await ctx.reply(result, { parse_mode: 'Markdown' });
    
    session.addMessage('user', userMessage);
    session.addMessage('assistant', `Ran skill \`${skill}\`. Output:\n${result}`);

  } catch (err) {
    logger.error(`[Main Agent] Error in decision handling: ${err.message}`);
    ctx.reply(formatApiError(err)).catch(() => { });
  } finally {
    if (stopTyping) stopTyping();
  }
}

bot.on('text', async (ctx) => {
  try {
    const rawMessage = ctx.message.text;
    logger.info(`Message from ${ctx.from.id}: ${rawMessage}`);
    let stopTyping = null;

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

      if (agentName === 'beauty') {
        const thinking = await ctx.reply('💄 Beauty is thinking...');
        streamAgentResponse(ctx, thinking.message_id, question, 'beauty').catch(err => {
          logger.error(`[Beauty] Background stream error: ${err.message}`);
          ctx.reply(formatApiError(err)).catch(() => { });
        });
        return;
      }

      // Future agents: 'real-estate', etc.
    }

    const userMessage = rawMessage;
    stopTyping = startTyping(ctx);

    // Reset session timer for every incoming message
    session.resetTimer();

    try {
      const thinking = await ctx.reply('🤔 Thinking...');
      handleMainAgent(ctx, thinking.message_id, userMessage, stopTyping).catch(err => {
        logger.error(`[Main] Background execution error: ${err.message}`);
      });
    } catch (err) {
      if (stopTyping) stopTyping();
      throw err;
    }
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
module.exports.syncTelegramCommands = syncTelegramCommands;
