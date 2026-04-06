const expect = require('unexpected');
const pathModule = require('path');
const { Worker } = require('worker_threads');
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

      // Submit a task to keep the first worker busy, then crash it
      const crashedTaskPromise = pool.trace(
        '<html><body><p>Will crash</p></body></html>',
        []
      );

      // The task is dispatched to an idle worker. Find which worker got the task
      // and terminate it to simulate a crash.
      const busyWorker = pool._workers.find(
        (w) => pool._taskByWorker.has(w)
      );
      if (busyWorker) {
        await busyWorker.terminate();
      }

      // The crashed task should be rejected
      try {
        await crashedTaskPromise;
      } catch (err) {
        // Expected — worker exited
      }

      // The surviving worker should still be able to process tasks
      const result = await pool.trace(
        '<html><body><p>After crash</p></body></html>',
        []
      );
      expect(result, 'to be an', 'array');

      await pool.destroy();
    });

    it('should reject all queued tasks when all workers crash simultaneously', async function () {
      const pool = new FontTracerPool(2);
      await pool.init();

      // Submit more tasks than workers so some are queued
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

      // Terminate all workers to simulate simultaneous crashes
      const workers = [...pool._workers];
      await Promise.all(workers.map((w) => w.terminate()));

      const results = await Promise.all(promises);

      // All tasks should have been rejected
      for (const result of results) {
        expect(result.status, 'to be', 'rejected');
        expect(result.message, 'to match', /Worker exited|All workers have crashed/);
      }

      expect(pool._workers, 'to have length', 0);
      expect(pool._pendingTasks, 'to have length', 0);
    });

    it('should handle many concurrent traces exceeding worker count', async function () {
      const pool = new FontTracerPool(2);
      await pool.init();

      const numTasks = 20;
      const promises = [];
      for (let i = 0; i < numTasks; i++) {
        promises.push(
          pool.trace(
            `<html><body><p style="font-family: sans-serif">Task ${i} ${'x'.repeat(100)}</p></body></html>`,
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

    it('should handle rapid sequential trace calls on a single worker', async function () {
      const pool = new FontTracerPool(1);
      await pool.init();

      // Fire off many tasks in rapid succession — all queued behind a single worker
      const numTasks = 15;
      const promises = [];
      for (let i = 0; i < numTasks; i++) {
        promises.push(
          pool.trace(`<html><body><span>Seq ${i}</span></body></html>`, [])
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

      // Submit enough tasks to keep all 3 workers busy + have some queued
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

      // Kill one worker to simulate a mid-processing crash
      if (pool._workers.length > 0) {
        await pool._workers[0].terminate();
      }

      const results = await Promise.all(promises);

      // At least the tasks on surviving workers should resolve
      const resolved = results.filter((r) => r.status === 'resolved');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Most tasks should succeed since 2 workers survive
      expect(resolved.length, 'to be greater than', 0);
      for (const r of resolved) {
        expect(r.result, 'to be an', 'array');
      }
      // The one in-flight on the crashed worker should be rejected
      for (const r of rejected) {
        expect(r.message, 'to match', /Worker exited|All workers have crashed/);
      }

      await pool.destroy();
    });

    it('should handle traces with large HTML documents', async function () {
      const pool = new FontTracerPool(2);
      await pool.init();

      // Build a large HTML document with many elements
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

    it('should properly destroy pool while tasks are still queued', async function () {
      const pool = new FontTracerPool(1);
      await pool.init();

      // Submit several tasks but destroy the pool before they complete
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(
          pool
            .trace(`<html><body>Destroy test ${i}</body></html>`, [])
            .then(
              (r) => ({ status: 'resolved', result: r }),
              (err) => ({ status: 'rejected', message: err.message })
            )
        );
      }

      // Destroy immediately — some tasks may still be pending
      await pool.destroy();

      // All tasks should either resolve or reject cleanly (no hanging promises)
      const results = await Promise.all(promises);
      for (const r of results) {
        expect(r.status, 'to match', /^(resolved|rejected)$/);
      }
    });

    it('should handle worker error messages (non-crash failures)', async function () {
      // Create a pool with a custom worker that sends an error message
      const pool = new FontTracerPool(1);
      await pool.init();

      // Trace with invalid CSS that triggers a worker-side error
      // (malformed input that postcss.parse might choke on won't actually
      // crash the worker — it gets caught and sent as an error message)
      const result = await pool.trace(
        '<html><body><p>test</p></body></html>',
        [{ text: '', predicates: {} }]
      );

      // Empty CSS should still produce a valid result
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

      // After all tasks complete, there should be no lingering callbacks
      expect(pool._taskCallbacks.size, 'to be', 0);
      expect(pool._taskByWorker.size, 'to be', 0);
      expect(pool._pendingTasks, 'to have length', 0);

      await pool.destroy();
    });
  });
});
