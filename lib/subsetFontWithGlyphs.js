const { readFile } = require('fs').promises;
const fontverter = require('fontverter');
const { toSfnt } = require('./sfntCache');

// hb_subset_sets_t enum values — https://github.com/harfbuzz/harfbuzz/blob/main/src/hb-subset.h
const HB_SUBSET_SETS_GLYPH_INDEX = 0;
const HB_SUBSET_SETS_DROP_TABLE_TAG = 5;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;
const HB_SUBSET_SETS_NAME_ID = 4;

// hb_subset_flags_t
const HB_SUBSET_FLAGS_NO_HINTING = 0x00000001;

// All font subsetting goes through harfbuzz directly so we can apply
// web-specific optimizations (no hinting, minimal name table, table
// stripping) and support explicit glyph-ID inclusion.
let _wasmExports;
let _loadPromise;
async function loadHarfbuzz() {
  if (!_loadPromise) {
    _loadPromise = (async () => {
      const {
        instance: { exports },
      } = await WebAssembly.instantiate(
        await readFile(require.resolve('harfbuzzjs/hb-subset.wasm'))
      );
      _wasmExports = exports;
      return exports;
    })();
  }
  return _loadPromise;
}

// Re-create on every call — WASM memory.buffer is detached when memory grows,
// so a cached Uint8Array would silently read/write stale data.
function getHeapu8() {
  return new Uint8Array(_wasmExports.memory.buffer);
}

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

// Tables unnecessary for web rendering — safe to drop unconditionally.
// gasp is only meaningful when hinting is present (which we strip above).
const DROP_TABLE_TAGS = ['DSIG', 'LTSH', 'VDMX', 'hdmx', 'gasp', 'PCLT'];

// Name IDs needed for web fonts: family (1), subfamily (2), full name (4),
// PostScript name (6).  Copyright (0), unique ID (3), version (5), and
// everything above 6 are display/license metadata that browsers never read.
const KEEP_NAME_IDS = [1, 2, 4, 6];

function configureSubsetInput(
  exports,
  input,
  face,
  text,
  glyphIds,
  variationAxes
) {
  // --- Retain all layout features ---
  const layoutFeatures = exports.hb_subset_input_set(
    input,
    HB_SUBSET_SETS_LAYOUT_FEATURE_TAG
  );
  exports.hb_set_clear(layoutFeatures);
  exports.hb_set_invert(layoutFeatures);

  // --- Strip hinting instructions (ignored by modern browsers) ---
  const flags = exports.hb_subset_input_get_flags(input);
  exports.hb_subset_input_set_flags(input, flags | HB_SUBSET_FLAGS_NO_HINTING);

  // --- Keep only essential name table entries ---
  const nameIdSet = exports.hb_subset_input_set(input, HB_SUBSET_SETS_NAME_ID);
  exports.hb_set_clear(nameIdSet);
  for (const id of KEEP_NAME_IDS) {
    exports.hb_set_add(nameIdSet, id);
  }

  // --- Drop tables not needed for web rendering ---
  const dropTableSet = exports.hb_subset_input_set(
    input,
    HB_SUBSET_SETS_DROP_TABLE_TAG
  );
  for (const tag of DROP_TABLE_TAGS) {
    exports.hb_set_add(dropTableSet, HB_TAG(tag));
  }

  // --- Add unicode codepoints ---
  const inputUnicodes = exports.hb_subset_input_unicode_set(input);
  for (const c of text) {
    exports.hb_set_add(inputUnicodes, c.codePointAt(0));
  }

  // --- Add explicit glyph IDs (from feature glyph collection) ---
  if (glyphIds && glyphIds.length > 0) {
    const glyphSet = exports.hb_subset_input_set(
      input,
      HB_SUBSET_SETS_GLYPH_INDEX
    );
    for (const gid of glyphIds) {
      exports.hb_set_add(glyphSet, gid);
    }
  }

  // --- Pin/reduce variation axes ---
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

async function subsetFontWithGlyphs(
  originalFont,
  text,
  { targetFormat, glyphIds, variationAxes } = {}
) {
  const exports = await loadHarfbuzz();

  // Reuse cached sfnt conversion when available (same buffer may have
  // been converted by getFontInfo or collectFeatureGlyphIds already).
  const ttf = await toSfnt(originalFont);

  const fontBuffer = exports.malloc(ttf.byteLength);
  // Fresh view — memory.buffer may have been detached by a prior malloc/grow.
  getHeapu8().set(new Uint8Array(ttf), fontBuffer);

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

    const subsetFont = extractSubsetFont(exports, getHeapu8(), subset);
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
