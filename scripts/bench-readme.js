#!/usr/bin/env node
// Reproducible benchmarks for the README's "Naive subset vs subfont" table.
// Run after any change to subsetting options:
//   pnpm run build && node scripts/bench-readme.js
// "Upstream" = the `subset-font` package upstream subfont uses (only
//   layout-features=* and an optional name-ID list). "subfont" =
//   subsetFontWithGlyphs with every optimization enabled.

const fs = require('fs');
const path = require('path');
const fontverter = require('fontverter');
const upstreamSubsetFont = require('subset-font');

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
  ['Heading (short)', 'Hello World'],
  ['Paragraph', 'The quick brown fox jumps over the lazy dog.'],
  [
    'Full page charset',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
      'abcdefghijklmnopqrstuvwxyz' +
      '0123456789' +
      '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ ' +
      'áéíóúñçÁÉÍÓÚÑÇèëïöüÈËÏÖÜ',
  ],
];

(async () => {
  const buf = fs.readFileSync(FONT);

  console.log(
    '| Text sample       | Upstream subfont | `@turntrout/subfont` | Savings |'
  );
  console.log(
    '| ----------------- | ---------------- | -------------------- | ------- |'
  );
  for (const [label, text] of SAMPLES) {
    // Upstream's subset-font emits a sfnt; convert to woff2 the same way
    // subfont's pipeline does, so the two columns compare like-for-like.
    const upstreamSfnt = await upstreamSubsetFont(buf, text, {
      targetFormat: 'truetype',
    });
    const upstream = Buffer.from(
      await fontverter.convert(upstreamSfnt, 'woff2', 'truetype')
    );
    const optimized = await subsetFontWithGlyphs(buf, text, {
      targetFormat: 'woff2',
      featureTags: [],
      dropMathTable: !pageNeedsMathTable(text),
      dropColorTables: !pageNeedsColorTables(text),
      scriptTags: scriptsForText(text),
    });
    const pct = Math.round(
      ((upstream.length - optimized.length) / upstream.length) * 100
    );
    const pad = (n) => n.toLocaleString('en-US');
    console.log(
      `| ${label.padEnd(17)} | ${`${pad(upstream.length)} B`.padEnd(16)} | ${`${pad(optimized.length)} B`.padEnd(20)} | **${pct}%** |`
    );
  }
})();
