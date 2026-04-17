// Shared serialization queue for harfbuzzjs WASM calls.
// harfbuzzjs returns corrupt results when multiple calls run concurrently
// on the shared module instance. This queue ensures only one WASM
// operation runs at a time across getFontInfo and collectFeatureGlyphIds.
let queue = Promise.resolve();

function enqueue(fn) {
  return (queue = queue.then(
    () => fn(),
    () => fn()
  ));
}

module.exports = enqueue;
