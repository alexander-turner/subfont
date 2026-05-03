#!/usr/bin/env node
// Reproducible benchmarks for the README's "Naive subset vs subfont" table.
// Run after any change to subsetting options:
//   pnpm run build && node scripts/bench-readme.js
// "Naive" = harfbuzz with default options (no flags, retain everything).
// "subfont" = subsetFontWithGlyphs with every optimization enabled.

const fs = require('fs');
const path = require('path');

const subsetFontWithGlyphs = require('../lib/subsetFontWithGlyphs');
const {
  pageNeedsMathTable,
  pageNeedsColorTables,
  scriptsForText,
} = require('../lib/codepointMaps');

const FONT = path.resolve(
  __dirname,
  '..',
  'testdata/subsetFonts/OpenSans-400.ttf'
);

const SAMPLES = [
  ['Heading (short)', 'Design choices for turntrout.com'],
  [
    'Paragraph',
    'The quick brown fox jumps over the lazy dog. ' +
      'Subfont strips data your browser never reads, then woff2-compresses the rest.',
  ],
  [
    'Full page charset',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
      'abcdefghijklmnopqrstuvwxyz' +
      '0123456789' +
      '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ ' +
      'áéíóúñçÁÉÍÓÚÑÇèëïöüÈËÏÖÜ',
  ],
];

async function naiveSubset(ttf, text) {
  const wasm = fs.readFileSync(require.resolve('harfbuzzjs/hb-subset.wasm'));
  const mod = await WebAssembly.compile(wasm);
  const inst = await WebAssembly.instantiate(mod);
  const e = inst.exports;
  const heap = () => new Uint8Array(e.memory.buffer);
  const fontPtr = e.malloc(ttf.byteLength);
  heap().set(new Uint8Array(ttf), fontPtr);
  const blob = e.hb_blob_create(fontPtr, ttf.byteLength, 2, 0, 0);
  const face = e.hb_face_create(blob, 0);
  e.hb_blob_destroy(blob);
  const input = e.hb_subset_input_create_or_fail();
  const uset = e.hb_subset_input_unicode_set(input);
  for (const ch of text) e.hb_set_add(uset, ch.codePointAt(0));
  const subset = e.hb_subset_or_fail(face, input);
  const out = e.hb_face_reference_blob(subset);
  const off = e.hb_blob_get_data(out, 0);
  const len = e.hb_blob_get_length(out);
  const sfnt = Buffer.from(heap().slice(off, off + len));
  e.hb_blob_destroy(out);
  e.hb_face_destroy(subset);
  e.hb_subset_input_destroy(input);
  e.hb_face_destroy(face);
  e.free(fontPtr);
  // Compress to woff2 for an apples-to-apples size comparison.
  const fontverter = require('fontverter');
  return Buffer.from(await fontverter.convert(sfnt, 'woff2', 'truetype'));
}

(async () => {
  const buf = fs.readFileSync(FONT);

  console.log('| Text sample       | Naive subset | `subfont` | Savings |');
  console.log('| ----------------- | ------------ | --------- | ------- |');
  for (const [label, text] of SAMPLES) {
    const naive = await naiveSubset(buf, text);
    const optimized = await subsetFontWithGlyphs(buf, text, {
      targetFormat: 'woff2',
      featureTags: [],
      dropMathTable: !pageNeedsMathTable(text),
      dropColorTables: !pageNeedsColorTables(text),
      scriptTags: scriptsForText(text),
    });
    const pct = Math.round(
      ((naive.length - optimized.length) / naive.length) * 100
    );
    const pad = (n) => n.toLocaleString('en-US');
    console.log(
      `| ${label.padEnd(17)} | ${`${pad(naive.length)} B`.padEnd(12)} | ${`${pad(optimized.length)} B`.padEnd(9)} | **${pct}%** |`
    );
  }
})();
