const { readFile } = require('fs').promises;
const fontverter = require('fontverter');

function HB_TAG(str) {
  return str.split('').reduce(function (a, ch) {
    return (a << 8) + ch.charCodeAt(0);
  }, 0);
}

let wasmPromise;
function loadWasm() {
  if (!wasmPromise) {
    wasmPromise = readFile(require.resolve('harfbuzzjs/hb-subset.wasm')).then(
      (buf) => WebAssembly.instantiate(buf)
    );
  }
  return wasmPromise;
}

/**
 * Subset a font, optionally including specific glyph IDs.
 *
 * This wraps HarfBuzz's subsetter directly (like subset-font does) but
 * additionally supports adding glyph IDs to the subset input. This allows
 * preserving GSUB alternate glyphs without including all codepoints from
 * the original font.
 *
 * @param {Buffer} originalFont - The original font data
 * @param {string} text - Unicode text whose codepoints to include
 * @param {object} options
 * @param {string} options.targetFormat - Output format (woff, woff2, truetype)
 * @param {number[]} [options.glyphIds] - Additional glyph IDs to include
 * @param {object} [options.variationAxes] - Variation axis settings
 * @returns {Promise<Buffer>} The subsetted font
 */
async function subsetFontWithGlyphs(
  originalFont,
  text,
  { targetFormat, glyphIds, variationAxes } = {}
) {
  const {
    instance: { exports },
  } = await loadWasm();

  const heapu8 = new Uint8Array(exports.memory.buffer);
  const ttf = await fontverter.convert(originalFont, 'truetype');

  const input = exports.hb_subset_input_create_or_fail();
  if (input === 0) {
    throw new Error('hb_subset_input_create_or_fail returned zero');
  }

  const fontBuffer = exports.malloc(ttf.byteLength);
  heapu8.set(new Uint8Array(ttf), fontBuffer);

  const blob = exports.hb_blob_create(fontBuffer, ttf.byteLength, 2, 0, 0);
  const face = exports.hb_face_create(blob, 0);
  exports.hb_blob_destroy(blob);

  // Keep all layout features (--font-features=*)
  const layoutFeatures = exports.hb_subset_input_set(
    input,
    6 // HB_SUBSET_SETS_LAYOUT_FEATURE_TAG
  );
  exports.hb_set_clear(layoutFeatures);
  exports.hb_set_invert(layoutFeatures);

  // Add unicode codepoints
  const inputUnicodes = exports.hb_subset_input_unicode_set(input);
  for (const c of text) {
    exports.hb_set_add(inputUnicodes, c.codePointAt(0));
  }

  // Add specific glyph IDs to preserve alternate glyphs
  if (glyphIds && glyphIds.length > 0) {
    const glyphSet = exports.hb_subset_input_set(
      input,
      1 // HB_SUBSET_SETS_GLYPH_INDEX
    );
    for (const gid of glyphIds) {
      exports.hb_set_add(glyphSet, gid);
    }
  }

  // Handle variation axes
  if (variationAxes) {
    for (const [axisName, value] of Object.entries(variationAxes)) {
      if (typeof value === 'number') {
        if (
          !exports.hb_subset_input_pin_axis_location(
            input,
            face,
            HB_TAG(axisName),
            value
          )
        ) {
          exports.hb_face_destroy(face);
          exports.free(fontBuffer);
          throw new Error(`Failed to pin axis ${axisName} to ${value}`);
        }
      } else if (value && typeof value === 'object') {
        if (
          !exports.hb_subset_input_set_axis_range(
            input,
            face,
            HB_TAG(axisName),
            value.min,
            value.max,
            value.default ?? NaN
          )
        ) {
          exports.hb_face_destroy(face);
          exports.free(fontBuffer);
          throw new Error(`Failed to set axis range for ${axisName}`);
        }
      }
    }
  }

  let subset;
  try {
    subset = exports.hb_subset_or_fail(face, input);
    if (subset === 0) {
      exports.hb_face_destroy(face);
      exports.free(fontBuffer);
      throw new Error('hb_subset_or_fail returned zero');
    }
  } finally {
    exports.hb_subset_input_destroy(input);
  }

  const result = exports.hb_face_reference_blob(subset);
  const offset = exports.hb_blob_get_data(result, 0);
  const subsetByteLength = exports.hb_blob_get_length(result);

  if (subsetByteLength === 0) {
    exports.hb_blob_destroy(result);
    exports.hb_face_destroy(subset);
    exports.hb_face_destroy(face);
    exports.free(fontBuffer);
    throw new Error('Failed to create subset font');
  }

  const subsetFont = Buffer.from(
    heapu8.subarray(offset, offset + subsetByteLength)
  );

  exports.hb_blob_destroy(result);
  exports.hb_face_destroy(subset);
  exports.hb_face_destroy(face);
  exports.free(fontBuffer);

  return fontverter.convert(subsetFont, targetFormat, 'truetype');
}

const limiter = require('p-limit')(1);
module.exports = (...args) => limiter(() => subsetFontWithGlyphs(...args));
