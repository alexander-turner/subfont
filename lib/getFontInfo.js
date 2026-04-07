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

const enqueueWasm = require('./wasmQueue');

module.exports = function getFontInfo(buffer) {
  if (!fontInfoPromiseByBuffer.has(buffer)) {
    const promise = enqueueWasm(() => getFontInfoFromBuffer(buffer)).catch(
      (err) => {
        // Evict rejected promises so retries with the same buffer aren't stuck
        fontInfoPromiseByBuffer.delete(buffer);
        throw err;
      }
    );
    fontInfoPromiseByBuffer.set(buffer, promise);
  }
  return fontInfoPromiseByBuffer.get(buffer);
};
