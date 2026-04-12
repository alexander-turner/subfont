const expect = require('unexpected');

// wasmQueue is a module-level singleton, so we need a fresh copy for each test
// to avoid cross-test pollution of the internal promise chain.
function freshEnqueue() {
  delete require.cache[require.resolve('../lib/wasmQueue')];
  return require('../lib/wasmQueue');
}

describe('wasmQueue', function () {
  it('should run a single async function and return its result', async function () {
    const enqueue = freshEnqueue();
    const result = await enqueue(() => Promise.resolve(42));
    expect(result, 'to equal', 42);
  });

  it('should serialize concurrent calls', async function () {
    const enqueue = freshEnqueue();
    const order = [];

    const p1 = enqueue(
      () =>
        new Promise((resolve) => {
          order.push('start-1');
          setTimeout(() => {
            order.push('end-1');
            resolve('a');
          }, 50);
        })
    );

    const p2 = enqueue(
      () =>
        new Promise((resolve) => {
          order.push('start-2');
          setTimeout(() => {
            order.push('end-2');
            resolve('b');
          }, 10);
        })
    );

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1, 'to equal', 'a');
    expect(r2, 'to equal', 'b');
    // Second function must not start until first finishes
    expect(order, 'to equal', ['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('should continue processing after a rejected function', async function () {
    const enqueue = freshEnqueue();

    const p1 = enqueue(() => Promise.reject(new Error('boom')));
    const p2 = enqueue(() => Promise.resolve('ok'));

    // The first call should propagate the rejection
    await expect(p1, 'to be rejected with', 'boom');
    // The second call should still execute and resolve
    expect(await p2, 'to equal', 'ok');
  });

  it('should propagate synchronous errors from the function', async function () {
    const enqueue = freshEnqueue();

    const p = enqueue(() => {
      throw new Error('sync error');
    });

    await expect(p, 'to be rejected with', 'sync error');
  });

  it('should preserve ordering across many queued calls', async function () {
    const enqueue = freshEnqueue();
    const results = [];

    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        enqueue(() => {
          results.push(i);
          return Promise.resolve(i);
        })
      );
    }

    const resolved = await Promise.all(promises);
    expect(resolved, 'to equal', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(results, 'to equal', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
