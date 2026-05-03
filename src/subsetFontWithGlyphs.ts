import os = require('os');
import { readFile } from 'fs/promises';
import * as fontverter from 'fontverter';
import { toSfnt } from './sfntCache';
import { convert as convertInWorker } from './fontConverter';

// hb_subset_sets_t enum values — https://github.com/harfbuzz/harfbuzz/blob/main/src/hb-subset.h
const HB_SUBSET_SETS_GLYPH_INDEX = 0;
const HB_SUBSET_SETS_DROP_TABLE_TAG = 3;
const HB_SUBSET_SETS_NAME_ID = 4;
const HB_SUBSET_SETS_NAME_LANG_ID = 5;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;
const HB_SUBSET_SETS_LAYOUT_SCRIPT_TAG = 7;

// Windows English (United States). The only name-table language we keep —
// browsers don't expose localized name strings to web pages, so other lang
// IDs are pure overhead.
const KEEP_NAME_LANG_ID_EN_US = 0x0409;

// hb_subset_flags_t
const HB_SUBSET_FLAGS_NO_HINTING = 0x00000001;

// Minimal shape of the harfbuzz subsetter WASM exports we actually call.
// All pointers are exposed as numbers (WASM i32).
interface HarfbuzzExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  hb_blob_create(
    data: number,
    length: number,
    mode: number,
    userData: number,
    destroy: number
  ): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, lengthOut: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, codepoint: number): void;
  hb_set_clear(set: number): void;
  hb_set_invert(set: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_get_flags(input: number): number;
  hb_subset_input_set_flags(input: number, flags: number): void;
  hb_subset_input_pin_axis_location(
    input: number,
    face: number,
    tag: number,
    value: number
  ): boolean | number;
  hb_subset_input_set_axis_range(
    input: number,
    face: number,
    tag: number,
    min: number,
    max: number,
    def: number
  ): boolean | number;
  hb_subset_input_set(input: number, setType: number): number;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_or_fail(face: number, input: number): number;
}

interface PoolInstance {
  exports: HarfbuzzExports;
  busy: boolean;
}

type VariationAxisValue =
  | number
  | { min: number; max: number; default?: number };

interface SubsetFontWithGlyphsOptions {
  targetFormat?: string;
  glyphIds?: number[];
  variationAxes?: Record<string, VariationAxisValue>;
  // OpenType feature tags requested by CSS (e.g. ['smcp', 'ss02']). When
  // provided, these are added to harfbuzz's built-in essential-shaping set
  // instead of retaining every layout feature in the font. When undefined,
  // fall back to retaining all layout features (legacy behavior).
  featureTags?: string[];
  // When true, drop the OpenType MATH table. Caller is responsible for
  // ensuring the page does not render math content with this font.
  dropMathTable?: boolean;
  // When true, drop COLR/CPAL/SVG/CBDT/CBLC/EBDT/EBLC/EBSC/sbix. Caller is
  // responsible for ensuring the page does not render color emoji or color
  // glyphs with this font.
  dropColorTables?: boolean;
  // OpenType script tags to retain GSUB/GPOS lookups for (e.g. ['latn',
  // 'cyrl', 'DFLT']). When provided, harfbuzz's default "retain all
  // scripts" set is replaced by exactly these tags. When undefined, all
  // scripts in the font are retained (legacy behavior).
  scriptTags?: string[];
}

// Pool of WASM instances for parallel subsetting.  Each instance has its
// own linear memory so concurrent calls are safe.  The module is compiled
// once and instantiated N times (N = CPU count, capped at 8).
let _compilePromise: Promise<WebAssembly.Module> | undefined;
function compileModule(): Promise<WebAssembly.Module> {
  if (!_compilePromise) {
    // Assign the promise synchronously so concurrent callers share it
    // (an async function would await readFile before the assignment).
    _compilePromise = readFile(
      require.resolve('harfbuzzjs/hb-subset.wasm')
    ).then((buf) => WebAssembly.compile(buf));
  }
  return _compilePromise;
}

const _pool: PoolInstance[] = [];
let _poolReady: Promise<void> | undefined;
const POOL_SIZE = Math.max(1, Math.min(os.cpus().length, 8));

async function initPool(): Promise<void> {
  if (!_poolReady) {
    _poolReady = (async () => {
      const mod = await compileModule();
      const instantiations: Array<Promise<void>> = [];
      for (let i = 0; i < POOL_SIZE; i++) {
        instantiations.push(
          WebAssembly.instantiate(mod).then((inst) => {
            _pool.push({
              // WebAssembly.Exports is opaque (Record<string, ExportValue>);
              // bridge it to our typed surface in one place.
              // eslint-disable-next-line no-restricted-syntax
              exports: inst.exports as unknown as HarfbuzzExports,
              busy: false,
            });
          })
        );
      }
      await Promise.all(instantiations);
    })();
  }
  return _poolReady;
}

// Waiters queue: callers waiting for an idle WASM instance.
const _waiters: Array<(inst: PoolInstance) => void> = [];
const ACQUIRE_TIMEOUT_MS = 120_000;

async function acquireInstance(): Promise<PoolInstance> {
  await initPool();
  const idle = _pool.find((inst) => !inst.busy);
  if (idle) {
    idle.busy = true;
    return idle;
  }
  // All instances busy — wait for one to be released.
  return new Promise<PoolInstance>((resolve, reject) => {
    const entry = (inst: PoolInstance) => {
      clearTimeout(timer);
      resolve(inst);
    };
    const timer = setTimeout(() => {
      const idx = _waiters.indexOf(entry);
      if (idx !== -1) _waiters.splice(idx, 1);
      reject(
        new Error(
          `Timed out waiting for a WASM subsetting instance after ${ACQUIRE_TIMEOUT_MS}ms`
        )
      );
    }, ACQUIRE_TIMEOUT_MS);
    timer.unref();
    _waiters.push(entry);
  });
}

function releaseInstance(inst: PoolInstance): void {
  inst.busy = false;
  if (_waiters.length > 0) {
    inst.busy = true;
    const waiter = _waiters.shift();
    if (waiter) waiter(inst);
  }
}

// woff2 encode/decode uses wawoff2's WASM module, which has a shared
// instance that corrupts memory under concurrent use.  Instead of
// serializing to p-limit(1) in the main thread, we route woff2
// operations through fontConverterPool — each worker thread loads its
// own wawoff2 instance, enabling safe parallel compression.

// Re-create on every call — WASM memory.buffer is detached when memory grows,
// so a cached Uint8Array would silently read/write stale data.
function getHeapu8(exports: HarfbuzzExports): Uint8Array {
  return new Uint8Array(exports.memory.buffer);
}

// >>> 0 keeps the accumulator unsigned; without it, tags whose first byte
// exceeds 0x7F would overflow into negative i32 territory after << 24.
function HB_TAG(str: string): number {
  return str.split('').reduce(function (a, ch) {
    return ((a << 8) >>> 0) + ch.charCodeAt(0);
  }, 0);
}

function pinAxisLocation(
  exports: HarfbuzzExports,
  input: number,
  face: number,
  axisName: string,
  value: number
): void {
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

function setAxisRange(
  exports: HarfbuzzExports,
  input: number,
  face: number,
  axisName: string,
  value: { min: number; max: number; default?: number }
): void {
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
// HB_SUBSET_FLAGS_NO_HINTING already drops cvt/fpgm/prep/hdmx in the
// harfbuzzjs build we use; gasp/LTSH/VDMX/DSIG/PCLT survive the flag and
// must be dropped here.
const DROP_TABLE_TAGS = ['DSIG', 'LTSH', 'VDMX', 'hdmx', 'gasp', 'PCLT'];

// Color and bitmap tables — only relevant for color emoji (Apple/Google)
// and legacy bitmap fonts. Dropped only when the caller signals that no
// color content needs to render with this font.
// Note: 'SVG ' has a trailing space (4-byte tag).
const COLOR_TABLE_TAGS = [
  'COLR',
  'CPAL',
  'SVG ',
  'CBDT',
  'CBLC',
  'sbix',
  'EBDT',
  'EBLC',
  'EBSC',
];

// Name IDs needed for web fonts: family (1), subfamily (2), full name (4),
// PostScript name (6).  Copyright (0), unique ID (3), version (5), and
// everything above 6 are display/license metadata that browsers never read.
const KEEP_NAME_IDS = [1, 2, 4, 6];

function configureSubsetInput(
  exports: HarfbuzzExports,
  input: number,
  face: number,
  text: string,
  glyphIds: number[] | undefined,
  variationAxes: Record<string, VariationAxisValue> | undefined,
  featureTags: string[] | undefined,
  dropMathTable: boolean,
  dropColorTables: boolean,
  scriptTags: string[] | undefined
): void {
  // --- Retain layout features ---
  // hb_subset_input_create_or_fail pre-populates the layout-features set with
  // a curated list of shaping-essential tags (locl, ccmp, calt, mark, mkmk,
  // Indic/Arabic/Khmer shaping features, etc.).  When the caller passes
  // featureTags, we leave that default in place and add the CSS-requested
  // tags on top.  Optional features the page never references (e.g. ss##,
  // cv##, smcp, swsh) are then dropped, shrinking the GSUB/GPOS tables.
  // When featureTags is undefined, fall back to retain-all behavior.
  const layoutFeatures = exports.hb_subset_input_set(
    input,
    HB_SUBSET_SETS_LAYOUT_FEATURE_TAG
  );
  if (featureTags === undefined) {
    exports.hb_set_clear(layoutFeatures);
    exports.hb_set_invert(layoutFeatures);
  } else {
    for (const tag of featureTags) {
      exports.hb_set_add(layoutFeatures, HB_TAG(tag));
    }
  }

  // --- Retain layout scripts ---
  // When scriptTags is provided, replace harfbuzz's default (all scripts)
  // with exactly the listed tags. Undefined leaves the default in place.
  if (scriptTags !== undefined) {
    const layoutScripts = exports.hb_subset_input_set(
      input,
      HB_SUBSET_SETS_LAYOUT_SCRIPT_TAG
    );
    exports.hb_set_clear(layoutScripts);
    for (const tag of scriptTags) {
      exports.hb_set_add(layoutScripts, HB_TAG(tag));
    }
  }

  // --- Strip hinting instructions (ignored by modern browsers) ---
  const flags = exports.hb_subset_input_get_flags(input);
  exports.hb_subset_input_set_flags(input, flags | HB_SUBSET_FLAGS_NO_HINTING);

  // --- Keep only essential name table entries ---
  const nameIdSet = exports.hb_subset_input_set(input, HB_SUBSET_SETS_NAME_ID);
  exports.hb_set_clear(nameIdSet);
  for (const id of KEEP_NAME_IDS) {
    exports.hb_set_add(nameIdSet, id);
  }

  // --- Keep only en-US localized name strings ---
  const nameLangSet = exports.hb_subset_input_set(
    input,
    HB_SUBSET_SETS_NAME_LANG_ID
  );
  exports.hb_set_clear(nameLangSet);
  exports.hb_set_add(nameLangSet, KEEP_NAME_LANG_ID_EN_US);

  // --- Drop tables not needed for web rendering ---
  const dropTableSet = exports.hb_subset_input_set(
    input,
    HB_SUBSET_SETS_DROP_TABLE_TAG
  );
  for (const tag of DROP_TABLE_TAGS) {
    exports.hb_set_add(dropTableSet, HB_TAG(tag));
  }
  if (dropMathTable) {
    exports.hb_set_add(dropTableSet, HB_TAG('MATH'));
  }
  if (dropColorTables) {
    for (const tag of COLOR_TABLE_TAGS) {
      exports.hb_set_add(dropTableSet, HB_TAG(tag));
    }
  }

  // --- Add unicode codepoints ---
  const inputUnicodes = exports.hb_subset_input_unicode_set(input);
  // Include codepoints from both NFC and NFD normalized forms so the
  // subsetter covers precomposed and decomposed character variants.
  // This guards against harfbuzz subsetter not always expanding
  // codepoints to their NFC/NFD equivalents (harfbuzz issue #2283).
  const nfc = text.normalize('NFC');
  const nfd = text.normalize('NFD');
  for (const c of nfc) {
    exports.hb_set_add(inputUnicodes, c.codePointAt(0) as number);
  }
  for (const c of nfd) {
    exports.hb_set_add(inputUnicodes, c.codePointAt(0) as number);
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

function extractSubsetFont(exports: HarfbuzzExports, subset: number): Buffer {
  const result = exports.hb_face_reference_blob(subset);
  const offset = exports.hb_blob_get_data(result, 0);
  const subsetByteLength = exports.hb_blob_get_length(result);

  if (subsetByteLength === 0) {
    exports.hb_blob_destroy(result);
    throw new Error('Failed to create subset font');
  }

  // Fresh view AFTER the WASM calls above — memory.buffer may have been
  // detached by a grow during hb_face_reference_blob / hb_blob_get_data.
  const heapu8 = getHeapu8(exports);

  if (offset < 0 || offset + subsetByteLength > heapu8.byteLength) {
    exports.hb_blob_destroy(result);
    throw new Error(
      `WASM returned out-of-bounds offset ${offset} + length ${subsetByteLength} (heap size ${heapu8.byteLength})`
    );
  }

  const subsetFont = Buffer.from(
    heapu8.subarray(offset, offset + subsetByteLength)
  );
  exports.hb_blob_destroy(result);
  return subsetFont;
}

interface SubsetFontWithGlyphsFn {
  (
    originalFont: Buffer | Uint8Array,
    text: string,
    options?: SubsetFontWithGlyphsOptions
  ): Promise<Buffer>;
  warmup(): Promise<void>;
}

async function subsetFontWithGlyphs(
  originalFont: Buffer | Uint8Array,
  text: string,
  {
    targetFormat,
    glyphIds,
    variationAxes,
    featureTags,
    dropMathTable = false,
    dropColorTables = false,
    scriptTags,
  }: SubsetFontWithGlyphsOptions = {}
): Promise<Buffer> {
  // Reuse cached sfnt conversion when available (same buffer may have
  // been converted by getFontInfo or collectFeatureGlyphIds already).
  // sfntCache routes woff2 decompression through the worker pool.
  const ttf = await toSfnt(originalFont);

  const inst = await acquireInstance();
  const { exports } = inst;
  let released = false;
  try {
    const fontBuffer = exports.malloc(ttf.byteLength);
    // Fresh view — memory.buffer may have been detached by a prior malloc/grow.
    getHeapu8(exports).set(new Uint8Array(ttf), fontBuffer);

    const blob = exports.hb_blob_create(fontBuffer, ttf.byteLength, 2, 0, 0);
    const face = exports.hb_face_create(blob, 0);
    exports.hb_blob_destroy(blob);

    const input = exports.hb_subset_input_create_or_fail();
    if (input === 0) {
      exports.hb_face_destroy(face);
      exports.free(fontBuffer);
      throw new Error('hb_subset_input_create_or_fail returned zero');
    }

    let subsetFont: Buffer | undefined;
    let subset = 0;
    try {
      configureSubsetInput(
        exports,
        input,
        face,
        text,
        glyphIds,
        variationAxes,
        featureTags,
        dropMathTable,
        dropColorTables,
        scriptTags
      );

      subset = exports.hb_subset_or_fail(face, input);
      if (subset === 0) {
        throw new Error('hb_subset_or_fail returned zero');
      }

      subsetFont = extractSubsetFont(exports, subset);
    } finally {
      // Clean up all WASM resources while we still own the instance.
      if (subset) exports.hb_face_destroy(subset);
      exports.hb_subset_input_destroy(input);
      exports.hb_face_destroy(face);
      exports.free(fontBuffer);
    }

    // Instance is fully cleaned up — release it so other subsetting
    // calls can proceed while we wait for the serialized WOFF2 step.
    released = true;
    releaseInstance(inst);

    // Route woff2 compression to a worker thread (each spawns its own
    // wawoff2 WASM instance).  Non-woff2 formats use JS-based converters
    // that are safe to call concurrently in the main thread.
    return targetFormat === 'woff2'
      ? convertInWorker(subsetFont as Buffer, targetFormat, 'truetype')
      : fontverter.convert(
          subsetFont as Buffer,
          targetFormat as string,
          'truetype'
        );
  } finally {
    if (!released) releaseInstance(inst);
  }
}

// Pre-warm the WASM pool: call early to overlap compilation with other work.
(subsetFontWithGlyphs as SubsetFontWithGlyphsFn).warmup = () => initPool();

export = subsetFontWithGlyphs as SubsetFontWithGlyphsFn;
