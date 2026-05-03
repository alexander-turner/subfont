// Byte-size regression checks for subsetFontWithGlyphs. Each `it()` asserts
// a hard upper bound on output bytes; bump only after confirming the
// regression isn't a real loss.
const expect = require('unexpected');
const fs = require('fs');
const pathModule = require('path');
const subsetFontWithGlyphs = require('../lib/subsetFontWithGlyphs');

const PANGRAM = 'The quick brown fox jumps over the lazy dog 0123456789';

function tableSet(buf) {
  const numTables = buf.readUInt16BE(4);
  const set = new Set();
  for (let i = 0; i < numTables; i++) {
    set.add(buf.slice(12 + i * 16, 16 + i * 16).toString('ascii'));
  }
  return set;
}

const ROBOTO = pathModule.resolve(
  __dirname,
  '../testdata/subsetFonts/Roboto-400.ttf'
);
const IBM_PLEX_SANS = pathModule.resolve(
  __dirname,
  '../testdata/referenceImages/fontVariant/IBMPlexSans-Regular.woff'
);

describe('subset size benchmarks', function () {
  this.timeout(60000);

  it('Roboto-400 truetype subset drops gasp after the enum fix', async function () {
    const buf = fs.readFileSync(ROBOTO);
    const result = await subsetFontWithGlyphs(buf, PANGRAM, {
      targetFormat: 'truetype',
      featureTags: [],
    });
    // Pre-fix produced 1148 bytes (gasp survived); fix drops it to ≤ 1130.
    expect(result.length, 'to be less than or equal to', 1130);
    expect(tableSet(result).has('gasp'), 'to be false');
  });

  [
    { name: 'Roboto-400', path: ROBOTO },
    { name: 'IBMPlexSans-Regular', path: IBM_PLEX_SANS },
  ].forEach(({ name, path }) => {
    it(`${name} woff2 with scriptTags=[DFLT, latn] is smaller than retain-all`, async function () {
      const buf = fs.readFileSync(path);
      const baseOpts = { targetFormat: 'woff2', featureTags: [] };
      const all = await subsetFontWithGlyphs(buf, PANGRAM, baseOpts);
      const latnOnly = await subsetFontWithGlyphs(buf, PANGRAM, {
        ...baseOpts,
        scriptTags: ['DFLT', 'latn'],
      });
      expect(latnOnly.length, 'to be less than', all.length);
    });
  });
});
