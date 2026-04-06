const expect = require('unexpected');
const FontTracerPool = require('../lib/FontTracerPool');

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

    it('should continue processing tasks on surviving workers after one worker crashes', async function () {
      const pool = new FontTracerPool(2);
      await pool.init();

      // Terminate one worker directly before submitting tasks.
      // This deterministically reduces the pool to 1 worker without
      // relying on timing of task dispatch.
      const workerToKill = pool._workers[0];
      const exitPromise = new Promise((resolve) =>
        workerToKill.on('exit', resolve)
      );
      await workerToKill.terminate();
      await exitPromise;

      expect(pool._workers, 'to have length', 1);

      // The surviving worker should still process tasks
      const result = await pool.trace(
        '<html><body><p>After crash</p></body></html>',
        []
      );
      expect(result, 'to be an', 'array');

      // And handle multiple queued tasks
      const results = await Promise.all([
        pool.trace('<html><body>A</body></html>', []),
        pool.trace('<html><body>B</body></html>', []),
      ]);
      expect(results, 'to have length', 2);

      await pool.destroy();
    });

    it('should reject all in-flight and queued tasks when both workers crash simultaneously', async function () {
      const pool = new FontTracerPool(2);
      await pool.init();

      // Submit 6 tasks: 2 dispatched (one per worker), 4 queued
      const promises = [];
      for (let i = 0; i < 6; i++) {
        promises.push(
          pool
            .trace(`<html><body><p>Task ${i}</p></body></html>`, [])
            .then(
              () => ({ status: 'resolved' }),
              (err) => ({ status: 'rejected', message: err.message })
            )
        );
      }

      // Crash both workers simultaneously while tasks are in-flight
      const workers = [...pool._workers];
      await Promise.all(workers.map((w) => w.terminate()));

      const results = await Promise.all(promises);

      const rejected = results.filter((r) => r.status === 'rejected');
      // All tasks that hadn't completed yet should be rejected
      expect(rejected.length, 'to be greater than', 0);
      for (const r of rejected) {
        expect(
          r.message,
          'to match',
          /Worker exited|All workers have crashed/
        );
      }

      expect(pool._workers, 'to have length', 0);
      expect(pool._pendingTasks, 'to have length', 0);
    });

    it('should reject in-flight task and all queued tasks when last worker crashes', async function () {
      const pool = new FontTracerPool(1);
      await pool.init();

      // Submit 5 tasks to a single worker: task 0 dispatched, tasks 1-4 queued
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          pool
            .trace(`<html><body><p>Task ${i}</p></body></html>`, [])
            .then(
              () => ({ status: 'resolved' }),
              (err) => ({ status: 'rejected', message: err.message })
            )
        );
      }

      // Crash the only worker while it processes task 0
      await pool._workers[0].terminate();

      const results = await Promise.all(promises);

      // All tasks should be rejected: the in-flight one with "Worker exited"
      // and the queued ones with "All workers have crashed"
      for (const result of results) {
        expect(result.status, 'to be', 'rejected');
        expect(
          result.message,
          'to match',
          /Worker exited|All workers have crashed/
        );
      }

      expect(pool._workers, 'to have length', 0);
      expect(pool._pendingTasks, 'to have length', 0);
    });

    it('should handle high concurrency with many queued tasks', async function () {
      const pool = new FontTracerPool(2);
      await pool.init();

      // 20 tasks on 2 workers exercises the queuing/dispatch cycle heavily
      const numTasks = 20;
      const promises = [];
      for (let i = 0; i < numTasks; i++) {
        promises.push(
          pool.trace(
            `<html><body><p style="font-family: sans-serif">Task ${i}</p></body></html>`,
            []
          )
        );
      }

      const results = await Promise.all(promises);
      expect(results, 'to have length', numTasks);
      for (const result of results) {
        expect(result, 'to be an', 'array');
      }

      await pool.destroy();
    });

    it('should handle worker crash mid-queue and process remaining on survivors', async function () {
      const pool = new FontTracerPool(3);
      await pool.init();

      // Submit enough tasks to keep workers busy + have some queued
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          pool
            .trace(`<html><body><p>Item ${i}</p></body></html>`, [])
            .then(
              (r) => ({ status: 'resolved', result: r }),
              (err) => ({ status: 'rejected', message: err.message })
            )
        );
      }

      // Kill one worker — 2 survivors should drain the remaining queue
      await pool._workers[0].terminate();

      const results = await Promise.all(promises);

      const resolved = results.filter((r) => r.status === 'resolved');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Surviving workers should complete most tasks
      expect(resolved.length, 'to be greater than', 0);
      for (const r of resolved) {
        expect(r.result, 'to be an', 'array');
      }
      // At most 1 task rejected (the one in-flight on crashed worker)
      expect(rejected.length, 'to be less than or equal to', 1);
      for (const r of rejected) {
        expect(r.message, 'to match', /Worker exited/);
      }

      await pool.destroy();
    });

    it('should handle traces with large HTML documents', async function () {
      const pool = new FontTracerPool(2);
      await pool.init();

      // 500 styled paragraphs exercises jsdom parsing and font-tracer traversal
      const elements = [];
      for (let i = 0; i < 500; i++) {
        elements.push(
          `<p style="font-family: Arial; font-weight: ${i % 2 === 0 ? 'bold' : 'normal'}">Paragraph ${i} with some text content</p>`
        );
      }
      const largeHtml = `<html><body>${elements.join('\n')}</body></html>`;

      const result = await pool.trace(largeHtml, []);
      expect(result, 'to be an', 'array');
      expect(result.length, 'to be greater than', 0);

      await pool.destroy();
    });

    it('should handle traces with complex stylesheets', async function () {
      const pool = new FontTracerPool(1);
      await pool.init();

      const css = `
        @font-face { font-family: 'TestFont'; src: local('TestFont'); font-weight: 400; }
        @font-face { font-family: 'TestFont'; src: local('TestFont-Bold'); font-weight: 700; }
        body { font-family: 'TestFont', sans-serif; }
        .bold { font-weight: bold; }
        .italic { font-style: italic; }
        p { font-size: 16px; line-height: 1.5; }
        h1 { font-family: Georgia, serif; font-weight: 900; }
      `;

      const result = await pool.trace(
        '<html><body><h1>Title</h1><p class="bold">Bold text</p><p class="italic">Italic text</p></body></html>',
        [{ text: css, predicates: {} }]
      );

      expect(result, 'to be an', 'array');
      expect(result.length, 'to be greater than', 0);

      await pool.destroy();
    });

    it('should settle all promises when pool is destroyed with pending tasks', async function () {
      const pool = new FontTracerPool(1);
      await pool.init();

      // Submit tasks then destroy immediately — tasks may be in-flight or queued
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          pool
            .trace(`<html><body>Destroy test ${i}</body></html>`, [])
            .then(
              () => 'resolved',
              () => 'rejected'
            )
        );
      }

      await pool.destroy();

      // Use a timeout to verify no promises hang. If any promise never
      // settles, this will timeout and the test fails.
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Promises hung after destroy')), 5000)
      );
      const results = await Promise.race([Promise.all(promises), timeout]);
      expect(results, 'to have length', 5);
    });

    it('should reject task on postMessage failure and keep pool functional', async function () {
      const pool = new FontTracerPool(1);
      await pool.init();

      // Monkey-patch the worker's postMessage to throw a structured clone
      // error, exercising the try/catch in _dispatchPending.
      const worker = pool._workers[0];
      const originalPostMessage = worker.postMessage.bind(worker);
      let callCount = 0;
      worker.postMessage = function (msg) {
        callCount++;
        if (callCount === 1) {
          throw new DOMException(
            'Could not be cloned',
            'DataCloneError'
          );
        }
        return originalPostMessage(msg);
      };

      // First trace hits the patched postMessage and should be rejected
      try {
        await pool.trace('<html><body>clone error</body></html>', []);
        expect.fail('Expected task to be rejected');
      } catch (err) {
        expect(err.message, 'to match', /Could not be cloned/);
      }

      // Pool should still be functional — worker returned to idle pool
      expect(pool._workers, 'to have length', 1);
      expect(pool._idle, 'to have length', 1);

      // Second trace should succeed normally
      const result = await pool.trace(
        '<html><body><p>After clone error</p></body></html>',
        []
      );
      expect(result, 'to be an', 'array');

      await pool.destroy();
    });

    it('should not leak task callbacks after completion', async function () {
      const pool = new FontTracerPool(2);
      await pool.init();

      for (let batch = 0; batch < 3; batch++) {
        const promises = [];
        for (let i = 0; i < 4; i++) {
          promises.push(
            pool.trace(`<html><body>Batch ${batch} Task ${i}</body></html>`, [])
          );
        }
        await Promise.all(promises);
      }

      // After 12 tasks across 3 batches, no internal state should linger
      expect(pool._taskCallbacks.size, 'to be', 0);
      expect(pool._taskByWorker.size, 'to be', 0);
      expect(pool._pendingTasks, 'to have length', 0);
      // All workers should be idle
      expect(pool._idle, 'to have length', 2);

      await pool.destroy();
    });
  });
});
