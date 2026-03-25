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

// Serialization queue: harfbuzzjs WASM returns corrupt results (empty
// characterSet) when multiple getFontInfoFromBuffer calls run concurrently.
// This queue ensures only one WASM parse runs at a time while allowing
// callers to use Promise.all safely.
let wasmQueue = Promise.resolve();

module.exports = function getFontInfo(buffer) {
  if (!fontInfoPromiseByBuffer.has(buffer)) {
    // Chain onto the queue so WASM calls execute one at a time
    const promise = (wasmQueue = wasmQueue.then(
      () => getFontInfoFromBuffer(buffer),
      () => getFontInfoFromBuffer(buffer) // Also run after rejection
    ));
    fontInfoPromiseByBuffer.set(buffer, promise);
  }
  return fontInfoPromiseByBuffer.get(buffer);
};
