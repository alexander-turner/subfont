const os = require('os');
const pathModule = require('path');
const { Worker } = require('worker_threads');

const POOL_SIZE = Math.max(1, Math.min(os.cpus().length, 4));
const TASK_TIMEOUT_MS = 60_000;

let _instance;

class FontConverterPool {
  constructor(size = POOL_SIZE) {
    this._size = size;
    this._workers = [];
    this._idle = [];
    this._pendingTasks = [];
    this._taskCallbacks = new Map();
    this._taskTimers = new Map();
    this._taskByWorker = new Map();
    this._nextTaskId = 0;
    this._initPromise = null;
    this._activeTaskCount = 0;
  }

  warmup() {
    return this._ensureInit();
  }

  _ensureInit() {
    if (!this._initPromise) {
      this._initPromise = this._doInit().catch((err) => {
        this._initPromise = null;
        throw err;
      });
    }
    return this._initPromise;
  }

  async _doInit() {
    const workerPath = pathModule.join(__dirname, 'fontConverterWorker.js');
    const initPromises = [];

    for (let i = 0; i < this._size; i++) {
      const worker = new Worker(workerPath);
      worker.unref();
      this._workers.push(worker);

      const p = new Promise((resolve, reject) => {
        const onMessage = (msg) => {
          if (msg.type === 'ready') {
            worker.off('message', onMessage);
            worker.off('error', onError);
            worker.on('message', (m) => this._onWorkerMessage(worker, m));
            worker.on('exit', (code) => this._onWorkerExit(worker, code));
            this._idle.push(worker);
            resolve();
          } else if (msg.type === 'initError') {
            worker.off('message', onMessage);
            worker.off('error', onError);
            reject(new Error(`Worker init failed: ${msg.error}`));
          }
        };
        const onError = (err) => {
          worker.off('message', onMessage);
          reject(err);
        };
        worker.on('message', onMessage);
        worker.on('error', onError);
      });

      worker.postMessage({ type: 'init' });
      initPromises.push(p);
    }

    await Promise.all(initPromises);
  }

  _clearTaskTimer(taskId) {
    const timer = this._taskTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this._taskTimers.delete(taskId);
    }
  }

  _startTaskTimer(taskId) {
    const timer = setTimeout(() => {
      this._taskTimers.delete(taskId);
      const cb = this._taskCallbacks.get(taskId);
      if (cb) {
        this._taskCallbacks.delete(taskId);
        this._activeTaskCount--;
        cb.reject(
          new Error(
            `Font conversion task ${taskId} timed out after ${TASK_TIMEOUT_MS}ms`
          )
        );
      }
      for (const [worker, tid] of this._taskByWorker) {
        if (tid === taskId) {
          this._taskByWorker.delete(worker);
          worker.terminate();
          break;
        }
      }
      this._maybeShutdown();
    }, TASK_TIMEOUT_MS);
    timer.unref();
    this._taskTimers.set(taskId, timer);
  }

  _onWorkerMessage(worker, msg) {
    this._taskByWorker.delete(worker);
    this._clearTaskTimer(msg.taskId);
    const cb = this._taskCallbacks.get(msg.taskId);
    if (cb) {
      this._taskCallbacks.delete(msg.taskId);
      this._activeTaskCount--;
      if (msg.type === 'result') {
        cb.resolve(Buffer.from(msg.buffer));
      } else if (msg.type === 'error') {
        cb.reject(new Error(msg.error));
      }
    }
    this._idle.push(worker);
    this._dispatchPending();
    this._maybeShutdown();
  }

  _onWorkerExit(worker, code) {
    const idx = this._workers.indexOf(worker);
    if (idx !== -1) this._workers.splice(idx, 1);
    const idleIdx = this._idle.indexOf(worker);
    if (idleIdx !== -1) this._idle.splice(idleIdx, 1);

    if (code !== 0) {
      const taskId = this._taskByWorker.get(worker);
      this._taskByWorker.delete(worker);
      if (taskId !== undefined) {
        this._clearTaskTimer(taskId);
        const cb = this._taskCallbacks.get(taskId);
        if (cb) {
          this._taskCallbacks.delete(taskId);
          this._activeTaskCount--;
          cb.reject(
            new Error(`Font converter worker exited with code ${code}`)
          );
        }
      }

      if (this._workers.length === 0) {
        for (const task of this._pendingTasks) {
          const cb = this._taskCallbacks.get(task.message.taskId);
          if (cb) {
            this._taskCallbacks.delete(task.message.taskId);
            this._activeTaskCount--;
            cb.reject(new Error('All font converter workers have crashed'));
          }
        }
        this._pendingTasks = [];
      }
    }
  }

  // Terminate all workers when no tasks remain so the process can exit.
  // The pool re-initializes on the next convert() call.
  _maybeShutdown() {
    if (
      this._activeTaskCount === 0 &&
      this._pendingTasks.length === 0 &&
      this._workers.length > 0
    ) {
      for (const worker of this._workers) {
        worker.removeAllListeners();
        worker.terminate();
      }
      this._workers = [];
      this._idle = [];
      this._initPromise = null;
    }
  }

  _dispatchPending() {
    while (this._idle.length > 0 && this._pendingTasks.length > 0) {
      const worker = this._idle.pop();
      const task = this._pendingTasks.shift();
      this._taskByWorker.set(worker, task.message.taskId);
      try {
        worker.postMessage(task.message);
        this._startTaskTimer(task.message.taskId);
      } catch (err) {
        this._taskByWorker.delete(worker);
        this._idle.push(worker);
        const cb = this._taskCallbacks.get(task.message.taskId);
        if (cb) {
          this._taskCallbacks.delete(task.message.taskId);
          this._activeTaskCount--;
          cb.reject(err);
        }
      }
    }
  }

  async convert(buffer, targetFormat, sourceFormat) {
    // Increment BEFORE awaiting init to prevent _maybeShutdown from
    // tearing down workers between init resolution and task dispatch.
    this._activeTaskCount++;
    try {
      await this._ensureInit();
    } catch (err) {
      this._activeTaskCount--;
      throw err;
    }

    const taskId = this._nextTaskId++;
    const message = {
      type: 'convert',
      taskId,
      buffer,
      targetFormat,
      sourceFormat,
    };

    return new Promise((resolve, reject) => {
      this._taskCallbacks.set(taskId, { resolve, reject });
      this._pendingTasks.push({ message });
      this._dispatchPending();
    });
  }

  async destroy() {
    for (const timer of this._taskTimers.values()) {
      clearTimeout(timer);
    }
    this._taskTimers.clear();

    for (const task of this._pendingTasks) {
      const cb = this._taskCallbacks.get(task.message.taskId);
      if (cb) {
        this._taskCallbacks.delete(task.message.taskId);
        cb.reject(new Error('Font converter pool destroyed'));
      }
    }
    this._pendingTasks = [];

    for (const [, taskId] of this._taskByWorker) {
      const cb = this._taskCallbacks.get(taskId);
      if (cb) {
        this._taskCallbacks.delete(taskId);
        cb.reject(new Error('Font converter pool destroyed'));
      }
    }
    this._taskByWorker.clear();
    this._activeTaskCount = 0;

    for (const worker of this._workers) {
      worker.removeAllListeners();
    }
    await Promise.all(this._workers.map((w) => w.terminate()));
    this._workers = [];
    this._idle = [];
    this._initPromise = null;
  }
}

function getPool() {
  if (!_instance) {
    _instance = new FontConverterPool();
  }
  return _instance;
}

module.exports = { FontConverterPool, getPool };
