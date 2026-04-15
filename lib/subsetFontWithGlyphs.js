const { readFile } = require('fs').promises;
const fontverter = require('fontverter');
const { toSfnt } = require('./sfntCache');

// hb_subset_sets_t enum values — https://github.com/harfbuzz/harfbuzz/blob/main/src/hb-subset.h
const HB_SUBSET_SETS_GLYPH_INDEX = 0;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;

// subset-font doesn't expose a glyphIds option, so we call harfbuzz directly.
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

function configureSubsetInput(
  exports,
  input,
  face,
  text,
  glyphIds,
  variationAxes
) {
  const layoutFeatures = exports.hb_subset_input_set(
    input,
    HB_SUBSET_SETS_LAYOUT_FEATURE_TAG
  );
  exports.hb_set_clear(layoutFeatures);
  exports.hb_set_invert(layoutFeatures);

  const inputUnicodes = exports.hb_subset_input_unicode_set(input);
  // Include codepoints from both NFC and NFD normalized forms so the
  // subsetter covers precomposed and decomposed character variants.
  // This guards against harfbuzz subsetter not always expanding
  // codepoints to their NFC/NFD equivalents (harfbuzz issue #2283).
  const nfc = text.normalize('NFC');
  const nfd = text.normalize('NFD');
  for (const c of nfc) {
    exports.hb_set_add(inputUnicodes, c.codePointAt(0));
  }
  for (const c of nfd) {
    exports.hb_set_add(inputUnicodes, c.codePointAt(0));
  }

  if (glyphIds && glyphIds.length > 0) {
    const glyphSet = exports.hb_subset_input_set(
      input,
      HB_SUBSET_SETS_GLYPH_INDEX
    );
    for (const gid of glyphIds) {
      exports.hb_set_add(glyphSet, gid);
    }
  }

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
