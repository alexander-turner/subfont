const fontverter = require('fontverter');

// Cache sfnt conversions by source buffer to avoid redundant work
// when the same font is processed by getFontInfo, collectFeatureGlyphIds,
// and subsetFontWithGlyphs.
const sfntPromiseByBuffer = new WeakMap();

function toSfnt(buffer) {
  if (sfntPromiseByBuffer.has(buffer)) {
    return sfntPromiseByBuffer.get(buffer);
  }
  const format = fontverter.detectFormat(buffer);
  const promise =
    format === 'sfnt'
      ? Promise.resolve(buffer)
      : fontverter.convert(buffer, 'sfnt');
  sfntPromiseByBuffer.set(buffer, promise);
  return promise;
}

module.exports = { toSfnt };
