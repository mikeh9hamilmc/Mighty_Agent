'use strict';

require('dotenv').config();
const path = require('path');

function required(name) {
  const val = process.env[name];
  if (!val || val.startsWith('your_')) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
      `Please fill in your .env file.`
    );
  }
  return val;
}

function optional(name, defaultVal = '') {
  const val = process.env[name];
  if (!val || val.startsWith('your_')) return defaultVal;
  return val;
}

const SKILLS_DIR = path.resolve(__dirname, '..', 'skills');

module.exports = {
  TELEGRAM_TOKEN:     required('TELEGRAM_TOKEN'),
  AUTHORIZED_USER_ID: parseInt(required('AUTHORIZED_USER_ID'), 10),
  OPENROUTER_API_KEY: required('OPENROUTER_API_KEY'),
  PYTHON_CMD:         process.env.PYTHON_CMD || 'python',
  SCRIPT_TIMEOUT_MS:  parseInt(process.env.SCRIPT_TIMEOUT_SEC || '60', 10) * 1000,
  SKILLS_DIR,
  BRAVE_API_KEY: optional('BRAVE_API_KEY'), // Used by all agents via DocumentManager.toolWebSearch
};
