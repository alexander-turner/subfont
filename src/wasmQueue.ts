// Shared serialization queue for harfbuzzjs WASM calls.
// harfbuzzjs returns corrupt results when multiple calls run concurrently
// on the shared module instance. This queue ensures only one WASM
// operation runs at a time across getFontInfo and collectFeatureGlyphIds.
//
// The previous task's resolved value is irrelevant — the queue only sequences
// in-flight work — so we erase it via .then(() => undefined).
let queue: Promise<void> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  // Chain fn after the previous task settles. Both handlers wrap fn() in
  // an arrow to avoid leaking the previous result/error as an argument.
  // The error handler ensures a prior rejection doesn't block the queue.
  const next = queue.then(
    () => fn(),
    () => fn()
  );
  // Discard the resolved value (and swallow rejections for queue advancement
  // only — the caller sees the original promise via `next`).
  queue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export = enqueue;
