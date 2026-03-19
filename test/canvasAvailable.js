// Detect whether the `canvas` native module works in worker threads.
// FontTracerPool and subfont spawn worker threads that load jsdom,
// which requires canvas.  On some CI environments the module loads
// fine in the main thread but fails in workers ("Module did not
// self-register").  This helper does a quick probe so test files can
// skip tests that depend on worker-thread canvas support.

const { Worker } = require('worker_threads');

let _result;

/**
 * Returns a promise that resolves to `true` when canvas can be loaded
 * inside a worker thread, `false` otherwise.  The result is cached.
 */
function canvasWorksInWorkerThread() {
  if (_result !== undefined) return _result;

  _result = new Promise((resolve) => {
    try {
      const worker = new Worker(
        `
        const { parentPort } = require('worker_threads');
        try {
          const { createCanvas } = require('canvas');
          createCanvas(1, 1);
          parentPort.postMessage(true);
        } catch {
          parentPort.postMessage(false);
        }
        `,
        { eval: true }
      );

      worker.on('message', (ok) => {
        worker.terminate().then(() => resolve(ok));
      });
      worker.on('error', () => {
        resolve(false);
      });
      worker.on('exit', (code) => {
        // If the worker exits without sending a message, canvas failed.
        if (code !== 0) resolve(false);
      });

      // Safety timeout — don't hang forever.
      setTimeout(() => {
        worker.terminate().then(() => resolve(false));
      }, 5000);
    } catch {
      resolve(false);
    }
  });

  return _result;
}

module.exports = canvasWorksInWorkerThread;
