const expect = require('unexpected');
const proxyquire = require('proxyquire').noCallThru();
const { getSubsetPromiseId } = require('../lib/subsetGeneration');

describe('subsetGeneration', function () {
  describe('getSubsetPromiseId', function () {
    const baseFontUsage = {
      text: 'abc',
      fontUrl: 'https://example.com/font.woff2',
    };

    it('should produce a deterministic id', function () {
      const id = getSubsetPromiseId(baseFontUsage, 'woff2', { wght: 400 });
      expect(id, 'to be a string');
      expect(
        id,
        'to equal',
        getSubsetPromiseId(baseFontUsage, 'woff2', { wght: 400 })
      );
    });

    it('should use record separator as delimiter', function () {
      expect(getSubsetPromiseId(baseFontUsage, 'woff2'), 'to contain', '\x1d');
    });

    [
      {
        desc: 'format',
        a: [baseFontUsage, 'woff2'],
        b: [baseFontUsage, 'woff'],
      },
      {
        desc: 'text',
        a: [{ text: 'abc', fontUrl: baseFontUsage.fontUrl }, 'woff2'],
        b: [{ text: 'xyz', fontUrl: baseFontUsage.fontUrl }, 'woff2'],
      },
      {
        desc: 'fontUrl',
        a: [
          { text: 'abc', fontUrl: 'https://example.com/font1.woff2' },
          'woff2',
        ],
        b: [
          { text: 'abc', fontUrl: 'https://example.com/font2.woff2' },
          'woff2',
        ],
      },
      {
        desc: 'variation axes',
        a: [baseFontUsage, 'woff2', { wght: 400 }],
        b: [baseFontUsage, 'woff2', { wght: 700 }],
      },
    ].forEach(({ desc, a, b }) => {
      it(`should produce different ids for different ${desc}`, function () {
        expect(
          getSubsetPromiseId(...a),
          'not to equal',
          getSubsetPromiseId(...b)
        );
      });
    });

    [null, undefined].forEach((axes) => {
      it(`should handle ${
        axes === null ? 'null' : 'undefined'
      } variation axes`, function () {
        expect(
          getSubsetPromiseId(baseFontUsage, 'woff2', axes),
          'to be a string'
        );
      });
    });
  });

  describe('getSubsetsForFontUsage', function () {
    it('should select the smallest format even when a larger format resolves first', async function () {
      // This test verifies that subset format selection is deterministic and
      // not affected by promise resolution order (the race condition fix).
      const smallBuffer = Buffer.alloc(100, 0x41); // 100 bytes
      const largeBuffer = Buffer.alloc(500, 0x42); // 500 bytes

      const { getSubsetsForFontUsage } = proxyquire('../lib/subsetGeneration', {
        'subset-font': function fakeSubsetFont(_buffer, _text, opts) {
          if (opts.targetFormat === 'woff2') {
            // woff2 is smaller but resolves LATER
            return new Promise((resolve) =>
              setTimeout(() => resolve(smallBuffer), 50)
            );
          }
          // woff is larger but resolves FIRST
          return Promise.resolve(largeBuffer);
        },
        './variationAxes': {
          getVariationAxisBounds: () => Promise.resolve(null),
        },
        './collectFeatureGlyphIds': () => Promise.resolve([]),
        './subsetFontWithGlyphs': () => Promise.resolve(smallBuffer),
      });

      const fontUrl = 'https://example.com/test.ttf';
      const fontBuffer = Buffer.alloc(10);
      const fontUsage = {
        text: 'abc',
        fontUrl,
      };

      const mockAssetGraph = {
        populate: () => Promise.resolve(),
        findAssets: () => [
          { url: fontUrl, isLoaded: true, rawSrc: fontBuffer },
        ],
        warn: () => {},
      };

      const htmlOrSvgAssetTextsWithProps = [{ fontUsages: [fontUsage] }];

      await getSubsetsForFontUsage(
        mockAssetGraph,
        htmlOrSvgAssetTextsWithProps,
        ['woff', 'woff2'],
        new Map(),
        false
      );

      // The smallest format should win regardless of resolution order
      expect(fontUsage.smallestSubsetFormat, 'to equal', 'woff2');
      expect(fontUsage.smallestSubsetSize, 'to equal', 100);
      // Both formats should be present in subsets
      expect(fontUsage.subsets, 'to have keys', ['woff', 'woff2']);
    });
  });
});
