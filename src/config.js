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

module.exports = {
  TELEGRAM_TOKEN: required('TELEGRAM_TOKEN'),
  AUTHORIZED_USER_ID: parseInt(required('AUTHORIZED_USER_ID'), 10),
  ANTHROPIC_API_KEY: required('ANTHROPIC_API_KEY'),
  PYTHON_CMD: process.env.PYTHON_CMD || 'python',
  SCRIPT_TIMEOUT_MS: parseInt(process.env.SCRIPT_TIMEOUT_SEC || '60', 10) * 1000,
  SKILLS_DIR: path.resolve(__dirname, '..', 'skills'),
};
