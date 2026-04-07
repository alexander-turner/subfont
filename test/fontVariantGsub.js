const assert = require('assert');
const pathModule = require('path');
const parse5 = require('parse5');
const { subsetFontsWithTestDefaults } = require('./subsetFonts-helpers');
const AssetGraph = require('assetgraph');
const extractVisibleText = require('../lib/extractVisibleText');
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
  let htmlSource; // raw HTML text from the test fixture

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

    const htmlAsset = assetGraph.findAssets({ type: 'Html' })[0];
    htmlSource = htmlAsset.text;

    const origAsset = assetGraph.findAssets({ type: 'Woff' })[0];
    assert(origAsset, 'Expected the test case to contain a .woff font');
    orig = await loadFont(origAsset.rawSrc);

    await subsetFontsWithTestDefaults(assetGraph, { inlineCss: false });

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

  it('should produce identical shaping metrics for every character and feature', function () {
    const chars = [...new Set(extractVisibleText(htmlSource))].filter(
      (c) => c.trim() !== ''
    );

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
    assert.deepStrictEqual(
      failures,
      [],
      `Shaping mismatches:\n${failures.join('\n')}`
    );
  });

  it('should actively substitute glyphs for each feature used in the test case', function () {
    // Walk the parse5 tree to find <code class="ibm-plex-sans-FEAT">
    // elements and extract feature→character mappings.
    const document = parse5.parse(htmlSource);

    function collectText(node) {
      if (node.nodeName === '#text') return node.value || '';
      let text = '';
      if (node.childNodes) {
        for (const child of node.childNodes) text += collectText(child);
      }
      return text;
    }

    function walk(node, blocks) {
      if (node.nodeName === 'code' && node.attrs) {
        const cls = (node.attrs.find((a) => a.name === 'class') || {}).value;
        if (cls && cls.startsWith('ibm-plex-sans-')) {
          blocks.push({
            feat: cls.slice('ibm-plex-sans-'.length),
            text: collectText(node),
          });
        }
      }
      if (node.childNodes) {
        for (const child of node.childNodes) walk(child, blocks);
      }
    }

    const blocks = [];
    walk(document, blocks);

    assert(blocks.length > 0, 'Expected to find feature code blocks in HTML');

    for (const { feat, text } of blocks) {
      const ch = [...text].find((c) => c.trim() !== '');
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
