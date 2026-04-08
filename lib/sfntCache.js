const fontverter = require('fontverter');

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
    // Unrecognized format — don't cache so retries work
    return fontverter.convert(buffer, 'sfnt');
  }
  promise.catch(() => sfntPromiseByBuffer.delete(buffer));
  sfntPromiseByBuffer.set(buffer, promise);
  return promise;
}

module.exports = { toSfnt };
