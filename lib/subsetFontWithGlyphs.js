const { readFile } = require('fs').promises;
const _ = require('lodash');
const fontverter = require('fontverter');

// Shared WASM loader — reuses the same harfbuzzjs WASM binary as subset-font.
// This file exists because subset-font doesn't expose a glyphIds option.
// We duplicate the subsetting logic but share the WASM instance via _.once.
const loadAndInitializeHarfbuzz = _.once(async () => {
  const {
    instance: { exports },
  } = await WebAssembly.instantiate(
    await readFile(require.resolve('harfbuzzjs/hb-subset.wasm'))
  );
  const heapu8 = new Uint8Array(exports.memory.buffer);
  return [exports, heapu8];
});

function HB_TAG(str) {
  return str.split('').reduce(function (a, ch) {
    return (a << 8) + ch.charCodeAt(0);
  }, 0);
}

function pinAxisLocation(exports, input, face, axisName, value) {
  const ok = exports.hb_subset_input_pin_axis_location(
    input,
    face,
    HB_TAG(axisName),
    value
  );
  if (!ok) {
    throw new Error(`Failed to pin axis ${axisName} to ${value}`);
  }
}

function setAxisRange(exports, input, face, axisName, value) {
  const ok = exports.hb_subset_input_set_axis_range(
    input,
    face,
    HB_TAG(axisName),
    value.min,
    value.max,
    value.default ?? NaN
  );
  if (!ok) {
    throw new Error(`Failed to set axis range for ${axisName}`);
  }
}

function configureSubsetInput(
  exports,
  input,
  face,
  text,
  glyphIds,
  variationAxes
) {
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
      0 // HB_SUBSET_SETS_GLYPH_INDEX
    );
    for (const gid of glyphIds) {
      exports.hb_set_add(glyphSet, gid);
    }
  }

  // Handle variation axes
  if (variationAxes) {
    for (const [axisName, value] of Object.entries(variationAxes)) {
      if (typeof value === 'number') {
        pinAxisLocation(exports, input, face, axisName, value);
      } else if (value && typeof value === 'object') {
        setAxisRange(exports, input, face, axisName, value);
      }
    }
  }
}

function extractSubsetFont(exports, heapu8, subset) {
  const result = exports.hb_face_reference_blob(subset);
  const offset = exports.hb_blob_get_data(result, 0);
  const subsetByteLength = exports.hb_blob_get_length(result);

  if (subsetByteLength === 0) {
    exports.hb_blob_destroy(result);
    throw new Error('Failed to create subset font');
  }

  const subsetFont = Buffer.from(
    heapu8.subarray(offset, offset + subsetByteLength)
  );
  exports.hb_blob_destroy(result);
  return subsetFont;
}

/**
 * Subset a font, optionally including specific glyph IDs.
 *
 * This wraps HarfBuzz's subsetter like subset-font does, but additionally
 * supports adding glyph IDs to the subset input. This preserves GSUB
 * alternate glyphs without including all codepoints from the original font.
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
  const [exports, heapu8] = await loadAndInitializeHarfbuzz();

  const format = fontverter.detectFormat(originalFont);
  const ttf =
    format === 'sfnt'
      ? originalFont
      : await fontverter.convert(originalFont, 'truetype');

  const fontBuffer = exports.malloc(ttf.byteLength);
  heapu8.set(new Uint8Array(ttf), fontBuffer);

  const blob = exports.hb_blob_create(fontBuffer, ttf.byteLength, 2, 0, 0);
  const face = exports.hb_face_create(blob, 0);
  exports.hb_blob_destroy(blob);

  const input = exports.hb_subset_input_create_or_fail();
  if (input === 0) {
    exports.hb_face_destroy(face);
    exports.free(fontBuffer);
    throw new Error('hb_subset_input_create_or_fail returned zero');
  }

  let subset = 0;
  try {
    configureSubsetInput(exports, input, face, text, glyphIds, variationAxes);

    subset = exports.hb_subset_or_fail(face, input);
    if (subset === 0) {
      throw new Error('hb_subset_or_fail returned zero');
    }

    const subsetFont = extractSubsetFont(exports, heapu8, subset);
    return fontverter.convert(subsetFont, targetFormat, 'truetype');
  } finally {
    if (subset) exports.hb_face_destroy(subset);
    exports.hb_subset_input_destroy(input);
    exports.hb_face_destroy(face);
    exports.free(fontBuffer);
  }
}

const limiter = require('p-limit')(1);
module.exports = (...args) => limiter(() => subsetFontWithGlyphs(...args));
