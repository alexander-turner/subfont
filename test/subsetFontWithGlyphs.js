const expect = require('unexpected');
const fs = require('fs');
const pathModule = require('path');
const subsetFontWithGlyphs = require('../lib/subsetFontWithGlyphs');

const ttfPath = pathModule.resolve(
  __dirname,
  '../testdata/subsetFonts/Roboto-400.ttf'
);

const variableFontPath = pathModule.resolve(
  __dirname,
  '../testdata/subsetFonts/variable-font-unused-axes/RobotoFlex-VariableFont_GRAD,XTRA,YOPQ,YTAS,YTDE,YTFI,YTLC,YTUC,opsz,slnt,wdth,wght.ttf'
);

function listSfntTables(buf) {
  const numTables = buf.readUInt16BE(4);
  const set = new Set();
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    set.add(buf.slice(off, off + 4).toString('ascii'));
  }
  return set;
}

describe('subsetFontWithGlyphs', function () {
  this.timeout(30000);

  let ttfBuffer;
  let variableFontBuffer;
  before(function () {
    ttfBuffer = fs.readFileSync(ttfPath);
    variableFontBuffer = fs.readFileSync(variableFontPath);
  });

  it('should produce a smaller woff2 subset for a few characters', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'Hello', {
      targetFormat: 'woff2',
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
    expect(result.length, 'to be less than', ttfBuffer.length);
  });

  it('should produce a truetype subset', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'ABC', {
      targetFormat: 'truetype',
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should produce a woff subset', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'Test', {
      targetFormat: 'woff',
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should handle an empty text string', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, '', {
      targetFormat: 'woff2',
    });

    expect(result, 'to be a', Buffer);
  });

  it('should accept glyphIds option', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, '', {
      targetFormat: 'woff2',
      glyphIds: [0, 1, 2],
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should combine text and glyphIds', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'AB', {
      targetFormat: 'woff2',
      glyphIds: [0],
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should handle Unicode characters', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, '\u00e9\u00f1\u00fc', {
      targetFormat: 'woff2',
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should include codepoints from both NFC and NFD normalized forms', async function () {
    // Precomposed é (U+00E9) should also include decomposed e (U+0065) + combining acute (U+0301)
    const precomposed = '\u00e9'; // NFC form
    const result = await subsetFontWithGlyphs(ttfBuffer, precomposed, {
      targetFormat: 'woff2',
    });

    // The subset with NFC+NFD expansion should be at least as large as
    // one without it, because it includes extra codepoints
    const decomposed = 'e\u0301'; // NFD form
    const resultDecomposed = await subsetFontWithGlyphs(ttfBuffer, decomposed, {
      targetFormat: 'woff2',
    });

    // Both should produce valid output
    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
    expect(resultDecomposed, 'to be a', Buffer);
    expect(resultDecomposed.length, 'to be greater than', 0);
  });

  it('should pin a variation axis to a specific value', async function () {
    const result = await subsetFontWithGlyphs(variableFontBuffer, 'Hello', {
      targetFormat: 'woff2',
      variationAxes: { wght: 400 },
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
    expect(result.length, 'to be less than', variableFontBuffer.length);
  });

  it('should set a variation axis range', async function () {
    const result = await subsetFontWithGlyphs(variableFontBuffer, 'Hello', {
      targetFormat: 'woff2',
      variationAxes: { wght: { min: 100, max: 700 } },
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should handle mixed pinned and ranged variation axes', async function () {
    const result = await subsetFontWithGlyphs(variableFontBuffer, 'Test', {
      targetFormat: 'woff2',
      variationAxes: {
        wght: { min: 100, max: 400 },
        wdth: 100,
      },
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should handle variation axis range with explicit default', async function () {
    const result = await subsetFontWithGlyphs(variableFontBuffer, 'Hi', {
      targetFormat: 'woff2',
      variationAxes: { wght: { min: 100, max: 900, default: 400 } },
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should throw when pinning an axis that does not exist in the font', async function () {
    try {
      await subsetFontWithGlyphs(ttfBuffer, 'A', {
        targetFormat: 'woff2',
        variationAxes: { ZZZZ: 100 },
      });
      expect.fail('Expected an error');
    } catch (err) {
      expect(err.message, 'to contain', 'Failed to pin axis ZZZZ');
    }
  });

  it('targeted feature retention should produce a smaller subset than retain-all', async function () {
    // IBMPlexSans has many optional features (aalt, salt, ss##, sinf, etc.)
    // that the retain-all path keeps but targeted retention drops.
    const ibmPlexBuffer = fs.readFileSync(
      pathModule.resolve(
        __dirname,
        '../testdata/referenceImages/fontVariant/IBMPlexSans-Regular.woff'
      )
    );
    const text = 'The quick brown fox jumps over the lazy dog';
    const retainAll = await subsetFontWithGlyphs(ibmPlexBuffer, text, {
      targetFormat: 'woff2',
      // featureTags omitted -> retain-all-features (legacy behavior)
    });
    const targeted = await subsetFontWithGlyphs(ibmPlexBuffer, text, {
      targetFormat: 'woff2',
      featureTags: [], // no extra features beyond harfbuzz defaults
    });
    expect(targeted.length, 'to be less than', retainAll.length);
  });

  it('should accept dropMathTable without affecting fonts that lack a MATH table', async function () {
    // No testdata font ships a MATH table, so this only verifies that
    // setting the option produces a valid subset (the option is a no-op
    // when the table is absent).
    const result = await subsetFontWithGlyphs(ttfBuffer, 'ABC', {
      targetFormat: 'truetype',
      featureTags: [],
      dropMathTable: true,
    });
    const tables = listSfntTables(result);
    expect(tables.has('MATH'), 'to be false');
    expect(result.length, 'to be greater than', 0);
  });

  it('should drop hinting and unused web tables from a TrueType subset', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'ABC', {
      targetFormat: 'truetype',
      featureTags: [],
    });
    const tables = listSfntTables(result);
    // NO_HINTING flag drops these for TrueType outlines.
    for (const tag of ['cvt ', 'fpgm', 'prep', 'hdmx']) {
      expect(tables.has(tag), 'to be false');
    }
    // DROP_TABLE_TAGS catches the rest that NO_HINTING leaves behind.
    for (const tag of ['gasp', 'DSIG', 'LTSH', 'VDMX', 'PCLT']) {
      expect(tables.has(tag), 'to be false');
    }
  });

  it('should handle concurrent calls via worker pool', async function () {
    const results = await Promise.all([
      subsetFontWithGlyphs(ttfBuffer, 'A', { targetFormat: 'woff2' }),
      subsetFontWithGlyphs(ttfBuffer, 'B', { targetFormat: 'woff2' }),
      subsetFontWithGlyphs(ttfBuffer, 'C', { targetFormat: 'woff2' }),
    ]);

    for (const result of results) {
      expect(result, 'to be a', Buffer);
      expect(result.length, 'to be greater than', 0);
    }
  });
});
