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

// Serialization queue: harfbuzzjs uses shared WASM memory that produces
// corrupt results (e.g. empty characterSet) under concurrent access.
// This promise chain ensures only one parse runs at a time. Callers can
// still use Promise.all — calls queue up and resolve in order. The WeakMap
// cache above prevents redundant parses of the same buffer.
// The rejection handler (second arg to .then) keeps the queue moving
// after a failed parse.
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
