import { toSfnt } from './sfntCache';
import enqueueWasm = require('./wasmQueue');

interface FontInfo {
  characterSet: number[];
  variationAxes: Record<string, { min: number; max: number; default: number }>;
}

async function getFontInfoFromBuffer(
  buffer: Buffer | Uint8Array
): Promise<FontInfo> {
  // harfbuzzjs is itself thenable; awaiting its require yields the API.
  const harfbuzzJs = await require('harfbuzzjs');

  const blob = harfbuzzJs.createBlob(await toSfnt(buffer));
  const face = harfbuzzJs.createFace(blob, 0);

  const fontInfo: FontInfo = {
    characterSet: Array.from(face.collectUnicodes()),
    variationAxes: face.getAxisInfos(),
  };

  face.destroy();
  blob.destroy();

  return fontInfo;
}

const fontInfoPromiseByBuffer = new WeakMap<object, Promise<FontInfo>>();

function getFontInfo(buffer: Buffer | Uint8Array): Promise<FontInfo> {
  const key = buffer as object;
  let cached = fontInfoPromiseByBuffer.get(key);
  if (!cached) {
    cached = enqueueWasm(() => getFontInfoFromBuffer(buffer)).catch(
      // eslint-disable-next-line no-restricted-syntax
      (err: unknown) => {
        // Evict rejected promises so retries with the same buffer aren't stuck
        fontInfoPromiseByBuffer.delete(key);
        throw err;
      }
    );
    fontInfoPromiseByBuffer.set(key, cached);
  }
  return cached;
}

export = getFontInfo;
