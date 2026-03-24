const assert = require('assert');
const pathModule = require('path');
const subsetFonts = require('../lib/subsetFonts');
const AssetGraph = require('assetgraph');
const fontverter = require('fontverter');

describe('font-variant GSUB preservation', function () {
  it('should preserve all GSUB features and shaping after subsetting', async function () {
    this.timeout(30000);
    const harfbuzzJs = await require('harfbuzzjs');
    const testDir = pathModule.resolve(
      __dirname,
      '..',
      'testdata',
      'referenceImages',
      'fontVariant'
    );

    const assetGraph = new AssetGraph({ root: testDir });
    await assetGraph.loadAssets('index.html');
    await assetGraph.populate();

    const origAsset = assetGraph.findAssets({ type: 'Woff' })[0];
    const origBuf = origAsset.rawSrc;

    await subsetFonts(assetGraph, { inlineCss: false });

    const subsetAsset = assetGraph
      .findAssets({ type: { $in: ['Woff', 'Woff2'] }, isLoaded: true })
      .find((a) => a.url !== origAsset.url && a.type === 'Woff');

    assert(subsetAsset, 'Expected a subset .woff font to be created');

    async function loadFont(buf) {
      const sfnt = await fontverter.convert(buf, 'sfnt');
      const blob = harfbuzzJs.createBlob(sfnt);
      const face = harfbuzzJs.createFace(blob, 0);
      const font = harfbuzzJs.createFont(face);
      return { blob, face, font };
    }

    const orig = await loadFont(origBuf);
    const sub = await loadFont(subsetAsset.rawSrc);

    try {
      // Every GSUB feature used by font-variant-* (except default-only
      // ccmp/liga which are retained by the subsetter's glyph closure
      // but may be pruned when no lookups remain) must be present.
      const origFeatures = [...new Set(orig.face.getTableFeatureTags('GSUB'))];
      const subFeatures = new Set(sub.face.getTableFeatureTags('GSUB'));
      const requiredFeatures = origFeatures.filter(
        (f) => f !== 'ccmp' && f !== 'liga'
      );
      for (const feat of requiredFeatures) {
        assert(
          subFeatures.has(feat),
          `Subset font is missing GSUB feature: ${feat}`
        );
      }

      // Shaping with each feature must produce the same glyph count and
      // advance widths between the original and subset font. Glyph IDs
      // differ (the subsetter renumbers them) but metrics must match.
      const text =
        ' /0123456789`ago\u00A8\u00AF\u00B2\u00B3\u00B4\u00B9\u00DF' +
        '\u00E0\u00E1\u00E2\u00E3\u00E4\u00E5\u0101\u0103\u0105' +
        '\u011D\u011F\u0121\u0123\u01FB\u02C6\u02C7\u02D8\u02D9' +
        '\u02DA\u02DC\u02DD\u0309\u0384\u03AC\u03B1\u0430\u04D1' +
        '\u04D3\u1EA1\u1EA3\u1EA5\u1EA7\u1EA9\u1EAB\u1EAD\u1EAF' +
        '\u1EB1\u1EB3\u1EB5\u1EB7\u2044\u2070\u2074\u2075\u2076' +
        '\u2077\u2078\u2079\u2080\u2081\u2082\u2083\u2084\u2085' +
        '\u2086\u2087\u2088\u2089';
      const features = [
        '',
        '+aalt',
        '+dnom',
        '+frac',
        '+numr',
        '+ordn',
        '+salt',
        '+sinf',
        '+ss01',
        '+ss02',
        '+ss03',
        '+ss04',
        '+ss05',
        '+subs',
        '+sups',
        '+zero',
      ];
      const chars = [...new Set(text)].filter((c) => c.trim() !== '');

      for (const ch of chars) {
        for (const feat of features) {
          function shape(font) {
            const buf = harfbuzzJs.createBuffer();
            buf.addText(ch);
            buf.guessSegmentProperties();
            harfbuzzJs.shapeWithTrace(font, buf, feat, 10000, 0);
            const result = buf.json(font);
            buf.destroy();
            return {
              glyphs: result.length,
              advances: result.map((g) => g.ax),
            };
          }

          const origResult = shape(orig.font);
          const subResult = shape(sub.font);

          assert.strictEqual(
            subResult.glyphs,
            origResult.glyphs,
            `Glyph count mismatch for '${ch}' with ${feat || 'no features'}: ` +
              `original=${origResult.glyphs}, subset=${subResult.glyphs}`
          );
          assert.deepStrictEqual(
            subResult.advances,
            origResult.advances,
            `Advance width mismatch for '${ch}' with ${feat || 'no features'}: ` +
              `original=[${origResult.advances}], subset=[${subResult.advances}]`
          );
        }
      }

      // Verify feature substitution is actually happening (not a no-op)
      const substitutionTests = [
        ['a', 'ss01'],
        ['g', 'ss02'],
        ['0', 'zero'],
        ['0', 'dnom'],
        ['0', 'numr'],
        ['0', 'subs'],
        ['0', 'sups'],
        ['a', 'ordn'],
        ['a', 'salt'],
        ['0', 'sinf'],
      ];
      for (const [ch, feat] of substitutionTests) {
        const baseBuf = harfbuzzJs.createBuffer();
        baseBuf.addText(ch);
        baseBuf.guessSegmentProperties();
        harfbuzzJs.shapeWithTrace(sub.font, baseBuf, '', 10000, 0);
        const base = baseBuf.json(sub.font);
        baseBuf.destroy();

        const featBuf = harfbuzzJs.createBuffer();
        featBuf.addText(ch);
        featBuf.guessSegmentProperties();
        harfbuzzJs.shapeWithTrace(sub.font, featBuf, `+${feat}`, 10000, 0);
        const result = featBuf.json(sub.font);
        featBuf.destroy();

        const baseGids = base.map((g) => g.g);
        const featGids = result.map((g) => g.g);
        assert.notDeepStrictEqual(
          featGids,
          baseGids,
          `Feature +${feat} should produce different glyphs for '${ch}' in subset`
        );
      }
    } finally {
      orig.font.destroy();
      orig.face.destroy();
      orig.blob.destroy();
      sub.font.destroy();
      sub.face.destroy();
      sub.blob.destroy();
    }
  });
});
