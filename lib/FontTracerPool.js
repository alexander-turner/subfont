const pathModule = require('path');
const { Worker } = require('worker_threads');

/**
 * Worker pool for running fontTracer in parallel across pages.
 * Each worker re-parses HTML with jsdom and runs fontTracer independently.
 *
 * Note: workers re-parse HTML from source text rather than reusing the
 * existing parseTree. This means results may differ subtly if jsdom's
 * parsing diverges from the main-thread parser. The main-thread fallback
 * (activated on worker failure) uses the original parseTree for safety.
 */
class FontTracerPool {
  constructor(numWorkers) {
    this._workerPath = pathModule.join(__dirname, 'fontTracerWorker.js');
    this._numWorkers = numWorkers;
    this._workers = [];
    this._idle = [];
    this._pendingTasks = [];
    this._taskCallbacks = new Map();
    this._taskByWorker = new Map(); // track which taskId each worker is processing
    this._nextTaskId = 0;
  }

  async init() {
    const initPromises = [];
    for (let i = 0; i < this._numWorkers; i++) {
      const worker = new Worker(this._workerPath);
      this._workers.push(worker);

      const initPromise = new Promise((resolve, reject) => {
        const onMessage = (msg) => {
          if (msg.type === 'ready') {
            worker.off('message', onMessage);
            worker.on('message', (msg) => this._onWorkerMessage(worker, msg));
            worker.on('exit', (code) => this._onWorkerExit(worker, code));
            this._idle.push(worker);
            resolve();
          }
        };
        worker.on('message', onMessage);
        worker.on('error', reject);
      });

      worker.postMessage({ type: 'init' });

      initPromises.push(initPromise);
    }
    await Promise.all(initPromises);
  }

  _onWorkerMessage(worker, msg) {
    this._taskByWorker.delete(worker);
    const cb = this._taskCallbacks.get(msg.taskId);
    if (cb) {
      this._taskCallbacks.delete(msg.taskId);
      if (msg.type === 'result') {
        cb.resolve(msg.textByProps);
      } else if (msg.type === 'error') {
        cb.reject(new Error(`Worker error: ${msg.error}\n${msg.stack}`));
      }
    }
    // Worker is now idle, check for pending tasks
    this._idle.push(worker);
    this._dispatchPending();
  }

  _onWorkerExit(worker, code) {
    // Remove crashed worker from tracking
    const workerIdx = this._workers.indexOf(worker);
    if (workerIdx !== -1) {
      this._workers.splice(workerIdx, 1);
    }
    const idleIdx = this._idle.indexOf(worker);
    if (idleIdx !== -1) {
      this._idle.splice(idleIdx, 1);
    }

    if (code !== 0) {
      // Reject the task that was in-flight on this worker
      const taskId = this._taskByWorker.get(worker);
      this._taskByWorker.delete(worker);
      if (taskId !== undefined) {
        const cb = this._taskCallbacks.get(taskId);
        if (cb) {
          this._taskCallbacks.delete(taskId);
          cb.reject(new Error(`Worker exited with code ${code}`));
        }
      }

      // If no workers remain, reject all pending tasks
      if (this._workers.length === 0) {
        for (const task of this._pendingTasks) {
          const cb = this._taskCallbacks.get(task.message.taskId);
          if (cb) {
            this._taskCallbacks.delete(task.message.taskId);
            cb.reject(
              new Error('All workers have crashed, no workers available')
            );
          }
        }
        this._pendingTasks = [];
      }
    }
  }

  _dispatchPending() {
    while (this._idle.length > 0 && this._pendingTasks.length > 0) {
      const worker = this._idle.pop();
      const task = this._pendingTasks.shift();
      this._taskByWorker.set(worker, task.message.taskId);
      try {
        worker.postMessage(task.message);
      } catch (err) {
        // postMessage can fail synchronously (e.g. structured clone error).
        // Return the worker to the idle pool and reject the task.
        this._taskByWorker.delete(worker);
        this._idle.push(worker);
        const cb = this._taskCallbacks.get(task.message.taskId);
        if (cb) {
          this._taskCallbacks.delete(task.message.taskId);
          cb.reject(err);
        }
      }
    }
  }

  /**
   * Run fontTracer on the given HTML text + stylesheets in a worker.
   * Returns a promise that resolves to textByProps.
   */
  trace(htmlText, stylesheetsWithPredicates) {
    const taskId = this._nextTaskId++;
    // Serialize stylesheets to plain data — asset objects contain DOM/PostCSS
    // trees that cannot be transferred via structured clone.
    const serializedStylesheets = stylesheetsWithPredicates.map((entry) => ({
      text: entry.text || (entry.asset && entry.asset.text) || '',
      predicates: entry.predicates || {},
    }));
    const message = {
      type: 'trace',
      taskId,
      htmlText,
      stylesheetsWithPredicates: serializedStylesheets,
    };

    return new Promise((resolve, reject) => {
      this._taskCallbacks.set(taskId, { resolve, reject });
      this._pendingTasks.push({ message });
      this._dispatchPending();
    });
  }

  async destroy() {
    await Promise.all(this._workers.map((w) => w.terminate()));
    this._workers = [];
    this._idle = [];
  }
}

module.exports = FontTracerPool;
