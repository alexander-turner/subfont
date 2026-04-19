const expect = require('unexpected')
  .clone()
  .use(require('assetgraph/test/unexpectedAssetGraph'));
const AssetGraph = require('assetgraph');
const pathModule = require('path');
const collectTextsByPage = require('../lib/collectTextsByPage');

const localSingleRoot = pathModule.resolve(
  __dirname,
  '../testdata/subsetFonts/local-single/'
);

describe('collectTextsByPage', function () {
  this.timeout(60000);

  describe('with a single local font page', function () {
    let assetGraph;
    let htmlAssets;

    beforeEach(async function () {
      assetGraph = new AssetGraph({ root: localSingleRoot });
      await assetGraph.loadAssets('index.html');
      await assetGraph.populate();
      htmlAssets = assetGraph.findAssets({ type: 'Html', isInline: false });
    });

    it('should return fontFaceDeclarationsByHtmlOrSvgAsset', async function () {
      const { fontFaceDeclarationsByHtmlOrSvgAsset } = await collectTextsByPage(
        assetGraph,
        htmlAssets
      );

      expect(fontFaceDeclarationsByHtmlOrSvgAsset, 'to be a', Map);
      const decls = fontFaceDeclarationsByHtmlOrSvgAsset.get(htmlAssets[0]);
      expect(decls, 'to have length', 1);
      expect(decls[0]['font-family'], 'to equal', 'Open Sans');
      expect(decls[0].src, 'to be a string');
    });

    it('should populate fontUsages with text and props', async function () {
      const { htmlOrSvgAssetTextsWithProps } = await collectTextsByPage(
        assetGraph,
        htmlAssets
      );

      expect(htmlOrSvgAssetTextsWithProps, 'to have length', 1);
      const fontUsage = htmlOrSvgAssetTextsWithProps[0].fontUsages[0];
      expect(fontUsage.fontUrl, 'to be a string');
      expect(fontUsage.props, 'to satisfy', { 'font-family': 'Open Sans' });
      expect(fontUsage.pageText, 'to be a string');
    });

    it('should include subTimings in the result', async function () {
      const { subTimings } = await collectTextsByPage(assetGraph, htmlAssets);

      expect(subTimings, 'to be an object');
      expect(subTimings, 'to have key', 'Full tracing');
    });

    it('should include extra text when the text option is set', async function () {
      const { htmlOrSvgAssetTextsWithProps } = await collectTextsByPage(
        assetGraph,
        htmlAssets,
        { text: 'EXTRA_CHARS_XYZ' }
      );

      const fontUsage = htmlOrSvgAssetTextsWithProps[0].fontUsages[0];
      expect(fontUsage.text, 'to contain', 'X');
      expect(fontUsage.text, 'to contain', 'Y');
      expect(fontUsage.text, 'to contain', 'Z');
    });

    it('should emit debug timing information when debug is true', async function () {
      const logs = [];
      const mockConsole = { log: (msg) => logs.push(msg), warn: () => {} };

      await collectTextsByPage(assetGraph, htmlAssets, {
        debug: true,
        console: mockConsole,
      });

      expect(
        logs,
        'to have an item satisfying',
        'to contain',
        '[subfont timing]'
      );
    });
  });

  it('should return empty results for a page with no @font-face', async function () {
    const assetGraph = new AssetGraph({ root: localSingleRoot });
    const htmlAsset = assetGraph.addAsset({
      type: 'Html',
      text: '<html><head><style>h1 { color: red; }</style></head><body><h1>No fonts</h1></body></html>',
      url: `${assetGraph.root}nofont.html`,
    });
    await assetGraph.populate();

    const {
      htmlOrSvgAssetTextsWithProps,
      fontFaceDeclarationsByHtmlOrSvgAsset,
    } = await collectTextsByPage(assetGraph, [htmlAsset]);

    expect(htmlOrSvgAssetTextsWithProps, 'to be empty');
    expect(fontFaceDeclarationsByHtmlOrSvgAsset.get(htmlAsset), 'to be empty');
  });

  // Regression guard: https://github.com/alexander-turner/subfont/issues ...
  // Adding `font-size` to font-tracer propsToReturn buckets every text chunk
  // by size, exploding per-page entry counts 10-50x on sites with many
  // distinct sizes (headings, dropcaps, smallcaps). Each entry propagates
  // through globalTextByProps → snappedGlobalEntries → allTexts, OOMing the
  // 6 GB heap on TurnTrout-scale sites. Keep font-size out of the pipeline.
  it('should not expose a fontSizes property on fontUsage', async function () {
    const assetGraph = new AssetGraph({ root: localSingleRoot });
    await assetGraph.loadAssets('index.html');
    await assetGraph.populate();
    const htmlAssets = assetGraph.findAssets({
      type: 'Html',
      isInline: false,
    });
    const { htmlOrSvgAssetTextsWithProps } = await collectTextsByPage(
      assetGraph,
      htmlAssets
    );
    const fontUsage = htmlOrSvgAssetTextsWithProps[0].fontUsages[0];
    expect(fontUsage, 'not to have key', 'fontSizes');
    expect(fontUsage.props, 'not to have key', 'font-size');
  });

  it('should handle multiple pages sharing the same CSS (fast path)', async function () {
    const multiPageRoot = pathModule.resolve(
      __dirname,
      '../testdata/subsetFonts/inline-subsets-multi-page/'
    );
    const assetGraph = new AssetGraph({ root: multiPageRoot });
    await assetGraph.loadAssets(['index-1.html', 'index-2.html']);
    await assetGraph.populate();

    const htmlAssets = assetGraph.findAssets({ type: 'Html', isInline: false });
    const { htmlOrSvgAssetTextsWithProps } = await collectTextsByPage(
      assetGraph,
      htmlAssets
    );

    expect(
      htmlOrSvgAssetTextsWithProps.length,
      'to be greater than or equal to',
      1
    );
  });
});
