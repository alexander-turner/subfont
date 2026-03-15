const fontverter = require('fontverter');

async function getFontInfoFromBuffer(buffer) {
  const harfbuzzJs = await require('harfbuzzjs');

  const blob = harfbuzzJs.createBlob(await fontverter.convert(buffer, 'sfnt')); // Load the font data into something Harfbuzz can use
  const face = harfbuzzJs.createFace(blob, 0); // Select the first font in the file (there's normally only one!)

  const fontInfo = {
    characterSet: Array.from(face.collectUnicodes()),
    variationAxes: face.getAxisInfos(),
  };

  face.destroy();
  blob.destroy();

  return fontInfo;
}

const fontInfoPromiseByBuffer = new WeakMap();

// Serialization queue for harfbuzzjs WASM calls.
//
// Problem: harfbuzzjs uses a shared WASM memory buffer internally. When
// multiple getFontInfoFromBuffer calls run concurrently, the WASM module
// returns corrupt results — typically an empty characterSet (face.collectUnicodes()
// returns []) even though the font contains valid codepoints. This appears to
// be a reentrancy issue in the C-compiled WASM code, not a JS-level bug.
//
// Fix: This promise chain ensures only one WASM parse executes at a time.
// Callers can still use Promise.all() — their calls simply queue up and
// resolve in order. The WeakMap cache above prevents redundant parses of
// the same buffer.
//
// The second argument to .then() (the rejection handler) ensures the queue
// continues processing even if a previous parse fails, rather than stalling.
let wasmQueue = Promise.resolve();

module.exports = function getFontInfo(buffer) {
  if (!fontInfoPromiseByBuffer.has(buffer)) {
    // Chain onto the queue so WASM calls execute one at a time
    const promise = (wasmQueue = wasmQueue.then(
      () => getFontInfoFromBuffer(buffer),
      () => getFontInfoFromBuffer(buffer) // Continue queue after prior rejection
    ));
    fontInfoPromiseByBuffer.set(buffer, promise);
  }
  return fontInfoPromiseByBuffer.get(buffer);
};
