const {
  expect,
  LinesAndColumns,
  httpception,
  sinon,
  defaultLocalSubsetMock,
  subsetFonts,
  getFontInfo,
  setupCleanup,
  createGraph,
  loadAndPopulate,
} = require('./subsetFonts-helpers');

describe('subsetFonts core subsetting logic', function () {
  setupCleanup();

  it('should error out on multiple @font-face declarations with the same family/weight/style/stretch', async function () {
    httpception();

    const assetGraph = createGraph('woff2-original');
    await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
    await expect(
      subsetFonts(assetGraph),
      'to be rejected with',
      'Multiple @font-face with the same font-family/font-style/font-weight (maybe with different unicode-range?) is not supported yet: Roboto Slab/normal/300'
    );
  });

  it('should emit a warning when subsetting invalid fonts', async function () {
    httpception();

    const warnings = [];

    const assetGraph = createGraph('local-invalid');
    assetGraph.on('warn', function (warning) {
      warnings.push(warning);
    });
    await loadAndPopulate(assetGraph);
    await subsetFonts(assetGraph, {
      inlineCss: true,
    });
    expect(warnings, 'to satisfy', [
      expect
        .it('to be an', Error)
        .and('to have message', 'Unrecognized font signature: 0000')
        .and('to satisfy', {
          asset: expect.it('to be an', 'AssetGraph.asset'),
        }),
      expect
        .it('to be an', Error)
        .and('to have message', 'Unrecognized font signature: 0000')
        .and('to satisfy', {
          asset: expect.it('to be an', 'AssetGraph.asset'),
        }),
    ]);

    expect(assetGraph, 'to contain asset', { fileName: 'index.html' });

    const index = assetGraph.findAssets({ fileName: 'index.html' })[0];

    expect(index.outgoingRelations, 'to satisfy', [
      {
        type: 'HtmlPreloadLink',
        hrefType: 'rootRelative',
        href: '/OpenSans.ttf',
        to: {
          isLoaded: true,
        },
        as: 'font',
        contentType: 'font/ttf',
      },
      {
        type: 'HtmlStyle',
        to: {
          isLoaded: true,
          isInline: true,
          text: expect.it('to contain', 'Open Sans'),
          outgoingRelations: [
            {
              hrefType: 'relative',
              href: 'OpenSans.ttf',
              to: {
                isLoaded: true,
              },
            },
          ],
        },
      },
    ]);
  });

  describe('when the highest prioritized font-family is missing glyphs', function () {
    it('should emit an info event', async function () {
      httpception();

      const infoSpy = sinon.spy().named('warn');
      const assetGraph = createGraph('missing-glyphs');
      assetGraph.on('info', infoSpy);
      await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
      await subsetFonts(assetGraph);

      expect(infoSpy, 'to have calls satisfying', function () {
        infoSpy({
          message: expect
            .it('to contain', 'Missing glyph fallback detected')
            .and('to contain', '\\u{4e2d} (中)')
            .and('to contain', '\\u{56fd} (国)'),
        });
      });
    });

    describe('when the original @font-face declaration does not contain a unicode-range property', function () {
      it('should add a unicode-range property', async function () {
        httpception();

        const assetGraph = createGraph('missing-glyphs');
        assetGraph.on('warn', () => {}); // Don't fail due to the missing glyphs warning
        await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
        await subsetFonts(assetGraph);

        const [originalFontFaceSrcRelation] = assetGraph.findRelations({
          type: 'CssFontFaceSrc',
          to: { fileName: 'OpenSans.ttf' },
        });
        expect(
          originalFontFaceSrcRelation.from.text,
          'to match',
          /unicode-range:U\+20-7e,U\+a0-ff,/i
        );
      });
    });

    describe('when one out of multiple variants of a font-family has missing glyphs', function () {
      it('should add a unicode-range property to all of the @font-face declarations of the font-familys', async function () {
        httpception();

        const assetGraph = createGraph('missing-glyphs-multiple-variants');
        assetGraph.on('warn', () => {}); // Don't fail due to the missing glyphs warning

        await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
        await subsetFonts(assetGraph);

        const [outputSansRegularRelation] = assetGraph.findRelations({
          type: 'CssFontFaceSrc',
          to: { fileName: 'OutputSans-Regular.woff2' },
        });
        expect(
          outputSansRegularRelation.node.toString(),
          'not to contain',
          'unicode-range:'
        );
        const [outputSansBoldRelation] = assetGraph.findRelations({
          type: 'CssFontFaceSrc',
          to: { fileName: 'OutputSans-Bold.woff2' },
        });
        expect(
          outputSansBoldRelation.node.toString(),
          'not to contain',
          'unicode-range:'
        );

        const [inputMonoRegularRelation] = assetGraph.findRelations({
          type: 'CssFontFaceSrc',
          to: { fileName: 'InputMono-Regular.woff2' },
        });
        expect(
          inputMonoRegularRelation.node.toString(),
          'to match',
          /unicode-range:U\+/i
        );
        const [inputMonoBoldRelation] = assetGraph.findRelations({
          type: 'CssFontFaceSrc',
          to: { fileName: 'InputMono-Medium.woff2' },
        });
        expect(
          inputMonoBoldRelation.node.toString(),
          'to match',
          /unicode-range:U\+/i
        );
      });
    });

    describe('when the original @font-face declaration already contains a unicode-range property', function () {
      it('should leave the existing unicode-range alone', async function () {
        httpception();

        const assetGraph = createGraph('missing-glyphs-unicode-range');
        assetGraph.on('warn', () => {}); // Don't fail due to the missing glyphs warning
        await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
        await subsetFonts(assetGraph);

        const [originalFontFaceSrcRelation] = assetGraph.findRelations({
          type: 'CssFontFaceSrc',
          to: { fileName: 'OpenSans.ttf' },
        });
        expect(
          originalFontFaceSrcRelation.from.text,
          'to contain',
          'unicode-range:foobar'
        ).and('not to contain', 'unicode-range:U+64-7e,U+a0-ff,');
      });
    });

    it('should check for missing glyphs in any subset format', async function () {
      httpception();

      const infoSpy = sinon.spy().named('info');
      const assetGraph = createGraph('missing-glyphs');
      assetGraph.on('info', infoSpy);
      await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
      await subsetFonts(assetGraph, {
        formats: [`woff2`],
      });

      expect(infoSpy, 'to have calls satisfying', function () {
        infoSpy({
          message: expect
            .it('to contain', 'Missing glyph fallback detected')
            .and('to contain', '\\u{4e2d} (中)')
            .and('to contain', '\\u{56fd} (国)'),
        });
      });
    });

    // Some fonts don't contain these, but browsers don't seem to mind, so the messages would just be noise
    it('should not warn about tab and newline missing from the font being subset', async function () {
      httpception();

      const infoSpy = sinon.spy().named('info');
      const assetGraph = createGraph('missing-tab-and-newline-glyphs');
      assetGraph.on('warn', infoSpy);
      await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
      await subsetFonts(assetGraph);

      expect(infoSpy, 'was not called');
    });
  });

  it('should subset local fonts', async function () {
    httpception();

    const assetGraph = createGraph('local-single');
    await loadAndPopulate(assetGraph);
    await subsetFonts(assetGraph);

    expect(assetGraph, 'to contain asset', { fileName: 'index.html' });

    const index = assetGraph.findAssets({ fileName: 'index.html' })[0];

    expect(index.outgoingRelations, 'to satisfy', [
      {
        type: 'HtmlPreloadLink',
        hrefType: 'rootRelative',
        href: expect
          .it('to begin with', '/subfont/Open_Sans-400-')
          .and('to match', /-[0-9a-f]{10}\./)
          .and('to end with', '.woff2'),
        to: {
          isLoaded: true,
        },
        as: 'font',
        contentType: 'font/woff2',
      },
      {
        type: 'HtmlStyle',
        hrefType: 'rootRelative',
        href: expect
          .it('to begin with', '/subfont/fonts-')
          .and('to match', /-[0-9a-f]{10}\./)
          .and('to end with', '.css'),
        to: {
          isLoaded: true,
          isInline: false,
          text: expect.it('to contain', 'Open Sans__subset'),
          outgoingRelations: [
            {
              hrefType: 'rootRelative',
              href: expect
                .it('to begin with', '/subfont/Open_Sans-400-')
                .and('to match', /-[0-9a-f]{10}\./)
                .and('to end with', '.woff2'),
              to: {
                isLoaded: true,
              },
            },
            {
              hrefType: 'rootRelative',
              href: expect
                .it('to begin with', '/subfont/Open_Sans-400-')
                .and('to match', /-[0-9a-f]{10}\./)
                .and('to end with', '.woff'),
              to: {
                isLoaded: true,
              },
            },
          ],
        },
      },
      {
        type: 'HtmlStyle',
        to: {
          isLoaded: true,
          isInline: true,
        },
      },
      // Fallback loaders:
      {
        type: 'HtmlScript',
        hrefType: 'inline',
        to: { outgoingRelations: [{ type: 'JavaScriptStaticUrl' }] },
      },
      { type: 'HtmlNoscript', hrefType: 'inline' },
    ]);
  });

  it('should foo', async function () {
    httpception();

    const assetGraph = createGraph('local-with-noscript');
    await loadAndPopulate(assetGraph);
    await subsetFonts(assetGraph);

    expect(assetGraph, 'to contain asset', { fileName: 'index.html' });

    const index = assetGraph.findAssets({ fileName: 'index.html' })[0];
    expect(index.outgoingRelations, 'to satisfy', [
      {
        type: 'HtmlPreloadLink',
      },
      {
        type: 'HtmlStyle',
      },
      {
        type: 'HtmlNoscript',
      },
      // Fallback loaders:
      {
        type: 'HtmlScript',
      },
      { type: 'HtmlNoscript' },
    ]);
  });

  describe('with hrefType:relative', function () {
    it('should issue relative urls instead of root-relative ones', async function () {
      httpception();

      const assetGraph = createGraph('local-single');
      await loadAndPopulate(assetGraph);
      await subsetFonts(assetGraph, {
        inlineFonts: false,
        hrefType: 'relative',
      });

      expect(assetGraph, 'to contain asset', { fileName: 'index.html' });

      const index = assetGraph.findAssets({ fileName: 'index.html' })[0];

      expect(index.outgoingRelations, 'to satisfy', [
        {
          type: 'HtmlPreloadLink',
          hrefType: 'relative',
          href: expect
            .it('to begin with', 'subfont/Open_Sans-400-')
            .and('to match', /-[0-9a-f]{10}\./)
            .and('to end with', '.woff2'),
          to: {
            isLoaded: true,
          },
          as: 'font',
          contentType: 'font/woff2',
        },
        {
          type: 'HtmlStyle',
          hrefType: 'relative',
          href: expect
            .it('to begin with', 'subfont/fonts-')
            .and('to match', /-[0-9a-f]{10}\./)
            .and('to end with', '.css'),
          to: {
            isLoaded: true,
            isInline: false,
            text: expect.it('to contain', 'Open Sans__subset'),
            outgoingRelations: [
              {
                hrefType: 'relative',
                href: expect
                  .it('to begin with', 'Open_Sans-400-')
                  .and('to match', /-[0-9a-f]{10}\./)
                  .and('to end with', '.woff2'),
                to: {
                  isLoaded: true,
                },
              },
              {
                hrefType: 'relative',
                href: expect
                  .it('to begin with', 'Open_Sans-400-')
                  .and('to match', /-[0-9a-f]{10}\./)
                  .and('to end with', '.woff'),
                to: {
                  isLoaded: true,
                },
              },
            ],
          },
        },
        {
          type: 'HtmlStyle',
          to: {
            isLoaded: true,
            isInline: true,
          },
        },
        // Fallback loaders:
        {
          type: 'HtmlScript',
          hrefType: 'inline',
          to: { outgoingRelations: [{ type: 'JavaScriptStaticUrl' }] },
        },
        { type: 'HtmlNoscript', hrefType: 'inline' },
      ]);
    });
  });

  describe('when the stylesheet containing the original @font-face declarations did not contain anything else', function () {
    it('should be removed', async function () {
      const assetGraph = createGraph('local-with-no-css-rules-in-font-face-stylesheet');
      const [htmlAsset] = await loadAndPopulate(assetGraph);
      await subsetFonts(assetGraph);
      expect(htmlAsset.text, 'not to contain', '<style>');
    });
  });

  describe('when the stylesheet containing the original @font-face declarations did not contain anything else but a comment', function () {
    it('should be removed', async function () {
      const assetGraph = createGraph('local-with-no-css-rules-in-font-face-stylesheet-only-comment');
      const [htmlAsset] = await loadAndPopulate(assetGraph);
      await subsetFonts(assetGraph);
      expect(htmlAsset.text, 'not to contain', '<style>');
    });
  });

  describe('when the stylesheet containing the original @font-face declarations did not contain anything else but a license comment', function () {
    it('should be preserved', async function () {
      const assetGraph = createGraph('local-with-no-css-rules-in-font-face-stylesheet-only-license-comment');
      const [htmlAsset] = await loadAndPopulate(assetGraph);
      await subsetFonts(assetGraph);
      expect(
        htmlAsset.text,
        'to contain',
        '<style>/*! preserve me because of the exclamation mark */'
      );
    });
  });

  describe('with unused variants', function () {
    it('should provide a @font-face declaration for the __subset version of an unused variant', async function () {
      httpception();

      const assetGraph = createGraph('unused-variant');
      await loadAndPopulate(assetGraph);
      await subsetFonts(assetGraph, {
        inlineCss: true,
      });
      const subfontCss = assetGraph.findAssets({
        type: 'Css',
        isInline: true,
        text: { $regex: /KFOjCnqEu92Fr1Mu51TzBic6CsI/ },
      })[0];

      expect(
        subfontCss.text,
        'to contain',
        "font-family:Roboto__subset;font-stretch:normal;font-style:italic;font-weight:700;src:url(/KFOjCnqEu92Fr1Mu51TzBic6CsI.woff) format('woff')"
      );
      expect(assetGraph, 'to contain relation', {
        from: subfontCss,
        to: {
          url: `${assetGraph.root}KFOjCnqEu92Fr1Mu51TzBic6CsI.woff`,
        },
      });
    });

    describe('with inlineCss:false', function () {
      it('should put the @font-face declarations for the unused variants in the main subfont CSS rather than a separate one after the JS preload script', async function () {
        httpception();

        const assetGraph = createGraph('unused-variant');
        await loadAndPopulate(assetGraph);
        await subsetFonts(assetGraph, {
          inlineCss: false,
        });
        const subfontCss = assetGraph.findAssets({
          type: 'Css',
          path: '/subfont/',
        })[0];

        expect(
          subfontCss.text,
          'to contain',
          'font-family:Roboto__subset;font-stretch:normal;font-style:italic;font-weight:700;src:url(/KFOjCnqEu92Fr1Mu51TzBic6CsI.woff) format("woff")'
        );
        expect(assetGraph, 'to contain relation', {
          from: subfontCss,
          to: {
            url: `${assetGraph.root}KFOjCnqEu92Fr1Mu51TzBic6CsI.woff`,
          },
        });

        // Make sure that the extra stylesheet doesn't get generated in inlineCss:false mode:
        expect(assetGraph, 'to contain relations', 'HtmlStyle', 3);
      });
    });

    it('should not provide a @font-face declaration for the __subset version of an unused variant that did not get any subsets created', async function () {
      httpception();

      const assetGraph = createGraph('unused-font');
      await loadAndPopulate(assetGraph);
      await subsetFonts(assetGraph);

      const subfontCss = assetGraph.findAssets({
        type: 'Css',
        path: '/subfont/',
      })[0];

      expect(subfontCss.text, 'not to contain', 'unused__subset');
      expect(assetGraph, 'to contain no relation', {
        from: subfontCss,
        to: {
          url: `${assetGraph.root}subfont/Roboto-700i-846d1890ae.woff`,
        },
      });
    });

    it('should not move any of the original fonts to /subfont/', async function () {
      const assetGraph = createGraph('unused-variant-on-one-page');
      await loadAndPopulate(assetGraph, 'index*.html');
      await subsetFonts(assetGraph);

      expect(assetGraph, 'to contain asset', {
        url: `${assetGraph.root}IBMPlexSans-Regular.woff`,
      }).and('to contain asset', {
        url: `${assetGraph.root}IBMPlexSans-Italic.woff`,
      });
    });

    it('should not preload the unused variants', async function () {
      const assetGraph = createGraph('unused-variant-preload');
      const [htmlAsset] = await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
      await subsetFonts(assetGraph);
      const preloadLinks = assetGraph.findRelations({
        from: htmlAsset,
        type: 'HtmlPreloadLink',
      });
      expect(preloadLinks, 'to satisfy', [
        { href: /^\/subfont\/Input_Mono-400-[a-f0-9]{10}\.woff2$/ },
      ]);
    });

    describe('with Google Web Fonts', function () {
      it('should not preload the unused variants', async function () {
        const assetGraph = createGraph('unused-variant-preload-google');
        const [htmlAsset] = await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
        await subsetFonts(assetGraph);
        const preloadLinks = assetGraph.findRelations({
          from: htmlAsset,
          type: 'HtmlPreloadLink',
        });
        expect(preloadLinks, 'to satisfy', [
          { href: /^\/subfont\/Noto_Serif-400-[a-f0-9]{10}\.woff2$/ },
        ]);
      });
    });
  });

  it('should return a fontInfo object with defaulted/normalized props', async function () {
    httpception();

    const assetGraph = createGraph('font-face-defaults-and-casing');
    await loadAndPopulate(assetGraph);
    const { fontInfo } = await subsetFonts(assetGraph);

    expect(fontInfo, 'to satisfy', [
      {
        fontUsages: [
          {
            texts: ['Hello, world!'],
            props: {
              'font-family': 'Foo',
              'font-style': 'normal',
              'font-weight': 'boLD',
              'font-stretch': 'conDENSED',
              src: "url(OpenSans.ttf) format('truetype')",
            },
          },
          {
            texts: ['Hello, yourself!'],
            props: {
              'font-family': 'BAR',
              'font-style': 'ITAlic',
              'font-weight': 'normal',
              'font-stretch': 'normal',
              src: "url(OpenSans2.ttf) format('truetype')",
            },
          },
        ],
      },
    ]);
  });

  it('should support multiple @font-face blocks with different font-family, but same src', async function () {
    httpception();

    const assetGraph = createGraph('multiple-font-face-with-same-src');
    await loadAndPopulate(assetGraph);
    const { fontInfo } = await subsetFonts(assetGraph);

    expect(fontInfo, 'to satisfy', [
      {
        fontUsages: [
          {
            texts: ['Hello, world!', 'Hello, yourself!'],
            props: { 'font-family': 'foo' },
          },
        ],
      },
    ]);

    const htmlAsset = assetGraph.findAssets({
      type: 'Html',
    })[0];

    expect(htmlAsset.text, 'to contain', "font-family: foo__subset, 'foo'").and(
      'to contain',
      '<p style="font-family: foo__subset, bar">Hello, yourself!</p>'
    );
  });

  it('should tolerate case differences in font-family', async function () {
    httpception();

    const assetGraph = createGraph('local-font-family-case-difference');
    await loadAndPopulate(assetGraph);
    const { fontInfo } = await subsetFonts(assetGraph);

    expect(fontInfo, 'to satisfy', [
      {
        fontUsages: [
          {
            texts: ['Hello, world!', 'Hello, yourself!'],
            props: { 'font-family': 'Open Sans' },
          },
        ],
      },
    ]);
    expect(
      assetGraph.findAssets({ type: 'Css' })[0].text,
      'to contain',
      "font-family: 'Open Sans__subset', oPeN sAnS;"
    ).and('to contain', "--the-font: 'Open Sans__subset', OpEn SaNs;");
  });

  it('should handle HTML <link rel=stylesheet> with Google Fonts', async function () {
    httpception(defaultLocalSubsetMock);

    const assetGraph = createGraph('html-link');
    // FIXME: Maybe use a font that's not missing any chars?
    assetGraph.on('warn', (warn) =>
      expect(warn, 'to satisfy', /is missing these characters/)
    );
    await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
    await subsetFonts(assetGraph);

    expect(assetGraph, 'to contain asset', { fileName: 'index.html' });

    const index = assetGraph.findAssets({ fileName: 'index.html' })[0];

    expect(index.outgoingRelations, 'to satisfy', [
      {
        type: 'HtmlPreloadLink',
        hrefType: 'rootRelative',
        href: expect
          .it('to begin with', '/subfont/Open_Sans-400-')
          .and('to end with', '.woff2')
          .and('to match', /[a-z0-9]{10}/),
        to: {
          isLoaded: true,
        },
        as: 'font',
      },
      {
        type: 'HtmlStyle',
        hrefType: 'rootRelative',
        href: expect
          .it('to begin with', '/subfont/fonts-')
          .and('to end with', '.css')
          .and('to match', /[a-z0-9]{10}/),
        to: {
          isLoaded: true,
          text: expect.it('to contain', 'Open Sans__subset'),
          outgoingRelations: [
            {
              hrefType: 'rootRelative',
              to: {
                contentType: 'font/woff2',
                extension: '.woff2',
              },
            },

            {
              hrefType: 'rootRelative',
              to: {
                contentType: 'font/woff',
                extension: '.woff',
              },
            },
          ],
        },
      },
      {
        type: 'HtmlStyle',
        to: {
          isInline: true,
          text: expect.it('to contain', 'Open Sans__subset'),
        },
      },
      {
        type: 'HtmlScript',
        to: {
          isInline: true,
          outgoingRelations: [
            {
              type: 'JavaScriptStaticUrl',
              to: {
                path: '/subfont/',
                fileName: /^fallback-[a-f0-9]{10}\.css$/,
              },
            },
          ],
        },
      },
      {
        type: 'HtmlNoscript',
        to: {
          type: 'Html',
          isInline: true,
          isFragment: true,
          outgoingRelations: [
            {
              type: 'HtmlStyle',
              to: {
                path: '/subfont/',
                fileName: /^fallback-[a-f0-9]{10}\.css$/,
              },
            },
          ],
        },
      },
    ]);
  });

  it('should assume font-weight:normal and font-style:normal when not explicitly mentioned in the @font-face block', async function () {
    const assetGraph = createGraph('font-weight-and-style-omitted');
    await loadAndPopulate(assetGraph);
    const { fontInfo } = await subsetFonts(assetGraph);
    expect(fontInfo, 'to satisfy', [
      {
        fontUsages: [
          {
            text: 'fo',
            props: {
              'font-stretch': 'normal',
              'font-weight': 'normal',
              'font-style': 'normal',
              'font-family': 'Open Sans',
            },
          },
        ],
      },
    ]);
  });

  describe('when multiple pages contain the same subsets', function () {
    // https://github.com/Munter/subfont/issues/50
    it('should link to and preload the same subset files rather than creating two copies', async function () {
      const assetGraph = createGraph('multi-page-same-subset');
      const [htmlAsset1, htmlAsset2] = await loadAndPopulate(assetGraph, 'index*.html', { crossorigin: false });
      await subsetFonts(assetGraph);
      const preloads1 = htmlAsset1.outgoingRelations.filter(
        (relation) => relation.type === 'HtmlPreloadLink'
      );
      const preloads2 = htmlAsset2.outgoingRelations.filter(
        (relation) => relation.type === 'HtmlPreloadLink'
      );
      expect(preloads1, 'to have length', 1);
      expect(preloads2, 'to have length', 1);
      expect(preloads1[0].to, 'to be', preloads2[0].to);

      const regularSubsetFonts = assetGraph.findAssets({
        fileName: { $regex: /^IBM_Plex_Sans-400-/ },
        extension: '.woff2',
      });
      // Assert the absence of a -1.woff duplicate:
      expect(regularSubsetFonts, 'to have length', 1);

      expect(htmlAsset1.text, 'to equal', htmlAsset2.text);
    });
  });

  it('should handle mixed local fonts and Google fonts', async function () {
    httpception(defaultLocalSubsetMock);

    const assetGraph = createGraph('local-mixed');
    // FIXME: Maybe use a font that's not missing any chars?
    assetGraph.on('warn', (warn) =>
      expect(warn, 'to satisfy', /is missing these characters/)
    );
    await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
    await subsetFonts(assetGraph);

    expect(assetGraph, 'to contain asset', { fileName: 'index.html' });

    const index = assetGraph.findAssets({ fileName: 'index.html' })[0];

    expect(index.outgoingRelations, 'to satisfy', [
      {
        type: 'HtmlPreloadLink',
        hrefType: 'rootRelative',
        href: expect
          .it('to begin with', '/subfont/Local_Sans-400-')
          .and('to end with', '.woff2')
          .and('to match', /[a-z0-9]{10}/),
        to: {
          isLoaded: true,
        },
        as: 'font',
      },
      {
        type: 'HtmlPreloadLink',
        hrefType: 'rootRelative',
        href: expect
          .it('to begin with', '/subfont/Open_Sans-400-')
          .and('to end with', '.woff2')
          .and('to match', /[a-z0-9]{10}/),
        to: {
          isLoaded: true,
        },
        as: 'font',
      },
      {
        type: 'HtmlStyle',
        hrefType: 'rootRelative',
        href: expect
          .it('to begin with', '/subfont/fonts-')
          .and('to end with', '.css')
          .and('to match', /[a-z0-9]{10}/),
        to: {
          isLoaded: true,
          text: expect
            .it('to contain', 'Open Sans__subset')
            .and('to contain', 'Local Sans__subset'),
          outgoingRelations: [
            {
              type: 'CssFontFaceSrc',
              hrefType: 'rootRelative',
              to: {
                contentType: 'font/woff2',
                fileName: expect.it('to begin with', 'Local_Sans-400-'),
                extension: '.woff2',
              },
            },

            {
              type: 'CssFontFaceSrc',
              hrefType: 'rootRelative',
              to: {
                contentType: 'font/woff',
                fileName: expect.it('to begin with', 'Local_Sans-400-'),
                extension: '.woff',
              },
            },

            {
              type: 'CssFontFaceSrc',
              hrefType: 'rootRelative',
              to: {
                contentType: 'font/woff2',
                fileName: expect.it('to begin with', 'Open_Sans-400-'),
                extension: '.woff2',
              },
            },

            {
              type: 'CssFontFaceSrc',
              hrefType: 'rootRelative',
              to: {
                contentType: 'font/woff',
                fileName: expect.it('to begin with', 'Open_Sans-400-'),
                extension: '.woff',
              },
            },
          ],
        },
      },
      {
        type: 'HtmlStyle',
        to: {
          isInline: true,
          text: expect
            .it('to contain', 'Open Sans__subset')
            .and('to contain', 'Local Sans__subset'),
        },
      },
      // Self-hosted fallback loaders:
      {
        type: 'HtmlScript',
        hrefType: 'inline',
        to: { outgoingRelations: [{ type: 'JavaScriptStaticUrl' }] },
      },
      { type: 'HtmlNoscript', hrefType: 'inline' },
      // Google fallback loaders:
      {
        type: 'HtmlScript',
        to: {
          isInline: true,
          outgoingRelations: [
            {
              type: 'JavaScriptStaticUrl',
              to: {
                path: '/subfont/',
                fileName: /^fallback-[a-f0-9]{10}\.css$/,
              },
            },
          ],
        },
      },
      {
        type: 'HtmlNoscript',
        to: {
          type: 'Html',
          isInline: true,
          isFragment: true,
          outgoingRelations: [
            {
              type: 'HtmlStyle',
              to: {
                path: '/subfont/',
                fileName: /^fallback-[a-f0-9]{10}\.css$/,
              },
            },
          ],
        },
      },
    ]);
  });

  describe('with a variable font defined in a @supports block and a non-variable fallback', function () {
    it('should subset both the variable font and the fallback font', async function () {
      const assetGraph = createGraph('variable-font-in-supports-block-with-fallback');
      await loadAndPopulate(assetGraph);
      const { fontInfo } = await subsetFonts(assetGraph);
      expect(fontInfo, 'to satisfy', [
        {
          fontUsages: [
            {
              text: ' !,Hdelorw',
              props: {
                'font-stretch': 'normal',
                'font-weight': 'normal',
                'font-style': 'normal',
                'font-family': 'Venn VF',
              },
            },
            {
              text: ' !,Hdelorw',
              props: {
                'font-stretch': 'normal',
                'font-weight': 'normal',
                'font-style': 'normal',
                'font-family': 'Venn',
              },
            },
          ],
        },
      ]);

      expect(
        assetGraph.findAssets({ type: 'Css' })[0].text,
        'to contain',
        `font-family: 'Venn VF__subset', 'Venn VF', Venn__subset, 'Venn', sans-serif;`
      );
    });
  });

  describe('with a variable font defined in a @supports block and a non-variable fallback with two variants', function () {
    it('should subset both the variable font and the fallback font', async function () {
      const assetGraph = createGraph('variable-font-in-supports-block-with-two-fallback-variants');
      await loadAndPopulate(assetGraph);
      const { fontInfo } = await subsetFonts(assetGraph);
      expect(fontInfo, 'to satisfy', [
        {
          fontUsages: [
            {
              text: ' !,Hdelorw',
              props: {
                'font-stretch': 'normal',
                'font-weight': '300 800',
                'font-style': 'normal',
                'font-family': 'Venn VF',
              },
            },
            {
              text: 'dlorw',
              props: {
                'font-stretch': 'normal',
                'font-weight': '700',
                'font-style': 'normal',
                'font-family': 'Venn',
              },
            },
            {
              text: ' !,Helo',
              props: {
                'font-stretch': 'normal',
                'font-weight': '400',
                'font-style': 'normal',
                'font-family': 'Venn',
              },
            },
          ],
        },
      ]);
      expect(assetGraph, 'to contain asset', {
        fileName: {
          $regex: '^Venn_VF-300_800-[a-f0-9]+.woff2',
        },
      });
    });
  });

  describe('with two variable fonts that provide different font-weight ranges of the same font-family', function () {
    it('should subset both fonts when a CSS animation sweeps over both ranges', async function () {
      const assetGraph = createGraph('two-variable-fonts-animated');
      await loadAndPopulate(assetGraph);
      const { fontInfo } = await subsetFonts(assetGraph);
      expect(fontInfo, 'to satisfy', [
        {
          fontUsages: [
            {
              text: ' !,Hdelorw',
              props: {
                'font-stretch': 'normal',
                'font-weight': '1 500',
                'font-style': 'normal',
                'font-family': 'Venn VF',
              },
            },
            {
              text: ' !,Hdelorw',
              props: {
                'font-stretch': 'normal',
                'font-weight': '501 900',
                'font-style': 'normal',
                'font-family': 'Venn VF',
              },
            },
          ],
        },
      ]);
    });
  });

  describe('with a variable font that has unused axis ranges', function () {
    it('should emit an info event', async function () {
      const assetGraph = createGraph('variable-font-unused-axes');
      await loadAndPopulate(assetGraph);
      const infoSpy = sinon.spy().named('info');
      assetGraph.on('info', infoSpy);

      await subsetFonts(assetGraph);

      expect(infoSpy, 'to have calls satisfying', function () {
        infoSpy({
          message: expect.it(
            'to contain',
            'RobotoFlex-VariableFont_GRAD,XTRA,YOPQ,YTAS,YTDE,YTFI,YTLC,YTUC,opsz,slnt,wdth,wght.ttf:\n  Unused axes: wght, wdth, GRAD, slnt, XOPQ, YOPQ, YTLC, YTUC, YTDE, YTFI\n  Underutilized axes:\n    YTAS: 649-750 used (649-854 available)'
          ),
        });
      });
    });

    describe('for the wght axis', function () {
      it('should emit an info event', async function () {
        const assetGraph = createGraph('variable-font-unused-wght-axis');
        await loadAndPopulate(assetGraph);
        const infoSpy = sinon.spy().named('info');
        assetGraph.on('info', infoSpy);

        await subsetFonts(assetGraph);

        expect(infoSpy, 'to have calls satisfying', function () {
          infoSpy({
            message: expect.it(
              'to contain',
              'Underutilized axes:\n    wght: 350-820 used (100-1000 available)'
            ),
          });
        });
      });
    });

    describe('for the wdth axis', function () {
      it('should emit an info event', async function () {
        const assetGraph = createGraph('variable-font-unused-wdth-axis');
        await loadAndPopulate(assetGraph);
        const infoSpy = sinon.spy().named('info');
        assetGraph.on('info', infoSpy);

        await subsetFonts(assetGraph);

        expect(infoSpy, 'to have calls satisfying', function () {
          infoSpy({
            message: expect.it(
              'to contain',
              'wdth: 87.5-147 used (25-151 available)'
            ),
          });
        });
      });
    });

    describe('for the ital axis', function () {
      describe('when only font-style: normal is used', function () {
        it('should emit an info event', async function () {
          const assetGraph = createGraph('variable-font-unused-ital-axis');
          await loadAndPopulate(assetGraph, 'normal.html');
          const infoSpy = sinon.spy().named('info');
          assetGraph.on('info', infoSpy);

          await subsetFonts(assetGraph);

          expect(infoSpy, 'to have calls satisfying', function () {
            infoSpy({
              message: expect.it('to contain', 'Unused axes: ital'),
            });
          });
        });
      });

      describe('when only font-style: italic is used', function () {
        it('should emit an info event', async function () {
          const assetGraph = createGraph('variable-font-unused-ital-axis');
          await loadAndPopulate(assetGraph, 'italic.html');
          const infoSpy = sinon.spy().named('info');
          assetGraph.on('info', infoSpy);

          await subsetFonts(assetGraph);

          expect(infoSpy, 'to have calls satisfying', function () {
            infoSpy({
              message: expect.it(
                'to contain',
                'Underutilized axes:\n    ital: 1 used (0-1 available)'
              ),
            });
          });
        });
      });

      describe('when both font-style: normal and font-style: italic are used', function () {
        it('should not emit an info event', async function () {
          const assetGraph = createGraph('variable-font-unused-ital-axis');
          await loadAndPopulate(assetGraph, 'normal_and_italic.html');
          const infoSpy = sinon.spy().named('info');
          assetGraph.on('info', infoSpy);

          await subsetFonts(assetGraph);

          expect(infoSpy, 'was not called');
        });
      });
    });

    describe('for the slnt axis', function () {
      describe('when only font-style: normal is used', function () {
        it('should emit an info event', async function () {
          const assetGraph = createGraph('variable-font-unused-slnt-axis');
          await loadAndPopulate(assetGraph, 'normal.html');
          const infoSpy = sinon.spy().named('info');
          assetGraph.on('info', infoSpy);

          await subsetFonts(assetGraph);

          expect(infoSpy, 'to have calls satisfying', function () {
            infoSpy({
              message: expect.it('to contain', 'Unused axes: slnt, TRAK, wght'),
            });
          });
        });
      });

      describe('when only font-style: oblique is used', function () {
        it('should emit an info event', async function () {
          const assetGraph = createGraph('variable-font-unused-slnt-axis');
          await loadAndPopulate(assetGraph, 'oblique.html');
          const infoSpy = sinon.spy().named('info');
          assetGraph.on('info', infoSpy);

          await subsetFonts(assetGraph);

          expect(infoSpy, 'to have calls satisfying', function () {
            infoSpy({
              message: expect.it(
                'to contain',
                'Underutilized axes:\n    slnt: -14 used (-20-20 available)'
              ),
            });
          });
        });
      });

      describe('when both font-style: normal and font-style: oblique are used', function () {
        it('should emit an info event', async function () {
          const assetGraph = createGraph('variable-font-unused-slnt-axis');
          await loadAndPopulate(assetGraph, 'normal_and_oblique.html');
          const infoSpy = sinon.spy().named('info');
          assetGraph.on('info', infoSpy);

          await subsetFonts(assetGraph);

          expect(infoSpy, 'to have calls satisfying', function () {
            infoSpy({
              message: expect.it(
                'to contain',
                'Underutilized axes:\n    slnt: -14-0 used (-20-20 available)'
              ),
            });
          });
        });
      });
    });

    describe('being animated with a cubic-bezier timing function', function () {
      describe('that stays within bounds', function () {
        it('should inform about the axis being underutilized', async function () {
          const assetGraph = createGraph('variable-font-underutilized-axis-with-bezier');
          await loadAndPopulate(assetGraph);
          const infoSpy = sinon.spy().named('info');
          assetGraph.on('info', infoSpy);

          await subsetFonts(assetGraph);

          expect(infoSpy, 'to have calls satisfying', function () {
            infoSpy({
              message: expect.it(
                'to contain',
                'Underutilized axes:\n    YTAS: 649-750 used (649-854 available)'
              ),
            });
          });
        });
      });

      describe('that goes out of bounds', function () {
        it('should not inform about the axis being underutilized', async function () {
          const assetGraph = createGraph('variable-font-underutilized-axis-with-bezier-out-of-bounds');
          await loadAndPopulate(assetGraph);
          const infoSpy = sinon.spy().named('info');
          assetGraph.on('info', infoSpy);

          await subsetFonts(assetGraph);

          expect(infoSpy, 'to have calls satisfying', function () {
            infoSpy({
              message: expect.it('not to contain', 'YTAS:'),
            });
          });
        });
      });
    });
  });

  describe('instancing of variable fonts', function () {
    describe('with a variable font that can be fully instanced', function () {
      it('should remove the variation axes', async function () {
        const assetGraph = createGraph('variable-font-that-can-be-fully-instanced');
        await loadAndPopulate(assetGraph);
        const infoSpy = sinon.spy().named('info');
        assetGraph.on('info', infoSpy);

        await subsetFonts(assetGraph, { instance: true });

        const subsetFontAssets = assetGraph.findAssets({ type: 'Woff2' });
        expect(subsetFontAssets, 'to have length', 1);
        const { variationAxes } = await getFontInfo(subsetFontAssets[0].rawSrc);
        expect(variationAxes, 'to equal', {});
      });
    });

    describe('with a variable font that can be partially instanced', function () {
      it('should perform a partial instancing', async function () {
        const assetGraph = createGraph('variable-font-that-can-be-partially-instanced');
        await loadAndPopulate(assetGraph);
        const infoSpy = sinon.spy().named('info');
        assetGraph.on('info', infoSpy);

        await subsetFonts(assetGraph, { instance: true });

        const subsetFontAssets = assetGraph.findAssets({ type: 'Woff2' });
        expect(subsetFontAssets, 'to have length', 1);

        const { variationAxes } = await getFontInfo(subsetFontAssets[0].rawSrc);

        expect(variationAxes, 'to equal', {
          wght: { min: 100, default: 400, max: 405 },
        });
      });
    });
  });

  describe('with a page that does need subsetting and one that does', function () {
    // https://gitter.im/assetgraph/assetgraph?at=5dbb6438a3f0b17849c488cf
    it('should not short circuit because the first page does not need any subset fonts', async function () {
      const assetGraph = createGraph('firstPageNoSubset');
      await loadAndPopulate(assetGraph, ['index-1.html', 'index-2.html']);
      const { fontInfo } = await subsetFonts(assetGraph, {
        omitFallbacks: true,
      });

      expect(fontInfo, 'to satisfy', [
        {
          assetFileName: /\/index-1\.html$/,
          fontUsages: [
            {
              pageText: '',
              text: ' ABCDEFGHIJKLM',
            },
          ],
        },
        {
          assetFileName: /\/index-2\.html$/,
          fontUsages: [
            {
              pageText: ' ABCDEFGHIJKLM',
              text: ' ABCDEFGHIJKLM',
            },
          ],
        },
      ]);
    });
  });

  // From https://github.com/Munter/subfont/pull/84
  describe('with two pages that share the same CSS', function () {
    it('should discover subsets on both pages', async function () {
      const assetGraph = createGraph('multi-page-with-same-local-style-file');
      await loadAndPopulate(assetGraph, ['index.html', 'subindex.html']);
      const { fontInfo } = await subsetFonts(assetGraph, {
        omitFallbacks: true,
      });
      expect(fontInfo, 'to have length', 2);
      expect(fontInfo, 'to satisfy', [
        {
          assetFileName: /\/index\.html$/,
          fontUsages: [
            { text: 'Wdlor' },
            { text: ' ,Hbdehilmnosux' },
            {
              pageText: '',
              text: ' abcgko',
            },
          ],
        },
        {
          assetFileName: /\/subindex\.html$/,
          fontUsages: [
            { pageText: '', text: 'Wdlor' },
            { text: ' ,Hbdehilmnosux' },
            { text: ' abcgko' },
          ],
        },
      ]);
    });
  });

  describe('stylesheet result caching across pages with shared CSS', function () {
    it('should reuse cached stylesheet results and still produce correct per-page text', async function () {
      const assetGraph = createGraph('multi-page-with-same-local-style-file');
      await loadAndPopulate(assetGraph, ['index.html', 'subindex.html']);
      const { fontInfo } = await subsetFonts(assetGraph);
      expect(fontInfo, 'to have length', 2);

      // Both pages share the same CSS, so the stylesheet cache should be hit,
      // but each page must still have its own distinct pageText
      const page1 = fontInfo.find((info) =>
        /index\.html$/.test(info.assetFileName)
      );
      const page2 = fontInfo.find((info) =>
        /subindex\.html$/.test(info.assetFileName)
      );
      expect(page1, 'to be defined');
      expect(page2, 'to be defined');

      // Verify that per-page text differs (proves fontTracer runs per page
      // even though stylesheet results are cached)
      const page1Texts = page1.fontUsages.map((u) => u.pageText).join('');
      const page2Texts = page2.fontUsages.map((u) => u.pageText).join('');
      expect(page1Texts, 'not to equal', page2Texts);
    });
  });

  describe('with two pages that have different non-UTF-16 characters', function () {
    it('should not break when combining the characters', async function () {
      const assetGraph = createGraph('emojis');
      await loadAndPopulate(assetGraph, ['index-1.html', 'index-2.html']);
      assetGraph.on('warn', () => {}); // Ignore warning about IBMPlexSans-Regular.woff not containing the emojis
      const { fontInfo } = await subsetFonts(assetGraph);
      expect(fontInfo, 'to have length', 2);
      expect(fontInfo, 'to satisfy', [
        {
          assetFileName: /\/index-1.html$/,
          fontUsages: [{ pageText: ' 🤗🤞', text: ' 👊🤗🤞' }],
        },
        {
          assetFileName: /\/index-2\.html$/,
          fontUsages: [{ pageText: ' 👊🤗', text: ' 👊🤗🤞' }],
        },
      ]);
    });
  });

  describe('when a subset is created, but an unused variant points at a file that does not exist', function () {
    it('should leave the url of the unused variant as-is', async function () {
      const assetGraph = createGraph('nonExistentFont');
      assetGraph.on('warn', () => {}); // Don't halt on ENOENT Roboto-400-not-found-italic.woff2
      await loadAndPopulate(assetGraph);
      assetGraph.removeAllListeners('warn'); // Defensively don't suppress any further warnings
      const { fontInfo } = await subsetFonts(assetGraph);
      expect(fontInfo, 'to satisfy', [
        {
          assetFileName: /\/index.html$/,
          fontUsages: [{ pageText: 'Helo', text: 'Helo' }],
        },
      ]);
      const subfontCss = assetGraph.findAssets({
        type: 'Css',
        path: '/subfont/',
      })[0];
      expect(
        subfontCss.text,
        'to contain',
        'src:url(/Roboto-400-not-found-italic.woff2) format("woff2")'
      );
    });
  });

  describe('when two pages @import the same CSS file which in turn imports a Google font', function () {
    // Regression test for https://github.com/Munter/netlify-plugin-subfont/issues/32
    it('should not break', async function () {
      const assetGraph = createGraph('two-pages-import-css');
      await loadAndPopulate(assetGraph, ['index1.html', 'index2.html']);
      const { fontInfo } = await subsetFonts(assetGraph);
      expect(fontInfo, 'to satisfy', [
        {
          assetFileName: /\/index1.html$/,
          fontUsages: [{ pageText: 'fo', text: 'fo' }],
        },
        {
          assetFileName: /\/index2.html$/,
          fontUsages: [{ pageText: 'fo', text: 'fo' }],
        },
      ]);
    });
  });

  describe('with a CSS source map for a file that gets updated', function () {
    for (const testCase of ['external', 'inline']) {
      describe(testCase, function () {
        it('should update the source map', async function () {
          // lessc --source-map testdata/subsetFonts/css-source-map-${testCase}/styles.{less,css}
          const assetGraph = createGraph(`css-source-map-${testCase}`);
          await loadAndPopulate(assetGraph);
          function checkSourceMap() {
            const [sourceMap] = assetGraph.findAssets({ type: 'SourceMap' });
            expect(sourceMap.parseTree.sources, 'to satisfy', {
              0: expect
                .it('to equal', 'styles.less')
                .or('to equal', '/styles.less'),
            });
            const cssAsset = sourceMap.incomingRelations[0].from;
            const generatedPosition = new LinesAndColumns(
              cssAsset.text
            ).locationForIndex(
              cssAsset.text.indexOf('border: 1px solid black')
            );
            const originalPosition = sourceMap.originalPositionFor({
              line: generatedPosition.line + 1, // source-map's line numbers are 1-based, lines-and-column's are 0-based
              column: generatedPosition.column,
            });
            const lessAsset = sourceMap.outgoingRelations.find(
              (relation) => relation.type === 'SourceMapSource'
            ).to;
            const lessText = lessAsset.rawSrc.toString('utf-8');
            const originalIndex = new LinesAndColumns(
              lessText
            ).indexForLocation({
              line: originalPosition.line - 1,
              column: originalPosition.column,
            });
            expect(
              lessText.slice(originalIndex),
              'to begin with',
              'border: 1px solid black'
            );
          }
          checkSourceMap();
          await subsetFonts(assetGraph, { skipSourceMapProcessing: false });
          checkSourceMap();
        });
      });
    }
  });

  // Regression test: Used to break with Cannot read property 'toLowerCase' of undefined
  it('should not break when a @font-face declaration is missing font-family', async function () {
    const assetGraph = createGraph('missing-font-family');
    await loadAndPopulate(assetGraph);
    await subsetFonts(assetGraph);
  });

  describe('with escaped characters in font-family', function () {
    it('should issue a correct subset font family and subset font file name', async function () {
      const assetGraph = createGraph('font-family-with-escape');
      const [htmlAsset] = await loadAndPopulate(assetGraph);
      const { fontInfo } = await subsetFonts(assetGraph);
      expect(fontInfo, 'to satisfy', [
        { fontUsages: [{ fontFamilies: new Set(['Font Awesome 5 Free']) }] },
      ]);
      expect(
        htmlAsset.text,
        'to contain',
        "font-family: 'Font Awesome 5 Free__subset', Font Awesome\\ 5 Free;"
      ).and(
        'to contain',
        "font: 12px 'Font Awesome 5 Free__subset', 'Font Awesome 5 Free'"
      );
    });

    describe('with inlineCss:true', function () {
      it('should handle escaped characters in font-family', async function () {
        const assetGraph = createGraph('font-family-with-escape');
        const [htmlAsset] = await loadAndPopulate(assetGraph);
        const { fontInfo } = await subsetFonts(assetGraph, { inlineCss: true });
        expect(fontInfo, 'to satisfy', [
          { fontUsages: [{ fontFamilies: new Set(['Font Awesome 5 Free']) }] },
        ]);
        expect(
          htmlAsset.text,
          'to contain',
          "font-family: 'Font Awesome 5 Free__subset', Font Awesome\\ 5 Free;"
        )
          .and(
            'to contain',
            "font: 12px 'Font Awesome 5 Free__subset', 'Font Awesome 5 Free'"
          )
          .and(
            'to contain',
            'url(/subfont/Font_Awesome_5_Free-400-ba155ca153.woff)'
          );
      });
    });
  });

  describe('with non-truetype fonts in the mix', function () {
    it('should not attempt to subset non-truetype fonts', async function () {
      const assetGraph = createGraph('non-truetype-font');
      await loadAndPopulate(assetGraph);
      await subsetFonts(assetGraph);

      const html = assetGraph.findAssets({ type: 'Html' })[0];

      expect(html.outgoingRelations, 'to satisfy', [
        {
          type: 'HtmlStyle',
          to: {
            outgoingRelations: [
              {
                type: 'CssFontFaceSrc',
                href: 'one.eot',
              },
              {
                type: 'CssFontFaceSrc',
                href: 'two.eot?#iefix',
              },
              {
                type: 'CssFontFaceSrc',
                href: 'three.svg#icomoon',
              },
            ],
          },
        },
        { type: 'HtmlStyleAttribute' },
        { type: 'HtmlStyleAttribute' },
        { type: 'HtmlStyleAttribute' },
      ]);
    });

    it('should only subset truetype fonts despite non-truetype in the same declaration', async function () {
      const assetGraph = createGraph('non-truetype-and-truetype');
      await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
      await subsetFonts(assetGraph);
      expect(assetGraph, 'to contain asset', { fileName: 'index.html' });

      const index = assetGraph.findAssets({ fileName: 'index.html' })[0];
      expect(index.outgoingRelations, 'to satisfy', [
        {
          type: 'HtmlPreloadLink',
          hrefType: 'rootRelative',
          href: expect
            .it('to begin with', '/subfont/icomoon-400-')
            .and('to match', /-[0-9a-f]{10}\./)
            .and('to end with', '.woff2'),
          to: {
            isLoaded: true,
          },
          as: 'font',
          contentType: 'font/woff2',
        },
        {
          type: 'HtmlStyle',
          hrefType: 'rootRelative',
          href: expect
            .it('to begin with', '/subfont/fonts-')
            .and('to match', /-[0-9a-f]{10}\./)
            .and('to end with', '.css'),
          to: {
            isLoaded: true,
            isInline: false,
            text: expect.it('to contain', 'icomoon__subset'),
            outgoingRelations: [
              {
                hrefType: 'rootRelative',
                href: expect
                  .it('to begin with', '/subfont/icomoon-400-')
                  .and('to match', /-[0-9a-f]{10}\./)
                  .and('to end with', '.woff2'),
                to: {
                  isLoaded: true,
                },
              },
              {
                hrefType: 'rootRelative',
                href: expect
                  .it('to begin with', '/subfont/icomoon-400-')
                  .and('to match', /-[0-9a-f]{10}\./)
                  .and('to end with', '.woff'),
                to: {
                  isLoaded: true,
                },
              },
            ],
          },
        },
        {
          type: 'HtmlStyleAttribute',
          to: {
            text: expect.it('to contain', 'icomoon__subset'),
          },
        },
        // Fallback loaders:
        {
          type: 'HtmlScript',
          hrefType: 'inline',
          to: {
            outgoingRelations: [
              {
                type: 'JavaScriptStaticUrl',
                to: {
                  type: 'Css',
                  isLoaded: true,
                  isInline: false,
                  text: expect.it('to contain', 'icomoon'),
                  outgoingRelations: [
                    {
                      href: '/icomoon.eot',
                      to: { isLoaded: true },
                    },
                    {
                      href: '/icomoon.eot?#iefix',
                      to: { isLoaded: true },
                    },
                    {
                      href: '/icomoon.woff',
                      to: { isLoaded: true },
                    },
                    {
                      href: '/icomoon.ttf',
                      to: { isLoaded: true },
                    },
                    {
                      href: '/icomoon.svg#icomoon',
                      to: { isLoaded: true },
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          type: 'HtmlNoscript',
          hrefType: 'inline',
        },
      ]);
    });
  });

  describe('with -subfont-text', function () {
    describe('with a @font-face that is unused', function () {
      it('should make a subset with the specified characters', async function () {
        const assetGraph = createGraph('local-unused-with-subfont-text');
        await loadAndPopulate(assetGraph);
        const { fontInfo } = await subsetFonts(assetGraph);

        expect(fontInfo, 'to satisfy', {
          0: {
            fontUsages: [
              {
                texts: ['0123456789'],
                text: '0123456789',
              },
            ],
          },
        });

        // Make sure that the annotation gets stripped from the output:
        for (const cssAsset of assetGraph.findAssets({ type: 'Css' })) {
          expect(cssAsset.text, 'not to contain', '-subfont-text');
        }
      });
    });

    describe('with a @font-face that is also used', function () {
      describe('on a single page', function () {
        it('should add the specified characters to the subset', async function () {
          const assetGraph = createGraph('local-used-with-subfont-text');
          await loadAndPopulate(assetGraph);
          const { fontInfo } = await subsetFonts(assetGraph);

          expect(fontInfo, 'to satisfy', {
            0: {
              fontUsages: [
                {
                  texts: ['0123456789', 'Hello, world!'],
                  text: ' !,0123456789Hdelorw',
                },
              ],
            },
          });

          // Make sure that the annotation gets stripped from the output:
          for (const cssAsset of assetGraph.findAssets({ type: 'Css' })) {
            expect(cssAsset.text, 'not to contain', '-subfont-text');
          }
        });
      });

      describe('when the CSS is shared between multiple pages', function () {
        it('should add the specified characters to the subset', async function () {
          const assetGraph = createGraph('local-used-multipage-with-subfont-text');
          await loadAndPopulate(assetGraph, 'page*.html');
          const { fontInfo } = await subsetFonts(assetGraph);

          expect(fontInfo, 'to satisfy', {
            0: {
              fontUsages: [
                {
                  texts: ['0123456789', 'Hello, world!', 'Aloha, world!'],
                  text: ' !,0123456789AHadehlorw',
                },
              ],
            },
            1: {
              fontUsages: [
                {
                  texts: ['0123456789', 'Hello, world!', 'Aloha, world!'],
                  text: ' !,0123456789AHadehlorw',
                },
              ],
            },
          });

          // Make sure that the annotation gets stripped from the output:
          for (const cssAsset of assetGraph.findAssets({ type: 'Css' })) {
            expect(cssAsset.text, 'not to contain', '-subfont-text');
          }
        });
      });
    });
  });

  describe('with text explicitly passed to be included in all fonts', function () {
    describe('with a @font-face that is unused', function () {
      it('should make a subset with the specified characters', async function () {
        const assetGraph = createGraph('local-unused');
        await loadAndPopulate(assetGraph);
        const { fontInfo } = await subsetFonts(assetGraph, {
          text: '0123456789',
        });

        expect(fontInfo, 'to satisfy', {
          0: {
            fontUsages: [
              {
                texts: ['0123456789'],
                text: '0123456789',
              },
            ],
          },
        });
      });
    });

    describe('with a @font-face that is used', function () {
      it('should add the specified characters to the subset', async function () {
        const assetGraph = createGraph('local-used');
        await loadAndPopulate(assetGraph);
        const { fontInfo } = await subsetFonts(assetGraph, {
          text: '0123456789',
        });

        expect(fontInfo, 'to satisfy', {
          0: {
            fontUsages: [
              {
                texts: ['0123456789', 'Hello, world!'],
                text: ' !,0123456789Hdelorw',
              },
            ],
          },
        });
      });
    });
  });

  describe('with SVG using webfonts', function () {
    describe('in a standalone SVG', function () {
      it('should trace the correct characters and patch up the stylesheet', async function () {
        const assetGraph = createGraph('svg/img-element');
        await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
        const result = await subsetFonts(assetGraph);

        expect(result, 'to satisfy', {
          fontInfo: [
            {
              fontUsages: [
                {
                  text: ' !,Hdelorw',
                  props: {
                    'font-stretch': 'normal',
                    'font-weight': '400',
                    'font-style': 'normal',
                    'font-family': 'Roboto',
                    src: expect.it('to contain', "format('woff')"),
                  },
                },
              ],
            },
          ],
        });

        const svgAsset = assetGraph.findAssets({ type: 'Svg' })[0];
        expect(
          svgAsset.text,
          'to contain',
          '<text x="20" y="50" font-family="Roboto__subset, Roboto">Hello, world!</text>'
        );

        const svgStyle = assetGraph.findRelations({ type: 'SvgStyle' })[0];
        expect(svgStyle, 'to be defined');
        expect(
          svgStyle.to.text,
          'to contain',
          '@font-face{font-family:Roboto__subset;'
        );
      });
    });

    describe('within HTML', function () {
      describe('using webfonts defined in a stylesheet in the HTML', function () {
        it('should trace the correct characters and patch up the font-family attribute', async function () {
          const assetGraph = createGraph('svg/inline-in-html-with-html-font-face');
          const [htmlAsset] = await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
          const result = await subsetFonts(assetGraph);

          expect(result, 'to satisfy', {
            fontInfo: [
              {
                fontUsages: [
                  {
                    text: ' !,Hdelorw',
                    props: {
                      'font-stretch': 'normal',
                      'font-weight': '400',
                      'font-style': 'normal',
                      'font-family': 'Roboto',
                      src: expect.it('to contain', "format('woff')"),
                    },
                  },
                ],
              },
            ],
          });

          expect(
            htmlAsset.text,
            'to contain',
            '<text x="20" y="50" font-family="Roboto__subset, Roboto">Hello, world!</text>'
          );
        });
      });

      describe('using webfonts defined in a stylesheet defined in the SVG', function () {
        it('should trace the correct characters and patch up the SVG stylesheet', async function () {
          const assetGraph = createGraph('svg/inline-in-html-with-own-font-face');
          const [htmlAsset] = await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
          const result = await subsetFonts(assetGraph);

          expect(result, 'to satisfy', {
            fontInfo: [
              {
                fontUsages: [
                  {
                    text: ' !,Hdelorw',
                    props: {
                      'font-stretch': 'normal',
                      'font-weight': '400',
                      'font-style': 'normal',
                      'font-family': 'Roboto',
                      src: expect.it('to contain', "format('woff')"),
                    },
                  },
                ],
              },
            ],
          });

          expect(
            htmlAsset.text,
            'to contain',
            '<text x="20" y="50" font-family="Roboto__subset, Roboto">Hello, world!</text>'
          );

          const svgStyle = assetGraph.findRelations({ type: 'SvgStyle' })[0];
          expect(svgStyle, 'to be defined');
          expect(
            svgStyle.to.text,
            'to contain',
            '@font-face{font-family:Roboto__subset;'
          );
        });
      });

      describe('using a webfont defined both in the HTML and the SVG', function () {
        it('should trace the correct characters in both contexts and patch up both stylesheets', async function () {
          const assetGraph = createGraph('svg/inline-in-html-font-face-in-both-places');
          const [htmlAsset] = await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
          const result = await subsetFonts(assetGraph);

          expect(result, 'to satisfy', {
            fontInfo: [
              {
                assetFileName:
                  'testdata/subsetFonts/svg/inline-in-html-font-face-in-both-places/index.html',
                fontUsages: [
                  {
                    pageText: ' !,HYadelorwy', // Also includes the "Yay" in the HTML
                    text: ' !,HYadelorwy',
                    props: {
                      'font-stretch': 'normal',
                      'font-weight': '400',
                      'font-style': 'normal',
                      'font-family': 'Roboto',
                      src: expect.it('to contain', "format('woff')"),
                    },
                  },
                ],
              },
              {
                assetFileName:
                  'testdata/subsetFonts/svg/inline-in-html-font-face-in-both-places/index.html', // The SVG island
                fontUsages: [
                  {
                    pageText: ' !,Hdelorw', // Does not include the "Yay" in the HTML
                    text: ' !,HYadelorwy',
                    props: {
                      'font-stretch': 'normal',
                      'font-weight': '400',
                      'font-style': 'normal',
                      'font-family': 'Roboto',
                      src: expect.it('to contain', "format('woff')"),
                    },
                  },
                ],
              },
            ],
          });

          expect(
            htmlAsset.text,
            'to contain',
            '<text x="20" y="50" font-family="Roboto__subset, Roboto">Hello, world!</text>'
          );

          const htmlStyle = assetGraph.findRelations({ type: 'HtmlStyle' })[0];
          expect(htmlStyle, 'to be defined');
          expect(
            htmlStyle.to.text,
            'to contain',
            '@font-face{font-family:Roboto__subset;'
          );

          const svgStyle = assetGraph.findRelations({ type: 'SvgStyle' })[0];
          expect(svgStyle, 'to be defined');
          expect(
            svgStyle.to.text,
            'to contain',
            '@font-face{font-family:Roboto__subset;'
          );
        });
      });
    });

    it('should not crash when an SVG asset fails to load and has no parseTree', async function () {
      const assetGraph = createGraph('svg/img-element');
      await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });

      // Simulate an SVG that failed to load (e.g. DNS error) by adding
      // an unloaded SVG asset to the graph
      const brokenSvg = assetGraph.addAsset({
        type: 'Svg',
        url: 'https://broken.example.com/missing.svg',
      });
      expect(brokenSvg.isLoaded, 'to be false');

      await subsetFonts(assetGraph);
    });
  });

  describe('caching optimizations', function () {
    describe('fontTracer content-hash cache', function () {
      it('should produce identical results for pages with identical HTML and CSS', async function () {
        const assetGraph = createGraph('multi-page-identical');
        const [page1, page2] = await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
        await subsetFonts(assetGraph);

        // Both pages should get the same subset font and identical output
        expect(page1.text, 'to equal', page2.text);

        // Both should have a preload link to the same subset font
        const preloads1 = page1.outgoingRelations.filter(
          (r) => r.type === 'HtmlPreloadLink'
        );
        const preloads2 = page2.outgoingRelations.filter(
          (r) => r.type === 'HtmlPreloadLink'
        );
        expect(preloads1, 'to have length', 1);
        expect(preloads2, 'to have length', 1);
        expect(preloads1[0].to, 'to be', preloads2[0].to);
      });

      it('should produce correct but distinct results for pages with different text content', async function () {
        const assetGraph = createGraph('multi-page-different-text');
        await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
        await subsetFonts(assetGraph);

        // The subset font should contain characters from both pages
        const subsetFonts_ = assetGraph.findAssets({
          fileName: { $regex: /^IBM_Plex_Sans-400-/ },
          extension: '.woff2',
        });
        expect(subsetFonts_, 'to have length', 1);
        const fontInfo = await getFontInfo(subsetFonts_[0].rawSrc);
        const chars = fontInfo.characterSet.map((cp) =>
          String.fromCodePoint(cp)
        );
        // Characters from page1
        for (const ch of 'ABCDEF') {
          expect(chars, 'to contain', ch);
        }
        // Characters from page2
        for (const ch of 'GHIJKL') {
          expect(chars, 'to contain', ch);
        }
      });
    });

    describe('font snapping result cache', function () {
      it('should correctly handle multiple font weights across pages sharing the same CSS', async function () {
        const assetGraph = createGraph('multi-page-multi-weight');
        await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
        await subsetFonts(assetGraph);

        // Should produce two subset fonts: one for weight 400, one for 500
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

        // The 400-weight subset should contain chars from both pages' body text
        const fontInfo400 = await getFontInfo(subset400[0].rawSrc);
        const chars400 = fontInfo400.characterSet.map((cp) =>
          String.fromCodePoint(cp)
        );
        // 'Regular text on page one' and 'Regular text on page two' share most chars
        for (const ch of 'Regulartxonpw') {
          expect(chars400, 'to contain', ch);
        }

        // The 500-weight subset should contain chars from both pages' h1 text
        const fontInfo500 = await getFontInfo(subset500[0].rawSrc);
        const chars500 = fontInfo500.characterSet.map((cp) =>
          String.fromCodePoint(cp)
        );
        // 'Title One' and 'Title Two'
        for (const ch of 'TitleOnwo') {
          expect(chars500, 'to contain', ch);
        }
      });
    });

    describe('stylesheet result caching', function () {
      it('should produce correct results when multiple pages share the same stylesheet', async function () {
        const assetGraph = createGraph('multi-page-with-same-local-style-file');
        await loadAndPopulate(assetGraph, '*.html', { crossorigin: false });
        await subsetFonts(assetGraph);

        const htmlAssets = assetGraph.findAssets({
          type: 'Html',
          isLoaded: true,
          isInline: false,
        });
        expect(htmlAssets.length, 'to be greater than or equal to', 2);

        // Each page should have preload links (the caching should not cause missed subsets)
        for (const htmlAsset of htmlAssets) {
          const preloads = htmlAsset.outgoingRelations.filter(
            (r) => r.type === 'HtmlPreloadLink'
          );
          expect(preloads.length, 'to be greater than or equal to', 1);
        }
      });
    });

    describe('worker pool parallelization', function () {
      it('should produce correct subsets when using the worker pool (5 pages)', async function () {
        const assetGraph = createGraph('multi-page-worker-pool');
        await loadAndPopulate(assetGraph, 'page*.html', { crossorigin: false });
        await subsetFonts(assetGraph);

        // The subset font should contain characters from all 5 pages
        const subsetFonts_ = assetGraph.findAssets({
          fileName: { $regex: /^IBM_Plex_Sans-400-/ },
          extension: '.woff2',
        });
        expect(subsetFonts_, 'to have length', 1);
        const fontInfo = await getFontInfo(subsetFonts_[0].rawSrc);
        const chars = fontInfo.characterSet.map((cp) =>
          String.fromCodePoint(cp)
        );
        // Characters from all 5 pages (ABCDE, FGHIJ, KLMNO, PQRST, UVWXY)
        for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXY') {
          expect(chars, 'to contain', ch);
        }
      });
    });
  });
});
