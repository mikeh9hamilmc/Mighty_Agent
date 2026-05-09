'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { ANTHROPIC_API_KEY, SKILLS_DIR } = require('./config');
const logger = require('./logger');

const client = new Anthropic.default({ apiKey: ANTHROPIC_API_KEY });

// ─── Skill loading ────────────────────────────────────────────────────────────

/**
 * Parse the YAML frontmatter from a SKILL.md file.
 * Returns an object with the fields found, or null on failure.
 * We do a lightweight hand-rolled parse — no external YAML dep needed
 * because the frontmatter is always simple key: value pairs.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^"|"$/g, '');
    if (key && value) result[key] = value;
  }
  return result;
}

/**
 * Scan the skills/ directory and return an array of skill descriptors:
 *   { name, description, scriptDir }
 *
 * Each skill lives at  skills/<name>/SKILL.md
 * Its executable scripts live at  skills/<name>/scripts/
 */
function loadSkills() {
  if (!fs.existsSync(SKILLS_DIR)) {
    logger.warn(`Skills directory not found: ${SKILLS_DIR}`);
    return [];
  }

  const skills = [];

  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const skillMdPath = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const fm = parseFrontmatter(content);
      if (!fm || !fm.name || !fm.description) {
        logger.warn(`Skipping skill "${entry.name}": SKILL.md missing name or description`);
        continue;
      }
      skills.push({
        name: fm.name,
        description: fm.description,
        scriptDir: path.join(SKILLS_DIR, entry.name, 'scripts'),
      });
    } catch (err) {
      logger.warn(`Failed to read SKILL.md for "${entry.name}": ${err.message}`);
    }
  }

  return skills;
}

// Load skills once at startup so every LLM call gets the same snapshot.
// Re-start the agent to pick up newly added skills.
const SKILLS = loadSkills();

if (SKILLS.length === 0) {
  logger.warn('No skills found in the skills/ directory.');
} else {
  logger.info(`Loaded ${SKILLS.length} skill(s): ${SKILLS.map(s => s.name).join(', ')}`);
}

// ─── LLM decision ─────────────────────────────────────────────────────────────

/**
 * Ask Claude which skill (if any) to invoke for a given user message.
 *
 * Returns one of:
 *   { type: 'run',   skill: 'date-time', args: [] }
 *   { type: 'reply', text: '...' }
 *   { type: 'error', text: '...' }
 */
async function decideAction(userMessage) {
  if (SKILLS.length === 0) {
    return {
      type: 'reply',
      text: 'There are no skills available yet. Add a skill folder under `skills/` with a valid `SKILL.md`.',
    };
  }

  const skillsText = SKILLS
    .map(s => `- ${s.name}: ${s.description}`)
    .join('\n');

  const systemPrompt = `You are a helpful personal assistant with access to a set of skills you can invoke on the user's machine. Your primary mode is conversation — chat naturally, answer questions, and be friendly. Only invoke a skill when the user's message clearly requests an action or task that one of the available skills can fulfil.

Available skills:
${skillsText}

Rules:
1. For casual conversation (greetings, small talk, general questions, opinions) — just reply naturally. Do NOT invoke a skill.
2. Only invoke a skill when the user is clearly asking you to DO something that matches one of the available skills (e.g. "what time is it?", "check the date").
3. When the user asks you to write code, create a new skill, build a script, or do any programming task — use the code action.
4. When uncertain whether to invoke a skill, prefer replying conversationally and asking for clarification.
5. When the user asks anything related to law, legal documents, statutes, court cases, criminal charges, divorce, custody, marriage, property disputes, lawsuits, attorneys, or anything that sounds like a legal question — use the legal action.

Response format — respond with ONLY raw JSON, no markdown, no code fences:
- Conversational reply:    {"action":"reply","text":"your message here"}
- Invoke a skill:          {"action":"run","skill":"skill-name","args":[...]}
- Coding / scripting task: {"action":"code","task":"<the full task description>"}
- Legal question or task:  {"action":"legal","task":"<the full user question>"}

IMPORTANT: Respond with raw JSON only. No markdown, no code fences, no extra text.`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const raw = response.content[0].text.trim();
    logger.info(`LLM response: ${raw}`);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // If Claude returns non-JSON treat it as a plain reply
      return { type: 'reply', text: raw };
    }

    if (parsed.action === 'run' && parsed.skill) {
      return {
        type: 'run',
        skill: parsed.skill,
        args: Array.isArray(parsed.args) ? parsed.args : [],
      };
    }

    if (parsed.action === 'code' && parsed.task) {
      return { type: 'code', task: parsed.task };
    }

    if (parsed.action === 'legal' && parsed.task) {
      return { type: 'legal', task: parsed.task };
    }

    if (parsed.action === 'reply' && parsed.text) {
      return { type: 'reply', text: parsed.text };
    }

    return { type: 'reply', text: "I wasn't sure what to do. Could you rephrase?" };

  } catch (err) {
    logger.error(`LLM error: ${err.message}`);
    return { type: 'error', text: `LLM error: ${err.message}` };
  }
}

module.exports = { decideAction, loadSkills, SKILLS };
