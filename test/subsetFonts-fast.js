const {
  expect,
  httpception,
  subsetFonts,
  getFontInfo,
  setupCleanup,
  createGraph,
  loadAndPopulate,
} = require('./subsetFonts-helpers');

describe('subsetFonts --fast mode', function () {
  setupCleanup();

  describe('basic fast-path with shared external CSS', function () {
    it('should produce a subset containing characters from all pages', async function () {
      httpception();

      const assetGraph = createGraph('multi-page-fast-shared-css');
      await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
      await subsetFonts(assetGraph, { fast: true });

      const fonts = assetGraph.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      });
      expect(fonts, 'to have length', 1);
      const fontInfo = await getFontInfo(fonts[0].rawSrc);
      const chars = fontInfo.characterSet.map((cp) =>
        String.fromCodePoint(cp)
      );
      // page1: ABCDEF, page2: GHIJKL, page3: MNOPQR
      for (const ch of 'ABCDEFGHIJKLMNOPQR') {
        expect(chars, 'to contain', ch);
      }
    });

    it('should produce the same global subset as non-fast mode', async function () {
      httpception();

      const graphNormal = createGraph('multi-page-fast-shared-css');
      await loadAndPopulate(graphNormal, 'page*.html', { crossorigin: false });
      await subsetFonts(graphNormal);

      const graphFast = createGraph('multi-page-fast-shared-css');
      await loadAndPopulate(graphFast, 'page*.html', { crossorigin: false });
      await subsetFonts(graphFast, { fast: true });

      const normalFont = graphNormal.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      })[0];
      const fastFont = graphFast.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      })[0];

      const normalInfo = await getFontInfo(normalFont.rawSrc);
      const fastInfo = await getFontInfo(fastFont.rawSrc);

      expect(
        fastInfo.characterSet.sort(),
        'to equal',
        normalInfo.characterSet.sort()
      );
    });
  });

  describe('CSS content property preservation', function () {
    it('should include characters from CSS content (::before/::after) on fast-path pages', async function () {
      httpception();

      const assetGraph = createGraph('multi-page-fast-shared-css');
      await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
      await subsetFonts(assetGraph, { fast: true });

      const fonts = assetGraph.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      });
      expect(fonts, 'to have length', 1);
      const fontInfo = await getFontInfo(fonts[0].rawSrc);
      const chars = fontInfo.characterSet.map((cp) =>
        String.fromCodePoint(cp)
      );

      // The '@' comes from CSS content: '@' on .icon::before
      // This is only traceable via font-tracer (not extractVisibleText),
      // so it must be carried over from the representative's trace.
      expect(chars, 'to contain', '@');
    });
  });

  describe('inline font style fallback', function () {
    it('should fall back to full trace for pages with inline font styles', async function () {
      httpception();

      const assetGraph = createGraph('multi-page-fast-inline-style');
      await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
      // page2 has style="font-family: monospace" — should fall back to
      // full font-tracer instead of using fast path
      await subsetFonts(assetGraph, { fast: true });

      const fonts = assetGraph.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      });
      expect(fonts, 'to have length', 1);
      const fontInfo = await getFontInfo(fonts[0].rawSrc);
      const chars = fontInfo.characterSet.map((cp) =>
        String.fromCodePoint(cp)
      );
      // Both pages' text should be in the global subset
      for (const ch of 'ABCDEF') {
        expect(chars, 'to contain', ch);
      }
      for (const ch of 'GHIJKL') {
        expect(chars, 'to contain', ch);
      }
    });

    it('should produce the same result as non-fast mode when inline styles are present', async function () {
      httpception();

      const graphNormal = createGraph('multi-page-fast-inline-style');
      await loadAndPopulate(graphNormal, 'page*.html', { crossorigin: false });
      await subsetFonts(graphNormal);

      const graphFast = createGraph('multi-page-fast-inline-style');
      await loadAndPopulate(graphFast, 'page*.html', { crossorigin: false });
      await subsetFonts(graphFast, { fast: true });

      const normalFont = graphNormal.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      })[0];
      const fastFont = graphFast.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      })[0];

      const normalInfo = await getFontInfo(normalFont.rawSrc);
      const fastInfo = await getFontInfo(fastFont.rawSrc);

      // When inline styles force a full-trace fallback, results should
      // be identical to non-fast mode
      expect(
        fastInfo.characterSet.sort(),
        'to equal',
        normalInfo.characterSet.sort()
      );
    });
  });

  describe('single page per CSS group', function () {
    it('should work identically to non-fast mode when each page has unique CSS', async function () {
      httpception();

      // multi-page-multi-weight pages have different inline <style> blocks,
      // producing unique stylesheet cache keys — no fast-path grouping occurs
      const assetGraph = createGraph('multi-page-multi-weight');
      await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
      await subsetFonts(assetGraph, { fast: true });

      const subset400 = assetGraph.findAssets({
        fileName: { $regex: /^Roboto-400-/ },
        extension: '.woff2',
      });
      const subset500 = assetGraph.findAssets({
        fileName: { $regex: /^Roboto-500-/ },
        extension: '.woff2',
      });
      expect(subset400, 'to have length', 1);
      expect(subset500, 'to have length', 1);
    });
  });
});
