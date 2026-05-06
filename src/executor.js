'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PYTHON_CMD, SKILLS_DIR, SCRIPT_TIMEOUT_MS } = require('./config');
const { SKILLS } = require('./llm');
const logger = require('./logger');

/**
 * Sanitize a Python script filename to prevent path traversal.
 * Only allows alphanumeric, underscores, hyphens, and a single .py extension.
 */
function sanitizeScriptName(name) {
  const basename = path.basename(name);
  if (!/^[\w\-]+\.py$/i.test(basename)) {
    throw new Error(`Invalid script name: "${name}". Only .py files are allowed.`);
  }
  return basename;
}

/**
 * Resolve the absolute path to the first .py script found inside a skill's
 * scripts/ directory.  If the skill has more than one script we pick the
 * first one alphabetically (skills can document which script is the entry
 * point in their SKILL.md body).
 *
 * @param {string} skillName  - the skill's name (e.g. "date-time")
 * @returns {{ scriptPath: string, scriptDir: string }}
 */
function resolveSkillScript(skillName) {
  const skill = SKILLS.find(s => s.name === skillName);
  if (!skill) {
    throw new Error(`Unknown skill: "${skillName}". Available: ${SKILLS.map(s => s.name).join(', ')}`);
  }

  const { scriptDir } = skill;

  if (!fs.existsSync(scriptDir)) {
    throw new Error(`Skill "${skillName}" has no scripts/ directory.`);
  }

  const pyFiles = fs.readdirSync(scriptDir).filter(f => /\.py$/i.test(f)).sort();
  if (pyFiles.length === 0) {
    throw new Error(`Skill "${skillName}" scripts/ directory contains no .py files.`);
  }

  return {
    scriptPath: path.join(scriptDir, pyFiles[0]),
    scriptDir,
  };
}

/**
 * Run the Python script belonging to a skill and return its output.
 *
 * @param {string}   skillName - skill name (e.g. "date-time")
 * @param {string[]} args      - extra CLI arguments
 * @returns {Promise<{output: string, exitCode: number, timedOut: boolean}>}
 */
function runSkill(skillName, args = []) {
  return new Promise((resolve) => {
    let scriptPath, scriptDir;
    try {
      ({ scriptPath, scriptDir } = resolveSkillScript(skillName));
    } catch (err) {
      return resolve({ output: err.message, exitCode: -1, timedOut: false });
    }

    logger.info(`Executing skill "${skillName}": ${PYTHON_CMD} ${scriptPath} ${args.join(' ')}`);

    const child = spawn(PYTHON_CMD, [scriptPath, ...args], {
      cwd: scriptDir,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    });

    let output = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      logger.warn(`Skill "${skillName}" timed out after ${SCRIPT_TIMEOUT_MS / 1000}s`);
    }, SCRIPT_TIMEOUT_MS);

    child.stdout.on('data', (data) => { output += data.toString('utf8'); });
    child.stderr.on('data', (data) => { output += data.toString('utf8'); });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ output: output.trim(), exitCode, timedOut });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ output: `Failed to start skill script: ${err.message}`, exitCode: -1, timedOut: false });
    });
  });
}

// Keep sanitizeScriptName exported so bot.js /run command can still validate input
module.exports = { runSkill, resolveSkillScript, sanitizeScriptName };
