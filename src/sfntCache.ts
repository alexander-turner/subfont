import * as fontverter from 'fontverter';
import { convert } from './fontConverter';

type FontBuffer = Buffer | Uint8Array;

const sfntPromiseByBuffer = new WeakMap<object, Promise<FontBuffer>>();

export function toSfnt(buffer: FontBuffer): Promise<FontBuffer> {
  const cached = sfntPromiseByBuffer.get(buffer as object);
  if (cached) return cached;

  let promise: Promise<FontBuffer>;
  try {
    const format = fontverter.detectFormat(buffer);
    if (format === 'sfnt') {
      promise = Promise.resolve(buffer);
    } else if (format === 'woff2') {
      promise = convert(buffer, 'sfnt');
    } else {
      promise = fontverter.convert(buffer, 'sfnt');
    }
  } catch {
    promise = convert(buffer, 'sfnt');
  }
  // Evict on rejection so retries with the same buffer aren't stuck
  promise.catch(() => sfntPromiseByBuffer.delete(buffer as object));
  sfntPromiseByBuffer.set(buffer as object, promise);
  return promise;
}
