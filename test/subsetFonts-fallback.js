const {
  expect,
  httpception,
  defaultLocalSubsetMock,
  subsetFonts,
  setupCleanup,
  createGraph,
  loadAndPopulate,
} = require('./subsetFonts-helpers');

describe('subsetFonts fallback CSS generation', function () {
  setupCleanup();

  it('should not mess up the placement of unicode-range in the fallback css', async function () {
    httpception(defaultLocalSubsetMock);

    const assetGraph = createGraph('html-link');
    assetGraph.on('warn', (warn) =>
      expect(warn, 'to satisfy', /is missing these characters/)
    );
    await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
    await subsetFonts(assetGraph, {
      inlineFonts: false,
    });

    const fallbackCss = assetGraph.findAssets({
      fileName: { $regex: /fallback-.*css$/ },
    })[0];
    // Verify that unicode-range is placed after the src (not before)
    expect(
      fallbackCss.text,
      'to match',
      /format\("woff"\);unicode-range:u\+/i
    );
  });

  it('should work with omitFallbacks:true and Google Web Fonts', async function () {
    httpception(defaultLocalSubsetMock);

    const assetGraph = createGraph('html-link');
    assetGraph.on('warn', (warn) =>
      expect(warn, 'to satisfy', /is missing these characters/)
    );
    const [htmlAsset] = await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
    await subsetFonts(assetGraph, {
      inlineCss: true,
      omitFallbacks: true,
    });
    expect(
      htmlAsset.text,
      'not to contain',
      '<link href="https://fonts.googleapis.com'
    );
  });

  describe('with omitFallbacks:true', function () {
    it('should remove the original @font-face declarations and references to them, and not make subsets of unused variants', async function () {
      httpception();

      const assetGraph = createGraph('no-fallbacks');
      const [htmlAsset] = await loadAndPopulate(assetGraph);
      await subsetFonts(assetGraph, {
        omitFallbacks: true,
      });

      expect(htmlAsset.text, 'to contain', 'font-family: Roboto__subset;')
        .and('to contain', 'font: 14px Roboto__subset, serif;')
        .and('not to contain', 'font-family: Roboto;')
        .and('not to contain', "font-family: 'Roboto';")
        .and('not to contain', "font-family: 'font-style: italic;");

      expect(assetGraph, 'to contain no asset', {
        fileName: 'KFOmCnqEu92Fr1Mu4mxM.woff',
      });

      const cssAsset = assetGraph.findAssets({
        fileName: { $regex: /^fonts-.*\.css$/ },
      })[0];
      expect(cssAsset.text, 'not to contain', 'font-style:italic');
    });
  });
});
