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
  } catch {
    promise = fontverter.convert(buffer, 'sfnt');
  }
  // Evict on rejection so retries with the same buffer aren't stuck
  promise.catch(() => sfntPromiseByBuffer.delete(buffer));
  sfntPromiseByBuffer.set(buffer, promise);
  return promise;
}

module.exports = { toSfnt };
