const expect = require('unexpected').clone().use(require('unexpected-sinon'));
const sinon = require('sinon');
const {
  createPageProgress,
  makePhaseTracker,
  logTracedPage,
} = require('../lib/progress');

describe('progress', function () {
  describe('createPageProgress', function () {
    it('should be disabled when console is not provided', function () {
      const progress = createPageProgress({ total: 100, label: 'test' });
      expect(progress.enabled, 'to be false');
    });

    it('should be disabled when total is below minTotal', function () {
      const progress = createPageProgress({
        total: 3,
        console: { log: sinon.stub() },
        label: 'test',
        minTotal: 5,
      });
      expect(progress.enabled, 'to be false');
    });

    it('should be enabled when total meets minTotal and console is provided', function () {
      const progress = createPageProgress({
        total: 10,
        console: { log: sinon.stub() },
        label: 'test',
      });
      expect(progress.enabled, 'to be true');
    });

    it('should print banner when enabled', function () {
      const log = sinon.stub();
      const progress = createPageProgress({
        total: 10,
        console: { log },
        label: 'test',
      });
      progress.banner('Starting...');
      expect(log, 'to have a call satisfying', ['Starting...']);
    });

    it('should not print banner when disabled', function () {
      const log = sinon.stub();
      const progress = createPageProgress({
        total: 2,
        console: { log },
        label: 'test',
      });
      progress.banner('Starting...');
      expect(log, 'was not called');
    });

    it('should print periodic tick messages', function () {
      const log = sinon.stub();
      const progress = createPageProgress({
        total: 10,
        console: { log },
        label: 'trace',
      });
      progress.tick();
      expect(log, 'to have a call satisfying', ['  trace: 1/10 pages...']);
    });

    it('should not print on the final tick (done handles that)', function () {
      const log = sinon.stub();
      const progress = createPageProgress({
        total: 5,
        console: { log },
        label: 'trace',
        minTotal: 1,
      });
      for (let i = 0; i < 5; i++) {
        progress.tick();
      }
      // The final tick (count === total) should be suppressed;
      // only the done() method prints the completion message.
      const lastCall = log.args[log.args.length - 1][0];
      expect(lastCall, 'not to contain', '5/5');
    });

    it('should print done message with total', function () {
      const log = sinon.stub();
      const progress = createPageProgress({
        total: 20,
        console: { log },
        label: 'trace',
      });
      progress.done();
      expect(log, 'to have a call satisfying', ['  trace: 20/20 pages done.']);
    });

    it('should not print done when disabled', function () {
      const log = sinon.stub();
      const progress = createPageProgress({
        total: 2,
        console: { log },
        label: 'trace',
      });
      progress.done();
      expect(log, 'was not called');
    });

    it('should return running count from tick', function () {
      const progress = createPageProgress({
        total: 100,
        console: { log: sinon.stub() },
        label: 'test',
      });
      expect(progress.tick(), 'to equal', 1);
      expect(progress.tick(), 'to equal', 2);
      expect(progress.tick(), 'to equal', 3);
    });

    it('should still count ticks when disabled', function () {
      const progress = createPageProgress({
        total: 2,
        label: 'test',
      });
      expect(progress.enabled, 'to be false');
      expect(progress.tick(), 'to equal', 1);
      expect(progress.tick(), 'to equal', 2);
    });
  });

  describe('logTracedPage', function () {
    it('should log when debug is true and console is provided', function () {
      const log = sinon.stub();
      logTracedPage(
        { log },
        true,
        3,
        10,
        { urlOrDescription: 'page.html' },
        Date.now() - 42
      );
      expect(log, 'was called once');
      const msg = log.args[0][0];
      expect(msg, 'to contain', '[subfont timing]');
      expect(msg, 'to contain', '[3/10]');
      expect(msg, 'to contain', 'page.html');
    });

    it('should not log when debug is false', function () {
      const log = sinon.stub();
      logTracedPage(
        { log },
        false,
        1,
        5,
        { urlOrDescription: 'p.html' },
        Date.now()
      );
      expect(log, 'was not called');
    });

    it('should not log when console is null', function () {
      logTracedPage(
        null,
        true,
        1,
        5,
        { urlOrDescription: 'p.html' },
        Date.now()
      );
    });
  });

  describe('makePhaseTracker', function () {
    it('should return a function that creates phase trackers', function () {
      const tracker = makePhaseTracker(null, false);
      const phase = tracker('test phase');
      expect(phase, 'to have property', 'end');
      expect(typeof phase.end, 'to equal', 'function');
    });

    it('should return elapsed ms from end()', function () {
      const tracker = makePhaseTracker(null, false);
      const phase = tracker('test');
      const elapsed = phase.end();
      expect(elapsed, 'to be greater than or equal to', 0);
    });

    it('should log phase start and end when debug is true', function () {
      const log = sinon.stub();
      const tracker = makePhaseTracker({ log }, true);
      const phase = tracker('subsetting');
      expect(log, 'to have a call satisfying', [
        '[subfont timing] → subsetting...',
      ]);
      phase.end();
      expect(log, 'was called times', 2);
    });

    it('should include extra info in end message when provided', function () {
      const log = sinon.stub();
      const tracker = makePhaseTracker({ log }, true);
      const phase = tracker('subsetting');
      phase.end('3 fonts');
      const endCall = log.args[1][0];
      expect(endCall, 'to contain', '(3 fonts)');
    });

    it('should not log when debug is false', function () {
      const log = sinon.stub();
      const tracker = makePhaseTracker({ log }, false);
      const phase = tracker('test');
      phase.end();
      expect(log, 'was not called');
    });
  });
});
