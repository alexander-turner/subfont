const assert = require('assert');
const fs = require('fs');
const pathModule = require('path');
const subsetFonts = require('../lib/subsetFonts');
const AssetGraph = require('assetgraph');
const fontverter = require('fontverter');

const TEST_DIR = pathModule.resolve(
  __dirname,
  '..',
  'testdata',
  'referenceImages',
  'fontVariant'
);

// Default-only features that the subsetter may prune when no lookups
// survive (their glyphs aren't in the subset's codepoint set).
const DEFAULT_ONLY_FEATURES = new Set(['ccmp', 'liga']);

describe('font-variant GSUB preservation', function () {
  let harfbuzzJs;
  let orig; // { blob, face, font }
  let sub; // { blob, face, font }
  let origFeatures; // string[] — deduplicated GSUB tags from the original

  async function loadFont(buf) {
    const sfnt = await fontverter.convert(buf, 'sfnt');
    const blob = harfbuzzJs.createBlob(sfnt);
    const face = harfbuzzJs.createFace(blob, 0);
    const font = harfbuzzJs.createFont(face);
    return { blob, face, font };
  }

  function destroyFont(f) {
    if (!f) return;
    f.font.destroy();
    f.face.destroy();
    f.blob.destroy();
  }

  function shape(font, ch, feat) {
    const buf = harfbuzzJs.createBuffer();
    buf.addText(ch);
    buf.guessSegmentProperties();
    harfbuzzJs.shapeWithTrace(font, buf, feat, 10000, 0);
    const result = buf.json(font);
    buf.destroy();
    return result;
  }

  before(async function () {
    this.timeout(30000);
    harfbuzzJs = await require('harfbuzzjs');

    const assetGraph = new AssetGraph({ root: TEST_DIR });
    await assetGraph.loadAssets('index.html');
    await assetGraph.populate();

    const origAsset = assetGraph.findAssets({ type: 'Woff' })[0];
    assert(origAsset, 'Expected the test case to contain a .woff font');
    orig = await loadFont(origAsset.rawSrc);

    await subsetFonts(assetGraph, { inlineCss: false });

    const subsetAsset = assetGraph
      .findAssets({ type: { $in: ['Woff', 'Woff2'] }, isLoaded: true })
      .find((a) => a.url !== origAsset.url && a.type === 'Woff');
    assert(subsetAsset, 'Expected a subset .woff font to be created');
    sub = await loadFont(subsetAsset.rawSrc);

    origFeatures = [...new Set(orig.face.getTableFeatureTags('GSUB'))];
  });

  after(function () {
    destroyFont(orig);
    destroyFont(sub);
  });

  it('should retain all non-default GSUB feature tags', function () {
    const subFeatures = new Set(sub.face.getTableFeatureTags('GSUB'));
    const missing = origFeatures.filter(
      (f) => !DEFAULT_ONLY_FEATURES.has(f) && !subFeatures.has(f)
    );
    assert.deepStrictEqual(
      missing,
      [],
      `Subset font is missing GSUB features: ${missing.join(', ')}`
    );
  });

  // Derive the test characters from the actual HTML rather than hardcoding.
  // This way the test stays in sync if the test fixture changes.
  it('should produce identical shaping metrics for every character and feature', function () {
    const html = fs.readFileSync(
      pathModule.join(TEST_DIR, 'index.html'),
      'utf8'
    );
    // Extract only the visible text from <code> elements (not CSS/markup)
    const codeBlockRe = /<code[^>]*>([\s\S]*?)<\/code>/g;
    let textContent = '';
    let m;
    while ((m = codeBlockRe.exec(html)) !== null) {
      textContent += m[1];
    }
    const chars = [...new Set(textContent)].filter((c) => c.trim() !== '');

    // Test with no explicit features, plus every non-default GSUB feature
    const featureStrings = [
      '',
      ...origFeatures
        .filter((f) => !DEFAULT_ONLY_FEATURES.has(f))
        .map((f) => `+${f}`),
    ];

    const failures = [];
    for (const ch of chars) {
      for (const feat of featureStrings) {
        const origResult = shape(orig.font, ch, feat);
        const subResult = shape(sub.font, ch, feat);

        const origAdvances = origResult.map((g) => g.ax);
        const subAdvances = subResult.map((g) => g.ax);

        if (
          origResult.length !== subResult.length ||
          JSON.stringify(origAdvances) !== JSON.stringify(subAdvances)
        ) {
          failures.push(
            `'${ch}' ${feat || '(default)'}: ` +
              `glyphs ${origResult.length}→${subResult.length}, ` +
              `advances [${origAdvances}]→[${subAdvances}]`
          );
        }
      }
    }
    assert.deepStrictEqual(failures, [], `Shaping mismatches:\n${failures.join('\n')}`);
  });

  it('should actively substitute glyphs for each feature used in the test case', function () {
    // Parse the HTML to discover which feature is tested with which characters,
    // by reading <code class="ibm-plex-sans-FEAT">...text...</code> blocks.
    const html = fs.readFileSync(
      pathModule.join(TEST_DIR, 'index.html'),
      'utf8'
    );
    const blockRe =
      /<code\s+class="ibm-plex-sans-(\w+)">\s*([\s\S]*?)\s*<\/code>/g;
    let match;
    while ((match = blockRe.exec(html)) !== null) {
      const feat = match[1];
      const blockText = match[2].replace(/\s+/g, ' ').trim();
      // Pick the first non-space character as the representative test char
      const ch = [...blockText].find((c) => c.trim() !== '');
      if (!ch) continue;

      const baseGids = shape(sub.font, ch, '').map((g) => g.g);
      const featGids = shape(sub.font, ch, `+${feat}`).map((g) => g.g);

      assert.notDeepStrictEqual(
        featGids,
        baseGids,
        `+${feat} should change glyphs for '${ch}' in the subset font`
      );
    }
  });
});
