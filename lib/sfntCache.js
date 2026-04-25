const fontverter = require('fontverter');
const { getPool } = require('./fontConverterPool');

const sfntPromiseByBuffer = new WeakMap();

function toSfnt(buffer) {
  if (sfntPromiseByBuffer.has(buffer)) {
    return sfntPromiseByBuffer.get(buffer);
  }
  let promise;
  try {
    const format = fontverter.detectFormat(buffer);
    if (format === 'sfnt') {
      promise = Promise.resolve(buffer);
    } else if (format === 'woff2') {
      promise = getPool().convert(buffer, 'sfnt');
    } else {
      promise = fontverter.convert(buffer, 'sfnt');
    }
  } catch {
    promise = getPool().convert(buffer, 'sfnt');
  }
  promise.catch(() => sfntPromiseByBuffer.delete(buffer));
  sfntPromiseByBuffer.set(buffer, promise);
  return promise;
}

module.exports = { toSfnt };
