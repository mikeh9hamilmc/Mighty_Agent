const cancellation = require('../src/cancellation');
const { decideAction } = require('../src/llm');

describe('Cancellation Service Unit Tests', () => {
  beforeEach(() => {
    cancellation.setActive(false);
  });

  test('isActive defaults to false', () => {
    expect(cancellation.isActive()).toBe(false);
    expect(cancellation.isStopRequested()).toBe(false);
  });

  test('setActive updates active status and resets stopRequested', () => {
    cancellation.setActive(true);
    expect(cancellation.isActive()).toBe(true);
    expect(cancellation.isStopRequested()).toBe(false);
  });

  test('requestStop sets stopRequested only if active', () => {
    cancellation.requestStop();
    expect(cancellation.isStopRequested()).toBe(false);

    cancellation.setActive(true);
    cancellation.requestStop();
    expect(cancellation.isStopRequested()).toBe(true);
  });

  test('check() throws when stopRequested and active', () => {
    cancellation.setActive(true);
    cancellation.requestStop();
    expect(() => cancellation.check()).toThrow('Interrupted');
  });

  test('check() does not throw when active but stop not requested', () => {
    cancellation.setActive(true);
    expect(() => cancellation.check()).not.toThrow();
  });
});
