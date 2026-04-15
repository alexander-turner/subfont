const expect = require('unexpected');
const FontTracerPool = require('../lib/FontTracerPool');

const html = (content) => `<html><body>${content}</body></html>`;

function settle(promise) {
  return promise.then(
    (value) => ({ status: 'resolved', value }),
    (err) => ({ status: 'rejected', message: err.message })
  );
}

describe('FontTracerPool', function () {
  this.timeout(30000);

  it('should initialize workers and process trace requests', async function () {
    const pool = new FontTracerPool(1);
    await pool.init();

    const result = await pool.trace(
      '<html><body><p style="font-family: Arial">Hello</p></body></html>',
      []
    );

    expect(result, 'to be an', 'array');
    await pool.destroy();
  });

  it('should handle multiple concurrent trace requests', async function () {
    const pool = new FontTracerPool(2);
    await pool.init();

    const promises = [
      pool.trace('<html><body><p>Page 1</p></body></html>', []),
      pool.trace('<html><body><p>Page 2</p></body></html>', []),
      pool.trace('<html><body><p>Page 3</p></body></html>', []),
    ];

    const results = await Promise.all(promises);
    expect(results, 'to have length', 3);
    for (const result of results) {
      expect(result, 'to be an', 'array');
    }

    await pool.destroy();
  });

  it('should clean up workers on destroy', async function () {
    const pool = new FontTracerPool(2);
    await pool.init();
    expect(pool._workers, 'to have length', 2);

    await pool.destroy();
    expect(pool._workers, 'to have length', 0);
    expect(pool._idle, 'to have length', 0);
  });

  it('should handle empty HTML gracefully', async function () {
    const pool = new FontTracerPool(1);
    await pool.init();

    const result = await pool.trace('', []);
    expect(result, 'to be an', 'array');

    await pool.destroy();
  });

  it('should queue tasks when all workers are busy', async function () {
    const pool = new FontTracerPool(1);
    await pool.init();

    // Submit 3 tasks to a single worker — they must be queued
    const promises = [
      pool.trace('<html><body>A</body></html>', []),
      pool.trace('<html><body>B</body></html>', []),
      pool.trace('<html><body>C</body></html>', []),
    ];

    const results = await Promise.all(promises);
    expect(results, 'to have length', 3);
    for (const result of results) {
      expect(result, 'to be an', 'array');
    }

    await pool.destroy();
  });

  it('should reject pending tasks when all workers crash', async function () {
    const pool = new FontTracerPool(1);
    await pool.init();

    // Manually simulate: kill the worker and verify pending tasks are rejected
    const worker = pool._workers[0];

    // Queue a task that won't be dispatched because the worker is about to die
    const taskPromise = pool.trace('<html><body>test</body></html>', []);

    // Force-terminate the worker with a non-zero exit to simulate a crash
    await worker.terminate();

    try {
      await taskPromise;
      expect.fail('Expected task to be rejected');
    } catch (err) {
      expect(err.message, 'to match', /Worker exited|All workers have crashed/);
    }

    // Pool should have no workers left
    expect(pool._workers, 'to have length', 0);
  });

  it('should return traced results with text and props', async function () {
    const pool = new FontTracerPool(1);
    await pool.init();

    const result = await pool.trace(
      '<html><body><p style="font-family: serif; font-weight: bold">Hello World</p></body></html>',
      []
    );

    expect(result, 'to be an', 'array');
    for (const entry of result) {
      expect(entry, 'to have keys', ['text', 'props']);
      expect(entry.text, 'to be a', 'string');
      expect(entry.props, 'to be an', 'object');
    }

    await pool.destroy();
  });

  describe('stress and edge cases', function () {
    this.timeout(60000);

    let pool;
    afterEach(async function () {
      if (pool) {
        await pool.destroy();
        pool = null;
      }
    });

    it('should continue processing on surviving worker after one crashes', async function () {
      pool = new FontTracerPool(2);
      await pool.init();

      // Crash one worker deterministically before submitting tasks
      const workerToKill = pool._workers[0];
      const exitPromise = new Promise((resolve) =>
        workerToKill.on('exit', resolve)
      );
      await workerToKill.terminate();
      await exitPromise;

      expect(pool._workers, 'to have length', 1);

      // Survivor should handle single and queued tasks
      const results = await Promise.all([
        pool.trace(html('<p>A</p>'), []),
        pool.trace(html('<p>B</p>'), []),
        pool.trace(html('<p>C</p>'), []),
      ]);
      expect(results, 'to have length', 3);
      for (const r of results) {
        expect(r, 'to be an', 'array');
      }
    });

    it('should reject in-flight and queued tasks when all workers crash simultaneously', async function () {
      pool = new FontTracerPool(2);
      await pool.init();

      // 6 tasks: 2 dispatched (one per worker), 4 queued
      const promises = [];
      for (let i = 0; i < 6; i++) {
        promises.push(settle(pool.trace(html(`<p>Task ${i}</p>`), [])));
      }

      // Crash both workers while tasks are in-flight
      await Promise.all([...pool._workers].map((w) => w.terminate()));

      const results = await Promise.all(promises);
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(rejected.length, 'to be greater than', 0);
      for (const r of rejected) {
        expect(r.message, 'to match', /Worker exited|All workers have crashed/);
      }
      expect(pool._workers, 'to have length', 0);
      expect(pool._pendingTasks, 'to have length', 0);
    });

    it('should process 20 queued tasks across 2 workers without leaking state', async function () {
      pool = new FontTracerPool(2);
      await pool.init();

      const promises = Array.from({ length: 20 }, (_, i) =>
        pool.trace(html(`<p style="font-family: sans-serif">Task ${i}</p>`), [])
      );

      const results = await Promise.all(promises);
      expect(results, 'to have length', 20);
      for (const result of results) {
        expect(result, 'to be an', 'array');
      }

      // No internal state should linger after all tasks complete
      expect(pool._taskCallbacks.size, 'to be', 0);
      expect(pool._taskByWorker.size, 'to be', 0);
      expect(pool._pendingTasks, 'to have length', 0);
      expect(pool._idle, 'to have length', 2);
    });

    it('should complete most tasks when one of three workers crashes mid-queue', async function () {
      pool = new FontTracerPool(3);
      await pool.init();

      const promises = Array.from({ length: 10 }, (_, i) =>
        settle(pool.trace(html(`<p>Item ${i}</p>`), []))
      );

      // Kill one worker — 2 survivors should drain the remaining queue
      await pool._workers[0].terminate();

      const results = await Promise.all(promises);
      const resolved = results.filter((r) => r.status === 'resolved');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(resolved.length, 'to be greater than', 0);
      // At most 1 rejected (the in-flight task on the crashed worker)
      expect(rejected.length, 'to be less than or equal to', 1);
    });

    it('should handle large HTML with complex stylesheets', async function () {
      pool = new FontTracerPool(2);
      await pool.init();

      const css = `
        @font-face { font-family: 'TestFont'; src: local('TestFont'); font-weight: 400; }
        @font-face { font-family: 'TestFont'; src: local('TestFont-Bold'); font-weight: 700; }
        body { font-family: 'TestFont', sans-serif; }
        .bold { font-weight: bold; }
        .italic { font-style: italic; }
        h1 { font-family: Georgia, serif; font-weight: 900; }
      `;

      const elements = Array.from(
        { length: 500 },
        (_, i) =>
          `<p class="${i % 2 === 0 ? 'bold' : 'italic'}">Paragraph ${i}</p>`
      );
      const largeHtml = html(`<h1>Title</h1>${elements.join('\n')}`);

      const result = await pool.trace(largeHtml, [
        { text: css, predicates: {} },
      ]);
      expect(result, 'to be an', 'array');
      expect(result.length, 'to be greater than', 0);
    });

    it('should settle all promises when pool is destroyed with pending tasks', async function () {
      pool = new FontTracerPool(1);
      await pool.init();

      const promises = Array.from({ length: 5 }, (_, i) =>
        settle(pool.trace(html(`Destroy test ${i}`), []))
      );

      // Destroy immediately — Mocha's test timeout will catch any hanging promises
      await pool.destroy();
      pool = null; // prevent afterEach double-destroy

      const results = await Promise.all(promises);
      expect(results, 'to have length', 5);
    });

    it('should reject in-flight tasks when pool is destroyed while workers are busy', async function () {
      pool = new FontTracerPool(1);
      await pool.init();

      // Submit tasks - first will be dispatched to the worker, rest queued
      const promises = Array.from({ length: 3 }, (_, i) =>
        settle(pool.trace(html(`In-flight ${i}`), []))
      );

      // Destroy while the first task is in-flight on the worker
      await pool.destroy();
      pool = null;

      const results = await Promise.all(promises);
      const rejected = results.filter((r) => r.status === 'rejected');
      // All tasks should be rejected (both in-flight and queued)
      expect(rejected.length, 'to be', 3);
      for (const r of rejected) {
        expect(r.message, 'to match', /Worker pool destroyed|Worker exited/);
      }
    });

    it('should reject task on postMessage failure and keep pool functional', async function () {
      pool = new FontTracerPool(1);
      await pool.init();

      // Monkey-patch postMessage to throw once, exercising the
      // try/catch in _dispatchPending
      const worker = pool._workers[0];
      const originalPostMessage = worker.postMessage.bind(worker);
      let shouldFail = true;
      worker.postMessage = function (msg) {
        if (shouldFail) {
          shouldFail = false;
          throw new DOMException('Could not be cloned', 'DataCloneError');
        }
        return originalPostMessage(msg);
      };

      // First trace should be rejected synchronously
      try {
        await pool.trace(html('clone error'), []);
        expect.fail('Expected task to be rejected');
      } catch (err) {
        expect(err.message, 'to match', /Could not be cloned/);
      }

      // Worker returned to idle pool — still functional
      expect(pool._workers, 'to have length', 1);
      expect(pool._idle, 'to have length', 1);

      const result = await pool.trace(html('<p>After error</p>'), []);
      expect(result, 'to be an', 'array');
    });
  });
});
