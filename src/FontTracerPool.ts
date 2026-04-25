import pathModule = require('path');
import { Worker } from 'worker_threads';

/**
 * Worker pool for running fontTracer in parallel across pages.
 * Each worker re-parses HTML with jsdom and runs fontTracer independently.
 */
const DEFAULT_TASK_TIMEOUT_MS = 60_000;

interface TaskCallbacks {
  // The pool is generic over the trace payload; the caller knows the
  // concrete shape (font-tracer's textByProps Map).
  // eslint-disable-next-line no-restricted-syntax
  resolve: (value: unknown) => void;
  // eslint-disable-next-line no-restricted-syntax
  reject: (reason?: unknown) => void;
}

interface StylesheetWithPredicates {
  text?: string;
  asset?: { text?: string };
  // CSS-tracing predicates are opaque to the pool — it just passes them
  // through to the worker thread.
  // eslint-disable-next-line no-restricted-syntax
  predicates?: Record<string, unknown>;
}

interface TraceMessage {
  type: 'trace';
  taskId: number;
  htmlText: string;
  stylesheetsWithPredicates: Array<{
    text: string;
    // eslint-disable-next-line no-restricted-syntax
    predicates: Record<string, unknown>;
  }>;
}

interface WorkerResultMessage {
  type: 'result';
  taskId: number;
  // The trace result shape lives in font-tracer; the pool is unaware.
  // eslint-disable-next-line no-restricted-syntax
  textByProps: unknown;
}

interface WorkerErrorMessage {
  type: 'error';
  taskId: number;
  error: string;
  stack?: string;
}

interface WorkerReadyMessage {
  type: 'ready';
}

type WorkerMessage =
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerReadyMessage;

interface FontTracerPoolOptions {
  taskTimeoutMs?: number;
}

class FontTracerPool {
  private _workerPath: string;
  private _numWorkers: number;
  private _taskTimeoutMs: number;
  private _workers: Worker[];
  private _idle: Worker[];
  private _pendingTasks: Array<{ message: TraceMessage }>;
  private _taskCallbacks: Map<number, TaskCallbacks>;
  private _taskTimers: Map<number, NodeJS.Timeout>;
  private _taskByWorker: Map<Worker, number>;
  private _nextTaskId: number;

  constructor(
    numWorkers: number,
    { taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS }: FontTracerPoolOptions = {}
  ) {
    this._workerPath = pathModule.join(__dirname, 'fontTracerWorker.js');
    this._numWorkers = numWorkers;
    this._taskTimeoutMs = taskTimeoutMs;
    this._workers = [];
    this._idle = [];
    this._pendingTasks = [];
    this._taskCallbacks = new Map();
    this._taskTimers = new Map();
    this._taskByWorker = new Map();
    this._nextTaskId = 0;
  }

  async init(): Promise<void> {
    const initPromises: Array<Promise<void>> = [];
    for (let i = 0; i < this._numWorkers; i++) {
      const worker = new Worker(this._workerPath);
      this._workers.push(worker);

      const initPromise = new Promise<void>((resolve, reject) => {
        const onError = reject;
        const onMessage = (msg: WorkerMessage) => {
          if (msg.type === 'ready') {
            worker.off('message', onMessage);
            worker.off('error', onError);
            worker.on('message', (msg: WorkerMessage) =>
              this._onWorkerMessage(worker, msg)
            );
            worker.on('exit', (code: number) =>
              this._onWorkerExit(worker, code)
            );
            this._idle.push(worker);
            resolve();
          }
        };
        worker.on('message', onMessage);
        worker.on('error', onError);
      });

      worker.postMessage({ type: 'init' });

      initPromises.push(initPromise);
    }
    await Promise.all(initPromises);
  }

  private _clearTaskTimer(taskId: number): void {
    const timer = this._taskTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this._taskTimers.delete(taskId);
    }
  }

  private _onWorkerMessage(worker: Worker, msg: WorkerMessage): void {
    if (msg.type === 'ready') return;
    this._taskByWorker.delete(worker);
    this._clearTaskTimer(msg.taskId);
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

  private _onWorkerExit(worker: Worker, code: number): void {
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
        this._clearTaskTimer(taskId);
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

  private _startTaskTimer(taskId: number): void {
    if (this._taskTimeoutMs <= 0) return;
    const timer = setTimeout(() => {
      this._taskTimers.delete(taskId);
      const cb = this._taskCallbacks.get(taskId);
      if (cb) {
        this._taskCallbacks.delete(taskId);
        cb.reject(
          new Error(
            `Font tracing task ${taskId} timed out after ${this._taskTimeoutMs}ms`
          )
        );
      }
      // Terminate the hung worker so it doesn't permanently consume a pool
      // slot. _onWorkerExit will remove it from _workers and _idle.
      for (const [worker, tid] of this._taskByWorker) {
        if (tid === taskId) {
          this._taskByWorker.delete(worker);
          worker.terminate();
          break;
        }
      }
    }, this._taskTimeoutMs);
    timer.unref();
    this._taskTimers.set(taskId, timer);
  }

  private _dispatchPending(): void {
    while (this._idle.length > 0 && this._pendingTasks.length > 0) {
      const worker = this._idle.pop() as Worker;
      const task = this._pendingTasks.shift() as { message: TraceMessage };
      this._taskByWorker.set(worker, task.message.taskId);
      try {
        worker.postMessage(task.message);
        this._startTaskTimer(task.message.taskId);
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
  // The pool is payload-agnostic; callers (subsetFonts.ts) interpret the
  // returned textByProps according to font-tracer's contract.
  trace(
    htmlText: string,
    stylesheetsWithPredicates: StylesheetWithPredicates[]
    // eslint-disable-next-line no-restricted-syntax
  ): Promise<unknown> {
    const taskId = this._nextTaskId++;
    // Serialize stylesheets to plain data — asset objects contain DOM/PostCSS
    // trees that cannot be transferred via structured clone.
    const serializedStylesheets = stylesheetsWithPredicates.map((entry) => ({
      text: entry.text || (entry.asset && entry.asset.text) || '',
      predicates: entry.predicates || {},
    }));
    const message: TraceMessage = {
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

  async destroy(): Promise<void> {
    // Clear all task timers
    for (const timer of this._taskTimers.values()) {
      clearTimeout(timer);
    }
    this._taskTimers.clear();

    // Reject any tasks still waiting in the queue
    for (const task of this._pendingTasks) {
      const cb = this._taskCallbacks.get(task.message.taskId);
      if (cb) {
        this._taskCallbacks.delete(task.message.taskId);
        cb.reject(new Error('Worker pool destroyed'));
      }
    }
    this._pendingTasks = [];

    // Reject any in-flight tasks still assigned to workers.
    // Clear _taskByWorker before terminate() so _onWorkerExit won't double-reject.
    for (const [, taskId] of this._taskByWorker) {
      const cb = this._taskCallbacks.get(taskId);
      if (cb) {
        this._taskCallbacks.delete(taskId);
        cb.reject(new Error('Worker pool destroyed'));
      }
    }
    this._taskByWorker.clear();

    // Terminate workers with a 5-second timeout to prevent hanging
    const TERMINATE_TIMEOUT_MS = 5000;
    await Promise.all(
      this._workers.map((w) =>
        Promise.race([
          w.terminate(),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, TERMINATE_TIMEOUT_MS);
            timer.unref();
          }),
        ])
      )
    );
    this._workers = [];
    this._idle = [];
  }
}

export = FontTracerPool;
