const {
  expect,
  subsetFonts,
  subsetFontsWithTestDefaults,
  setupCleanup,
  createGraph,
  loadAndPopulate,
} = require('./subsetFonts-helpers');

describe('subsetFonts CSS injection and rewriting', function () {
  setupCleanup();

  it('should handle HTML <link rel=stylesheet>', async function () {
    const assetGraph = createGraph('html-link');
    assetGraph.on('warn', (warn) =>
      expect(warn, 'to satisfy', /Cannot find module/)
    );
    await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
    await subsetFontsWithTestDefaults(assetGraph);

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

  it('should return relevant font subsetting information', async function () {
    const assetGraph = createGraph('html-link');
    assetGraph.on('warn', (warn) =>
      expect(warn, 'to satisfy', /Cannot find module/)
    );
    await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
    const result = await subsetFontsWithTestDefaults(assetGraph);

    expect(result, 'to exhaustively satisfy', {
      fontInfo: [
        {
          assetFileName: 'testdata/subsetFonts/html-link/index.html',
          fontUsages: [
            {
              smallestOriginalSize: expect.it('to be greater than', 20000),
              smallestOriginalFormat: 'ttf',
              smallestSubsetSize: expect.it('to be less than', 4000),
              smallestSubsetFormat: 'woff2',
              texts: ['Hello'],
              pageText: 'Helo',
              text: 'Helo',
              props: {
                'font-stretch': 'normal',
                'font-weight': '400',
                'font-style': 'normal',
                'font-family': 'Open Sans',
                src: expect.it('to contain', "format('truetype')"),
              },
              fontUrl: expect.it(
                'to start with',
                'https://fonts.gstatic.com/s/opensans/'
              ),
              fontFamilies: expect.it('to be a', Set),
              fontStyles: expect.it('to be a', Set),
              fontWeights: expect.it('to be a', Set),
              fontStretches: expect.it('to be a', Set),
              fontVariationSettings: expect.it('to be a', Set),
              hasOutOfBoundsAnimationTimingFunction: false,
              codepoints: {
                original: expect.it('to be an array'),
                used: [72, 101, 108, 111, 32],
                unused: expect.it('to be an array'),
                page: [72, 101, 108, 111, 32],
              },
              preload: true,
              variationAxes: undefined,
              fullyInstanced: false,
              numAxesPinned: 0,
              numAxesReduced: 0,
            },
          ],
        },
      ],
      timings: expect.it('to be an object'),
    });
  });

  describe('with `inlineCss: true`', function () {
    it('should inline the font Css and change outgoing relations to rootRelative', async function () {
      const assetGraph = createGraph('html-link');
      assetGraph.on('warn', (warn) =>
        expect(warn, 'to satisfy', /Cannot find module/)
      );
      await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
      await subsetFontsWithTestDefaults(assetGraph, {
        inlineCss: true,
      });

      expect(assetGraph, 'to contain asset', { fileName: 'index.html' });

      const index = assetGraph.findAssets({ fileName: 'index.html' })[0];
      expect(index.outgoingRelations, 'to satisfy', [
        {
          type: 'HtmlPreloadLink',
          hrefType: 'rootRelative',
          href: /^\/subfont\/Open_Sans-400-[a-f0-9]{10}\.woff2$/,
          to: {
            isLoaded: true,
          },
          as: 'font',
        },
        {
          type: 'HtmlStyle',
          href: undefined,
          to: {
            isLoaded: true,
            isInline: true,
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
  });

  it('should handle CSS @import', async function () {
    const assetGraph = createGraph('css-import');
    assetGraph.on('warn', (warn) =>
      expect(warn, 'to satisfy', /Cannot find module/)
    );
    await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
    await subsetFontsWithTestDefaults(assetGraph);

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

  it('should add the __subset font name to the font shorthand property', async function () {
    const assetGraph = createGraph('font-shorthand');
    assetGraph.on('warn', (warn) =>
      expect(warn, 'to satisfy', /Cannot find module/)
    );
    await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });

    await subsetFontsWithTestDefaults(assetGraph);

    expect(
      assetGraph.findAssets({ fileName: 'index.html' })[0].text,
      'to contain',
      "font: 12px/18px 'Open Sans__subset', 'Open Sans', Helvetica;"
    )
      .and(
        'to contain',
        ".with-weight-and-style { font: italic 700 12px/18px 'Open Sans__subset', 'Open Sans', Helvetica; }"
      )
      .and(
        'to contain',
        ".with-style-and-weight { font: italic 700 12px/18px 'Open Sans__subset', 'Open Sans', Helvetica; }"
      )
      .and(
        'to contain',
        ".with-weight { font: 700 12px/18px 'Open Sans__subset', 'Open Sans', Helvetica; }"
      );
  });

  it('should add the __subset font name to a custom property that contributes to the font-family property', async function () {
    const assetGraph = createGraph('font-shorthand-with-custom-property');
    assetGraph.on('warn', (warn) =>
      expect(warn, 'to satisfy', /Cannot find module/)
    );
    const [htmlAsset] = await assetGraph.loadAssets('index.html');

    // Remove annoying trailing \n inserted by jsdom that breaks the test because it makes us ask GWF to include space in the subset
    htmlAsset.parseTree.body.lastChild.nodeValue = '';

    await assetGraph.populate({
      followRelations: {
        crossorigin: false,
      },
    });

    await subsetFontsWithTestDefaults(assetGraph);

    expect(
      assetGraph.findAssets({ fileName: 'index.html' })[0].text,
      'to contain',
      "--unrelated-property: 'Open Sans', Helvetica;"
    )
      .and(
        'to contain',
        "--the-font: 'Open Sans__subset', 'Open Sans', Helvetica;"
      )
      .and(
        'to contain',
        "--the-font-family: 'Open Sans__subset', 'Open Sans', Helvetica;"
      )
      .and('to contain', 'foNT: 12px/18px var(--the-font)')
      .and('to contain', '--fallback-font: sans-serif')
      .and(
        'to contain',
        "foNT: 12px 'Open Sans__subset', 'Open Sans', var(--fallback-font);"
      )
      .and(
        'to contain',
        "font-FAMILY: 'Open Sans__subset', 'Open Sans', var(--fallback-font);"
      );
  });

  it('should not break if there is an existing reference to a Google Web Font CSS inside a script', async function () {
    const assetGraph = createGraph('google-webfont-ref-in-javascript');
    assetGraph.on('warn', console.log);
    await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
    await subsetFontsWithTestDefaults(assetGraph, {
      inlineCss: true,
    });
  });

  describe('when only one font format is requested', function () {
    describe('on a single page', function () {
      it('should inline the font subsets', async function () {
        const assetGraph = createGraph('inline-subsets');
        const [htmlAsset] = await loadAndPopulate(assetGraph, 'index.html', {
          crossorigin: false,
        });

        await subsetFonts(assetGraph, {
          formats: ['woff2'],
        });
        const css = assetGraph.findAssets({
          type: 'Css',
          fileName: /fonts-/,
        })[0];

        expect(css.outgoingRelations, 'to satisfy', [
          {
            type: 'CssFontFaceSrc',
            hrefType: `inline`,
            href: /^data:font\/woff2;base64/,
            to: {
              isInline: true,
              contentType: `font/woff2`,
            },
          },
        ]);
        // Regression test for https://github.com/Munter/subfont/pull/73
        expect(htmlAsset.text, 'not to contain', '<script>try{new FontFace');
      });

      it('should not inline unused variants', async function () {
        const assetGraph = createGraph('unused-variant');
        await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });

        await subsetFonts(assetGraph, {
          formats: ['woff'],
        });
        const css = assetGraph.findAssets({
          type: 'Css',
          fileName: /fonts-/,
        })[0];

        expect(css.outgoingRelations, 'to satisfy', [
          {
            type: 'CssFontFaceSrc',
            hrefType: 'inline',
            to: {
              isInline: true,
              contentType: 'font/woff',
            },
          },
          {
            type: 'CssFontFaceSrc',
            hrefType: 'rootRelative',
            to: {
              isInline: false,
              fileName: 'KFOjCnqEu92Fr1Mu51TzBic6CsI.woff',
            },
          },
        ]);
      });
    });

    describe('on multiple pages', function () {
      describe('when a font is used on all pages', function () {
        it('should inline the font subsets', async function () {
          const assetGraph = createGraph('inline-subsets-multi-page');
          await loadAndPopulate(assetGraph, ['index-1.html', 'index-2.html'], {
            crossorigin: false,
          });

          await subsetFonts(assetGraph, {
            formats: ['woff2'],
          });
          const css = assetGraph.findAssets({
            type: 'Css',
            fileName: /fonts-/,
          })[0];

          expect(css.outgoingRelations, 'to satisfy', [
            {
              type: 'CssFontFaceSrc',
              hrefType: `inline`,
              href: /^data:font\/woff2;base64/,
              to: {
                isInline: true,
                contentType: `font/woff2`,
              },
            },
            {
              type: 'CssFontFaceSrc',
              hrefType: `inline`,
              href: /^data:font\/woff2;base64/,
              to: {
                isInline: true,
                contentType: `font/woff2`,
              },
            },
          ]);
        });
      });

      describe('when a font is not used on all pages', function () {
        it('should not inline the subset', async function () {
          const assetGraph = createGraph('inline-one-subset-multi-page');
          await loadAndPopulate(assetGraph, ['index-1.html', 'index-2.html'], {
            crossorigin: false,
          });

          await subsetFonts(assetGraph, {
            formats: ['woff2'],
          });
          const css = assetGraph.findAssets({
            type: 'Css',
            fileName: /fonts-/,
          })[0];

          expect(css.outgoingRelations, 'to satisfy', [
            {
              type: 'CssFontFaceSrc',
              hrefType: `inline`,
              href: /^data:font\/woff2;base64/,
              to: {
                isInline: true,
                contentType: `font/woff2`,
              },
            },
            {
              type: 'CssFontFaceSrc',
              hrefType: 'rootRelative',
              to: {
                isInline: false,
                contentType: `font/woff2`,
                fileName: /^IBM_Plex_Sans-400i-[a-f0-9]{10}\.woff2$/,
              },
            },
          ]);
        });
      });
    });
  });

  describe('when more than one font format is requested', function () {
    it('should not inline the font subsets', async function () {
      const assetGraph = createGraph('inline-subsets');
      await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });

      await subsetFonts(assetGraph, {
        formats: ['woff', 'woff2'],
      });
      const css = assetGraph.findAssets({
        type: 'Css',
        fileName: /fonts-/,
      })[0];

      expect(css.outgoingRelations, 'to satisfy', [
        {
          type: 'CssFontFaceSrc',
          hrefType: `rootRelative`,
          to: {
            contentType: `font/woff2`,
          },
        },
        {
          type: 'CssFontFaceSrc',
          hrefType: `rootRelative`,
          to: {
            contentType: `font/woff`,
          },
        },
      ]);
    });
  });

  describe('when the same Google Web Font is referenced multiple times', function () {
    for (const { description, testDir, htmlStyleCount } of [
      {
        description:
          'should not break for two identical CSS @imports from the same asset',
        testDir: 'css-import-twice',
        htmlStyleCount: 3,
      },
      {
        description:
          'should not break for two CSS @imports in different stylesheets',
        testDir: 'css-import-twice-different-css',
        htmlStyleCount: 4,
      },
    ]) {
      it(description, async function () {
        const assetGraph = createGraph(testDir);
        await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
        await subsetFontsWithTestDefaults(assetGraph);

        expect(assetGraph, 'to contain relation', 'CssImport');
        expect(assetGraph, 'to contain relations', 'HtmlStyle', htmlStyleCount);
      });
    }
  });

  it('should handle multiple font-families', async function () {
    const assetGraph = createGraph('multi-family');
    assetGraph.on('warn', (warn) =>
      expect(warn, 'to satisfy', /Cannot find module/)
    );
    await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
    await subsetFontsWithTestDefaults(assetGraph);
    expect(assetGraph, 'to contain asset', { fileName: 'index.html' });

    const index = assetGraph.findAssets({ fileName: 'index.html' })[0];

    expect(index.outgoingRelations, 'to satisfy', [
      {
        type: 'HtmlPreloadLink',
        hrefType: 'rootRelative',
        href: expect
          .it('to begin with', '/subfont/Jim_Nightshade-400-')
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
          .it('to begin with', '/subfont/Montserrat-400-')
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
          .it('to begin with', '/subfont/Space_Mono-400-')
          .and('to end with', '.woff2')
          .and('to match', /[a-z0-9]{10}/),
        to: {
          isLoaded: true,
        },
        as: 'font',
      },
      {
        type: 'HtmlStyle',
        href: expect
          .it('to begin with', '/subfont/fonts-')
          .and('to end with', '.css')
          .and('to match', /[a-z0-9]{10}/),
        to: {
          isLoaded: true,
          text: expect
            .it('to contain', 'Jim Nightshade__subset')
            .and('to contain', 'Montserrat__subset')
            .and('to contain', 'Space Mono__subset'),
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
          text: expect
            .it('to contain', 'Jim Nightshade__subset')
            .and('to contain', 'Montserrat__subset')
            .and('to contain', 'Space Mono__subset'),
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

  it('should handle multiple font-weights and font-style', async function () {
    const assetGraph = createGraph('multi-weight');
    assetGraph.on('warn', (warn) =>
      expect(warn, 'to satisfy', /Cannot find module/)
    );
    await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
    await subsetFontsWithTestDefaults(assetGraph);

    expect(assetGraph, 'to contain asset', { fileName: 'index.html' });

    const index = assetGraph.findAssets({ fileName: 'index.html' })[0];

    expect(index.outgoingRelations, 'to satisfy', [
      {
        type: 'HtmlPreloadLink',
        hrefType: 'rootRelative',
        href: expect
          .it('to begin with', '/subfont/Roboto-500-')
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
          .it('to begin with', '/subfont/Roboto-400-')
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
          .it('to begin with', '/subfont/Roboto-300i-')
          .and('to end with', '.woff2')
          .and('to match', /[a-z0-9]{10}/),
        to: {
          isLoaded: true,
        },
        as: 'font',
      },
      {
        type: 'HtmlStyle',
        href: expect
          .it('to begin with', '/subfont/fonts-')
          .and('to end with', '.css')
          .and('to match', /[a-z0-9]{10}/),
        to: {
          isLoaded: true,
          text: expect.it('to contain', 'Roboto__subset'),
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
          text: expect.it('to contain', 'Roboto__subset'),
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

  describe('when running on multiple pages', function () {
    it('should share a common subset across pages', async function () {
      const assetGraph = createGraph('multi-page');
      assetGraph.on('warn', (warn) =>
        // FIXME: The mocked out woff and woff2 fonts from Google don't contain space.
        // Redo the mocks so we don't have to allow 'Missing glyph' here:
        expect(warn, 'to satisfy', /Missing glyph|Cannot find module/)
      );
      await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });
      await subsetFontsWithTestDefaults(assetGraph);

      expect(assetGraph, 'to contain asset', { fileName: 'index.html' });
      expect(assetGraph, 'to contain asset', { fileName: 'about.html' });

      const index = assetGraph.findAssets({ fileName: 'index.html' })[0];
      const about = assetGraph.findAssets({ fileName: 'about.html' })[0];

      expect(index.outgoingRelations, 'to satisfy', [
        {
          type: 'HtmlPreloadLink',
          hrefType: 'rootRelative',
          href: /^\/subfont\/Open_Sans-400-[a-f0-9]{10}\.woff2$/,
          to: {
            isLoaded: true,
          },
          as: 'font',
        },
        {
          type: 'HtmlStyle',
          href: expect
            .it('to begin with', '/subfont/fonts-')
            .and('to end with', '.css')
            .and('to match', /[a-z0-9]{10}/),
          to: {
            isLoaded: true,
          },
        },
        {
          type: 'HtmlStyle',
          to: { isInline: true },
        },
        {
          type: 'HtmlAnchor',
          href: 'about.html',
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

      const sharedFontStyles = index.outgoingRelations[2].to;
      const sharedFont = index.outgoingRelations[0].to;

      expect(about.outgoingRelations, 'to satisfy', [
        {
          type: 'HtmlPreloadLink',
          hrefType: 'rootRelative',
          href: /^\/subfont\/Open_Sans-400-[a-f0-9]{10}\.woff2$/,
          to: sharedFont,
          as: 'font',
        },
        {
          type: 'HtmlStyle',
          href: expect
            .it('to begin with', '/subfont/fonts-')
            .and('to end with', '.css')
            .and('to match', /[a-z0-9]{10}/),
          to: sharedFontStyles,
        },
        {
          type: 'HtmlStyle',
          to: { isInline: true },
        },
        {
          type: 'HtmlAnchor',
          href: 'index.html',
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

    it('should inject all @font-face declarations into every page, but only preload the used ones', async function () {
      const assetGraph = createGraph('multi-entry-points-ssr');
      const [firstHtmlAsset, secondHtmlAsset] = await loadAndPopulate(
        assetGraph,
        ['first.html', 'second.html']
      );
      await subsetFontsWithTestDefaults(assetGraph);
      expect(
        assetGraph.findRelations({
          from: firstHtmlAsset,
          type: 'HtmlPreloadLink',
        }),
        'to satisfy',
        [
          {
            href: expect.it('to begin with', '/subfont/font1-400-'),
          },
        ]
      );
      const firstSubfontCss = assetGraph.findRelations({
        from: firstHtmlAsset,
        type: 'HtmlStyle',
        to: { path: '/subfont/' },
      })[0].to;
      expect(
        firstSubfontCss.text,
        'to contain',
        'font-family:font1__subset'
      ).and('to contain', 'font-family:font2__subset');
      const secondSubfontCss = assetGraph.findRelations({
        from: secondHtmlAsset,
        type: 'HtmlStyle',
        to: { path: '/subfont/' },
      })[0].to;
      expect(firstSubfontCss, 'to be', secondSubfontCss);

      expect(
        assetGraph.findRelations({
          from: secondHtmlAsset,
          type: 'HtmlPreloadLink',
        }),
        'to satisfy',
        [
          {
            href: expect.it('to begin with', '/subfont/font2-400-'),
          },
        ]
      );
    });

    describe('when one of the pages does not use any webfonts, but has the original @font-face declarations', function () {
      it('should still include the __subset @font-face declarations on that page', async function () {
        const assetGraph = createGraph('one-page-with-no-usage-ssr');
        const [firstHtmlAsset, secondHtmlAsset] = await loadAndPopulate(
          assetGraph,
          ['first.html', 'second.html']
        );
        await subsetFontsWithTestDefaults(assetGraph);
        const firstSubfontCss = assetGraph.findRelations({
          from: firstHtmlAsset,
          type: 'HtmlStyle',
          to: { path: '/subfont/' },
        })[0].to;
        expect(firstSubfontCss.text, 'to contain', 'font-family:font1__subset');
        const secondSubfontCss = assetGraph.findRelations({
          from: secondHtmlAsset,
          type: 'HtmlStyle',
          to: { path: '/subfont/' },
        })[0].to;
        expect(firstSubfontCss, 'to be', secondSubfontCss);
      });
    });

    describe('when one of the pages does not use any webfonts and does not have the @font-face declarations in scope', function () {
      it('should not include the __subset @font-face declarations on that page', async function () {
        const assetGraph = createGraph('one-page-with-no-font-face-ssr');
        const [firstHtmlAsset, secondHtmlAsset] = await loadAndPopulate(
          assetGraph,
          ['first.html', 'second.html']
        );
        await subsetFontsWithTestDefaults(assetGraph);
        const firstSubfontCss = assetGraph.findRelations({
          from: firstHtmlAsset,
          type: 'HtmlStyle',
          to: { path: '/subfont/' },
        })[0].to;
        expect(firstSubfontCss.text, 'to contain', 'font-family:font1__subset');
        const secondSubfontCss = assetGraph.findRelations({
          from: secondHtmlAsset,
          type: 'HtmlStyle',
          to: { path: '/subfont/' },
        })[0];
        expect(secondSubfontCss, 'to be undefined');
      });
    });
  });

  describe('fontDisplay option', function () {
    for (const {
      description,
      fontDisplayValue,
      assertionFlag,
      assertionText,
    } of [
      {
        description:
          'should not add a font-display property when no fontDisplay is defined',
        fontDisplayValue: undefined,
        assertionFlag: 'not to contain',
        assertionText: 'font-display',
      },
      {
        description:
          'should not add a font-display property when an invalid font-display value is provided',
        fontDisplayValue: 'foo',
        assertionFlag: 'not to contain',
        assertionText: 'font-display',
      },
      {
        description: 'should add a font-display property',
        fontDisplayValue: 'block',
        assertionFlag: 'to contain',
        assertionText: '@font-face{font-display:block',
      },
      {
        description: 'should update an existing font-display property',
        fontDisplayValue: 'fallback',
        assertionFlag: 'to contain',
        assertionText: 'font-display:fallback;',
      },
    ]) {
      it(description, async function () {
        const assetGraph = createGraph('html-link');
        assetGraph.on('warn', (warn) =>
          expect(warn, 'to satisfy', /Cannot find module/)
        );
        await loadAndPopulate(assetGraph, 'index.html', { crossorigin: false });

        const subsetFontsOptions =
          fontDisplayValue !== undefined
            ? { fontDisplay: fontDisplayValue }
            : undefined;
        await subsetFontsWithTestDefaults(assetGraph, subsetFontsOptions);

        const cssAsset = assetGraph.findAssets({
          type: 'Css',
          fileName: /fonts-/,
        })[0];

        expect(cssAsset.text, assertionFlag, assertionText);
      });
    }
  });
});
