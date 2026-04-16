#!/usr/bin/env node
'use strict';

/**
 * Compare woff2 subset sizes: naive (pre-PR#80) vs optimized (current).
 *
 * The "naive" path subsets the same glyphs but skips the four web-specific
 * optimizations added in PR #80:
 *   1. Hinting removal
 *   2. Name table pruning (keep only IDs 1, 2, 4, 6)
 *   3. Table stripping (DSIG, LTSH, VDMX, hdmx, gasp, PCLT)
 *   4. NFC/NFD codepoint normalization
 *
 * Usage:  node scripts/compare-woff2-sizes.js
 */

const { readFile } = require('fs').promises;
const fs = require('fs');
const path = require('path');
const fontverter = require('fontverter');
const { toSfnt } = require('../lib/sfntCache');

// ── harfbuzz WASM bootstrap ───────────────────────────────────────────
let _wasmExports;
async function loadHarfbuzz() {
  if (_wasmExports) return _wasmExports;
  const {
    instance: { exports },
  } = await WebAssembly.instantiate(
    await readFile(require.resolve('harfbuzzjs/hb-subset.wasm'))
  );
  _wasmExports = exports;
  return exports;
}

function getHeapu8() {
  return new Uint8Array(_wasmExports.memory.buffer);
}

function HB_TAG(str) {
  return str.split('').reduce((a, ch) => (a << 8) + ch.charCodeAt(0), 0);
}

// ── hb_subset_sets_t / flags ──────────────────────────────────────────
const HB_SUBSET_SETS_NAME_ID = 4;
const HB_SUBSET_SETS_DROP_TABLE_TAG = 5;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;
const HB_SUBSET_FLAGS_NO_HINTING = 0x00000001;

const DROP_TABLE_TAGS = ['DSIG', 'LTSH', 'VDMX', 'hdmx', 'gasp', 'PCLT'];
const KEEP_NAME_IDS = [1, 2, 4, 6];

// ── core subsetter (runs once per config) ─────────────────────────────
async function subsetFont(fontBuffer, text, { optimized }) {
  const hb = await loadHarfbuzz();
  const ttf = await toSfnt(fontBuffer);

  const ptr = hb.malloc(ttf.byteLength);
  getHeapu8().set(new Uint8Array(ttf), ptr);

  const blob = hb.hb_blob_create(ptr, ttf.byteLength, 2, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);

  const input = hb.hb_subset_input_create_or_fail();
  if (input === 0) {
    hb.hb_face_destroy(face);
    hb.free(ptr);
    throw new Error('hb_subset_input_create_or_fail returned zero');
  }

  let subset = 0;
  try {
    // Retain all layout features (both paths do this)
    const layoutFeatures = hb.hb_subset_input_set(
      input,
      HB_SUBSET_SETS_LAYOUT_FEATURE_TAG
    );
    hb.hb_set_clear(layoutFeatures);
    hb.hb_set_invert(layoutFeatures);

    if (optimized) {
      // 1. Strip hinting
      const flags = hb.hb_subset_input_get_flags(input);
      hb.hb_subset_input_set_flags(input, flags | HB_SUBSET_FLAGS_NO_HINTING);

      // 2. Prune name table
      const nameIdSet = hb.hb_subset_input_set(input, HB_SUBSET_SETS_NAME_ID);
      hb.hb_set_clear(nameIdSet);
      for (const id of KEEP_NAME_IDS) {
        hb.hb_set_add(nameIdSet, id);
      }

      // 3. Drop unnecessary tables
      const dropTableSet = hb.hb_subset_input_set(
        input,
        HB_SUBSET_SETS_DROP_TABLE_TAG
      );
      for (const tag of DROP_TABLE_TAGS) {
        hb.hb_set_add(dropTableSet, HB_TAG(tag));
      }
    }

    // Add unicode codepoints
    const inputUnicodes = hb.hb_subset_input_unicode_set(input);
    if (optimized) {
      // NFC + NFD expansion (PR #80 / #81)
      const nfc = text.normalize('NFC');
      const nfd = text.normalize('NFD');
      for (const c of nfc) hb.hb_set_add(inputUnicodes, c.codePointAt(0));
      for (const c of nfd) hb.hb_set_add(inputUnicodes, c.codePointAt(0));
    } else {
      for (const c of text) hb.hb_set_add(inputUnicodes, c.codePointAt(0));
    }

    subset = hb.hb_subset_or_fail(face, input);
    if (subset === 0) throw new Error('hb_subset_or_fail returned zero');

    const resultBlob = hb.hb_face_reference_blob(subset);
    const offset = hb.hb_blob_get_data(resultBlob, 0);
    const len = hb.hb_blob_get_length(resultBlob);
    const sfntSubset = Buffer.from(getHeapu8().subarray(offset, offset + len));
    hb.hb_blob_destroy(resultBlob);

    return fontverter.convert(sfntSubset, 'woff2', 'truetype');
  } finally {
    if (subset) hb.hb_face_destroy(subset);
    hb.hb_subset_input_destroy(input);
    hb.hb_face_destroy(face);
    hb.free(ptr);
  }
}

// ── pretty output helpers ─────────────────────────────────────────────
function fmtBytes(n) {
  return `${n.toLocaleString()} B`;
}

function pctSavings(before, after) {
  return `${Math.round(((before - after) / before) * 100)}%`;
}

// ── main ──────────────────────────────────────────────────────────────
const TEXT_SAMPLES = {
  'Heading (short)': 'Design',
  Paragraph:
    'The five boxing wizards jump quickly. Sphinx of black quartz, judge my vow.',
  'Full page charset':
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,;:!?\'"-()[]{}/@#$%^&*+=<>~`_|\\',
};

(async () => {
  const fontPath = path.resolve(
    __dirname,
    '../testdata/subsetFonts/OpenSans-400.ttf'
  );
  const fontBuf = fs.readFileSync(fontPath);

  console.log(`Font: OpenSans-400.ttf (${fmtBytes(fontBuf.length)})\n`);

  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
  const rpad = (s, w) => ' '.repeat(Math.max(0, w - s.length)) + s;

  console.log(
    `${pad('Text sample', 20)}  ${rpad('Naive subset', 12)}  ${rpad('subfont', 12)}  ${rpad('Savings', 8)}`
  );
  console.log('-'.repeat(60));

  for (const [label, text] of Object.entries(TEXT_SAMPLES)) {
    const naive = await subsetFont(fontBuf, text, { optimized: false });
    const optimized = await subsetFont(fontBuf, text, { optimized: true });

    console.log(
      `${pad(label, 20)}  ${rpad(fmtBytes(naive.length), 12)}  ${rpad(fmtBytes(optimized.length), 12)}  ${rpad(pctSavings(naive.length, optimized.length), 8)}`
    );
  }
})();
