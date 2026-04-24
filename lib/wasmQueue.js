// Shared serialization queue for harfbuzzjs WASM calls.
// harfbuzzjs returns corrupt results when multiple calls run concurrently
// on the shared module instance. This queue ensures only one WASM
// operation runs at a time across getFontInfo and collectFeatureGlyphIds.
let queue = Promise.resolve();

function enqueue(fn) {
  // Chain fn after the previous task settles. Both handlers wrap fn() in
  // an arrow to avoid leaking the previous result/error as an argument.
  // The error handler ensures a prior rejection doesn't block the queue.
  queue = queue.then(
    () => fn(),
    () => fn()
  );
  return queue;
}

module.exports = enqueue;
