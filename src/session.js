'use strict';

const logger = require('./logger');

const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

class SessionManager {
  constructor() {
    this.history = [];
    this.lastActivity = null;
    this.timeoutId = null;
  }

  /**
   * Resets the 60-minute inactivity timer and updates the last activity timestamp.
   * If this is the first message (or after a clear), a new session conceptually begins.
   */
  resetTimer() {
    this.lastActivity = Date.now();
    
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }

    this.timeoutId = setTimeout(() => {
      logger.info('Session expired due to inactivity (60 minutes). Clearing history.');
      this.clear();
    }, SESSION_TIMEOUT_MS);
  }

  /**
   * Appends a message to the session history.
   * @param {string} role 'user' or 'assistant'
   * @param {string} content The message content
   */
  addMessage(role, content) {
    if (!content) return;
    this.history.push({ role, content });
    this.resetTimer();
  }

  /**
   * Retrieves a copy of the current session history.
   * @returns {Array<{role: string, content: string}>}
   */
  getHistory() {
    return [...this.history];
  }

  /**
   * Clears the current session history and stops the timer.
   */
  clear() {
    this.history = [];
    this.lastActivity = null;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Formats the current session history as a Markdown string.
   * @returns {string}
   */
  formatAsMarkdown() {
    if (this.history.length === 0) {
      return '*No conversation history in the current session.*';
    }

    let md = `# Session History\n\n_Started at: ${new Date(this.lastActivity - (this.history.length * 1000)).toISOString()}_\n\n`;
    
    for (const msg of this.history) {
      const roleName = msg.role === 'user' ? '**User**' : '**Agent**';
      md += `${roleName}:\n${msg.content}\n\n---\n\n`;
    }

    return md;
  }
}

// Export a singleton instance since there is only one authorized user
const session = new SessionManager();
module.exports = session;
