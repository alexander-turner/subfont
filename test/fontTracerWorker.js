const expect = require('unexpected');
const { Worker } = require('worker_threads');
const pathModule = require('path');

const workerPath = pathModule.resolve(__dirname, '../lib/fontTracerWorker.js');

function createWorker() {
  return new Worker(workerPath);
}

function sendAndAwait(worker, msg) {
  return new Promise((resolve, reject) => {
    const handler = (response) => {
      if (response.taskId === msg.taskId || response.type === 'ready') {
        worker.off('message', handler);
        resolve(response);
      }
    };
    worker.on('message', handler);
    worker.on('error', reject);
    worker.postMessage(msg);
  });
}

describe('fontTracerWorker', function () {
  this.timeout(30000);

  it('should respond with ready on init message', async function () {
    const worker = createWorker();
    const response = await sendAndAwait(worker, { type: 'init' });
    expect(response, 'to satisfy', { type: 'ready' });
    await worker.terminate();
  });

  it('should trace font usage from HTML and return results', async function () {
    const worker = createWorker();
    await sendAndAwait(worker, { type: 'init' });

    const response = await sendAndAwait(worker, {
      type: 'trace',
      taskId: 'test-1',
      htmlText:
        '<html><body><p style="font-family: Arial">Hello world</p></body></html>',
      stylesheetsWithPredicates: [],
    });

    expect(response, 'to satisfy', {
      type: 'result',
      taskId: 'test-1',
      textByProps: expect.it('to be an', 'array'),
    });

    await worker.terminate();
  });

  it('should handle CSS stylesheets passed via stylesheetsWithPredicates', async function () {
    const worker = createWorker();
    await sendAndAwait(worker, { type: 'init' });

    const response = await sendAndAwait(worker, {
      type: 'trace',
      taskId: 'test-2',
      htmlText: '<html><head></head><body><h1>Styled text</h1></body></html>',
      stylesheetsWithPredicates: [
        {
          text: "h1 { font-family: 'Roboto', sans-serif; font-weight: bold; }",
          predicates: {},
        },
      ],
    });

    expect(response, 'to satisfy', {
      type: 'result',
      taskId: 'test-2',
    });
    expect(response.textByProps, 'to be an', 'array');

    await worker.terminate();
  });

  it('should return an error message for invalid input', async function () {
    const worker = createWorker();
    await sendAndAwait(worker, { type: 'init' });

    const response = await sendAndAwait(worker, {
      type: 'trace',
      taskId: 'test-err',
      htmlText: null,
      stylesheetsWithPredicates: null,
    });

    expect(response, 'to satisfy', {
      type: 'error',
      taskId: 'test-err',
      error: expect.it('to be a string'),
    });

    await worker.terminate();
  });

  it('should handle empty HTML gracefully', async function () {
    const worker = createWorker();
    await sendAndAwait(worker, { type: 'init' });

    const response = await sendAndAwait(worker, {
      type: 'trace',
      taskId: 'test-empty',
      htmlText: '',
      stylesheetsWithPredicates: [],
    });

    expect(response, 'to satisfy', {
      type: 'result',
      taskId: 'test-empty',
      textByProps: expect.it('to be an', 'array'),
    });

    await worker.terminate();
  });

  it('should process multiple sequential trace requests', async function () {
    const worker = createWorker();
    await sendAndAwait(worker, { type: 'init' });

    const r1 = await sendAndAwait(worker, {
      type: 'trace',
      taskId: 'seq-1',
      htmlText: '<html><body><p>First</p></body></html>',
      stylesheetsWithPredicates: [],
    });

    const r2 = await sendAndAwait(worker, {
      type: 'trace',
      taskId: 'seq-2',
      htmlText: '<html><body><p>Second</p></body></html>',
      stylesheetsWithPredicates: [],
    });

    expect(r1.taskId, 'to equal', 'seq-1');
    expect(r2.taskId, 'to equal', 'seq-2');

    await worker.terminate();
  });
});
