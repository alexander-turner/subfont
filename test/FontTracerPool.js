const expect = require('unexpected');
const FontTracerPool = require('../lib/FontTracerPool');

// FontTracerPool spawns worker threads that load jsdom via fontTracerWorker.js.
// jsdom requires the native `canvas` module, which may not be available in all
// environments.  Probe for it and skip the suite when it's missing.
let canvasAvailable = true;
try {
  require('canvas');
} catch {
  canvasAvailable = false;
}

(canvasAvailable ? describe : describe.skip)('FontTracerPool', function () {
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
});
