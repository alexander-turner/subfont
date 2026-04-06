const fontverter = require('fontverter');

// Cache sfnt conversions by source buffer to avoid redundant work
// when the same font is processed by getFontInfo, collectFeatureGlyphIds,
// and subsetFontWithGlyphs.
const sfntPromiseByBuffer = new WeakMap();

function toSfnt(buffer) {
  if (sfntPromiseByBuffer.has(buffer)) {
    return sfntPromiseByBuffer.get(buffer);
  }
  let promise;
  try {
    const format = fontverter.detectFormat(buffer);
    promise =
      format === 'sfnt'
        ? Promise.resolve(buffer)
        : fontverter.convert(buffer, 'sfnt');
  } catch (err) {
    // Let the caller handle unrecognized formats — don't cache failures
    // so retries with the same buffer still work (matches getFontInfo's
    // cache eviction behavior).
    return fontverter.convert(buffer, 'sfnt');
  }
  sfntPromiseByBuffer.set(buffer, promise);
  return promise;
}

module.exports = { toSfnt };
