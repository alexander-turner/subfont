// Benchmark scaffolding for subsetFontWithGlyphs byte-size assertions.
// Each `it()` is a micro-benchmark with a hard upper bound on output bytes;
// regressions show up immediately. Bound values are derived from runs on the
// committed harfbuzzjs WASM with the current options surface — bump only after
// confirming the regression isn't a real loss.
const expect = require('unexpected');
const fs = require('fs');
const pathModule = require('path');
const subsetFontWithGlyphs = require('../lib/subsetFontWithGlyphs');

const PANGRAM = 'The quick brown fox jumps over the lazy dog 0123456789';

function listSfntTables(buf) {
  const numTables = buf.readUInt16BE(4);
  const set = new Set();
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    set.add(buf.slice(off, off + 4).toString('ascii'));
  }
  return set;
}

const fonts = {
  Roboto: pathModule.resolve(
    __dirname,
    '../testdata/subsetFonts/Roboto-400.ttf'
  ),
  Montserrat: pathModule.resolve(
    __dirname,
    '../testdata/subsetFonts/Montserrat-400.ttf'
  ),
  SpaceMono: pathModule.resolve(
    __dirname,
    '../testdata/subsetFonts/SpaceMono-400.ttf'
  ),
  IBMPlexSans: pathModule.resolve(
    __dirname,
    '../testdata/referenceImages/fontVariant/IBMPlexSans-Regular.woff'
  ),
};

describe('subset size benchmarks', function () {
  this.timeout(60000);

  describe('NO_HINTING + DROP_TABLE_TAGS', function () {
    it(`Roboto-400 truetype subset of "${PANGRAM}" should be smaller after enum fix`, async function () {
      const buf = fs.readFileSync(fonts.Roboto);
      const result = await subsetFontWithGlyphs(buf, PANGRAM, {
        targetFormat: 'truetype',
        featureTags: [],
      });
      // Pre-fix produced 1148 bytes (gasp survived); fix drops it to ≤ 1130.
      expect(result.length, 'to be less than or equal to', 1130);
      const tables = listSfntTables(result);
      expect(tables.has('gasp'), 'to be false');
    });
  });
});
