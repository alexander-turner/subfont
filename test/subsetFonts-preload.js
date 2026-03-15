const {
  expect,
  AssetGraph,
  pathModule,
  httpception,
  subsetFonts,
  setupCleanup,
} = require('./subsetFonts-helpers');

describe('subsetFonts preload/prefetch handling', function () {
  setupCleanup();

  it('should not break when there is an existing preload hint pointing to a font file', async function () {
    httpception();

    const assetGraph = new AssetGraph({
      root: pathModule.resolve(
        __dirname,
        '../testdata/subsetFonts/existing-preload/'
      ),
    });
    assetGraph.on('warn', (warn) =>
      expect(warn, 'to satisfy', /Cannot find module/)
    );
    await assetGraph.loadAssets('index.html');
    await assetGraph.populate({
      followRelations: {
        crossorigin: false,
      },
    });
    await subsetFonts(assetGraph);

    expect(assetGraph, 'to contain relation', 'HtmlPreloadLink');
  });

  it('should emit an info event when detaching prefetch relations to original fonts', async function () {
    httpception();

    const infos = [];

    const assetGraph = new AssetGraph({
      root: pathModule.resolve(
        __dirname,
        '../testdata/subsetFonts/existing-prefetch/'
      ),
    });
    assetGraph.on('info', function (info) {
      infos.push(info);
    });

    await assetGraph.loadAssets('index.html');
    await assetGraph.populate({
      followRelations: {
        crossorigin: false,
      },
    });
    await subsetFonts(assetGraph);

    expect(assetGraph, 'to contain no relation', 'HtmlPrefetchLink');

    expect(infos, 'to satisfy', [
      {
        message:
          'Detached <link rel="prefetch" as="font" type="application/x-font-ttf" href="OpenSans.ttf">. Will be replaced with preload with JS fallback.\nIf you feel this is wrong, open an issue at https://github.com/Munter/subfont/issues',
        asset: {
          type: 'Html',
        },
        relation: {
          type: 'HtmlPrefetchLink',
        },
      },
    ]);
  });

  describe('with jsPreload:false', function () {
    it('should not add the JavaScript-based preload "polyfill"', async function () {
      const assetGraph = new AssetGraph({
        root: pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/unused-variant/'
        ),
      });
      const [htmlAsset] = await assetGraph.loadAssets('index.html');
      await assetGraph.populate({
        followRelations: {
          crossorigin: false,
        },
      });
      await subsetFonts(assetGraph, {
        jsPreload: false,
      });

      expect(htmlAsset.text, 'not to contain', 'new FontFace');
    });
  });
});
