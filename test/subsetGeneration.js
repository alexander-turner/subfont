const expect = require('unexpected');
const proxyquire = require('proxyquire').noCallThru();
const fs = require('fs');
const pathModule = require('path');
const os = require('os');
const {
  getSubsetPromiseId,
  _subsetCacheKey: subsetCacheKey,
  _SubsetDiskCache: SubsetDiskCache,
} = require('../lib/subsetGeneration');

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

  describe('subsetCacheKey', function () {
    it('should produce a deterministic hex string', function () {
      const key = subsetCacheKey(
        Buffer.from('font'),
        'abc',
        'woff2',
        null,
        null
      );
      expect(key, 'to be a string');
      expect(key, 'to match', /^[0-9a-f]{64}$/);
      expect(
        key,
        'to equal',
        subsetCacheKey(Buffer.from('font'), 'abc', 'woff2', null, null)
      );
    });

    it('should produce different keys for different inputs', function () {
      const base = [Buffer.from('font'), 'abc', 'woff2', null, null];
      const withAxes = [
        Buffer.from('font'),
        'abc',
        'woff2',
        { wght: 400 },
        null,
      ];
      const withGlyphs = [Buffer.from('font'), 'abc', 'woff2', null, [1, 2]];
      expect(
        subsetCacheKey(...base),
        'not to equal',
        subsetCacheKey(...withAxes)
      );
      expect(
        subsetCacheKey(...base),
        'not to equal',
        subsetCacheKey(...withGlyphs)
      );
    });
  });

  describe('SubsetDiskCache', function () {
    let tmpDir;

    beforeEach(function () {
      tmpDir = fs.mkdtempSync(pathModule.join(os.tmpdir(), 'subfont-test-'));
    });

    afterEach(function () {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return undefined for a cache miss', function () {
      const cache = new SubsetDiskCache(tmpDir);
      expect(cache.get('nonexistent'), 'to be undefined');
    });

    it('should store and retrieve a buffer', function () {
      const cache = new SubsetDiskCache(tmpDir);
      const buf = Buffer.from('hello');
      cache.set('mykey', buf);
      const result = cache.get('mykey');
      expect(result, 'to equal', buf);
    });

    it('should create the cache directory if it does not exist', function () {
      const nested = pathModule.join(tmpDir, 'sub', 'dir');
      const cache = new SubsetDiskCache(nested);
      cache.set('key', Buffer.from('data'));
      expect(fs.existsSync(nested), 'to be true');
    });

    it('should not throw on write errors', function () {
      // Use a path that cannot be written (file as directory)
      const filePath = pathModule.join(tmpDir, 'afile');
      fs.writeFileSync(filePath, 'x');
      const cache = new SubsetDiskCache(filePath);
      expect(() => cache.set('key', Buffer.from('data')), 'not to throw');
    });
  });
});
