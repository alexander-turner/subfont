// Detect whether the `canvas` module works in worker threads.
// FontTracerPool and subfont spawn worker threads that load jsdom,
// which requires canvas. On some CI environments the module loads
// fine in the main thread but fails in workers ("Module did not
// self-register"). This helper does a quick probe so test files can
// skip tests that depend on worker-thread canvas support.

const { Worker } = require('worker_threads');

let _result;

/**
 * Returns a promise that resolves to `true` when canvas can be loaded
 * inside a worker thread, `false` otherwise. The result is cached.
 */
function canvasWorksInWorkerThread() {
  if (_result !== undefined) return _result;

  _result = new Promise((resolve) => {
    let resolved = false;
    function settle(value) {
      if (!resolved) {
        resolved = true;
        resolve(value);
      }
    }

    try {
      const worker = new Worker(
        `
        const { parentPort } = require('worker_threads');
        try {
          const { createCanvas } = require('canvas');
          createCanvas(1, 1);
          parentPort.postMessage(true);
        } catch (e) {
          parentPort.postMessage(false);
        }
        `,
        { eval: true }
      );

      worker.on('message', (ok) => {
        settle(ok);
        worker.terminate();
      });
      worker.on('error', () => {
        settle(false);
      });
      worker.on('exit', (code) => {
        if (code !== 0) settle(false);
      });

      // Safety timeout — don't hang forever.
      setTimeout(() => {
        settle(false);
        worker.terminate();
      }, 5000);
    } catch (e) {
      settle(false);
    }
  });

  return _result;
}

module.exports = canvasWorksInWorkerThread;
