'use strict';

const logger = require('./logger');

let active = false;
let stopRequested = false;

module.exports = {
  setActive(val) {
    active = val;
    if (val) {
      stopRequested = false;
    }
  },
  isActive() {
    return active;
  },
  requestStop() {
    if (active) {
      stopRequested = true;
      logger.info('[Cancellation] Stop requested for active thinking session.');
    }
  },
  isStopRequested() {
    return active && stopRequested;
  },
  check() {
    if (active && stopRequested) {
      logger.info('[Cancellation] Interrupting active thinking session.');
      throw new Error('Interrupted');
    }
  }
};
