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

    it('should produce a deterministic id with record separator delimiter', function () {
      const id = getSubsetPromiseId(baseFontUsage, 'woff2', { wght: 400 });
      expect(id, 'to be a string');
      expect(id, 'to contain', '\x1d');
      expect(
        id,
        'to equal',
        getSubsetPromiseId(baseFontUsage, 'woff2', { wght: 400 })
      );
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
      it(`should handle ${axes === null ? 'null' : 'undefined'} variation axes`, function () {
        expect(
          getSubsetPromiseId(baseFontUsage, 'woff2', axes),
          'to be a string'
        );
      });
    });
  });

  describe('getSubsetsForFontUsage', function () {
    it('should select the smallest format even when a larger format resolves first', async function () {
      const smallBuffer = Buffer.alloc(100, 0x41);
      const largeBuffer = Buffer.alloc(500, 0x42);

      const { getSubsetsForFontUsage } = proxyquire('../lib/subsetGeneration', {
        './variationAxes': {
          getVariationAxisBounds: () => Promise.resolve(null),
        },
        './collectFeatureGlyphIds': () => Promise.resolve([]),
        './subsetFontWithGlyphs': (_buffer, _text, opts) =>
          opts.targetFormat === 'woff2'
            ? new Promise((resolve) =>
                setTimeout(() => resolve(smallBuffer), 50)
              )
            : Promise.resolve(largeBuffer),
      });

      const fontUrl = 'https://example.com/test.ttf';
      const fontUsage = { text: 'abc', fontUrl };
      const mockAssetGraph = {
        populate: () => Promise.resolve(),
        findAssets: () => [
          { url: fontUrl, isLoaded: true, rawSrc: Buffer.alloc(10) },
        ],
        warn: () => {},
      };

      await getSubsetsForFontUsage(
        mockAssetGraph,
        [{ fontUsages: [fontUsage] }],
        ['woff', 'woff2'],
        new Map(),
        false
      );

      expect(fontUsage.smallestSubsetFormat, 'to equal', 'woff2');
      expect(fontUsage.smallestSubsetSize, 'to equal', 100);
      expect(fontUsage.subsets, 'to have keys', ['woff', 'woff2']);
    });

    it('should skip a format when subsetFontWithGlyphs rejects and warn via assetGraph', async function () {
      const goodBuffer = Buffer.alloc(200, 0x43);
      const warnCalls = [];

      const { getSubsetsForFontUsage } = proxyquire('../lib/subsetGeneration', {
        './variationAxes': {
          getVariationAxisBounds: () => Promise.resolve(null),
        },
        './collectFeatureGlyphIds': () => Promise.resolve([]),
        './subsetFontWithGlyphs': (_buffer, _text, opts) =>
          opts.targetFormat === 'woff2'
            ? Promise.reject(new Error('simulated woff2 failure'))
            : Promise.resolve(goodBuffer),
      });

      const fontUrl = 'https://example.com/partial.ttf';
      const fontUsage = { text: 'abc', fontUrl };
      const fontAsset = {
        url: fontUrl,
        isLoaded: true,
        rawSrc: Buffer.alloc(10),
      };
      const mockAssetGraph = {
        populate: () => Promise.resolve(),
        findAssets: () => [fontAsset],
        warn: (err) => warnCalls.push(err),
      };

      await getSubsetsForFontUsage(
        mockAssetGraph,
        [{ fontUsages: [fontUsage] }],
        ['woff', 'woff2'],
        new Map(),
        false
      );

      // woff should have succeeded; woff2 should be absent (not undefined/null entries)
      expect(fontUsage.subsets, 'to have keys', ['woff']);
      expect(fontUsage.subsets.woff, 'to equal', goodBuffer);
      expect(fontUsage.smallestSubsetFormat, 'to equal', 'woff');
      // The failure should have been reported via assetGraph.warn and tagged with the asset
      expect(warnCalls, 'to have length', 1);
      expect(warnCalls[0].message, 'to equal', 'simulated woff2 failure');
      expect(warnCalls[0].asset, 'to be', fontAsset);
    });
  });

  describe('subsetCacheKey', function () {
    const base = [Buffer.from('font'), 'abc', 'woff2', null, null];

    it('should produce a deterministic 64-char hex string', function () {
      const key = subsetCacheKey(...base);
      expect(key, 'to match', /^[0-9a-f]{64}$/);
      expect(key, 'to equal', subsetCacheKey(...base));
    });

    [
      {
        desc: 'variationAxes',
        args: [Buffer.from('font'), 'abc', 'woff2', { wght: 400 }, null],
      },
      {
        desc: 'featureGlyphIds',
        args: [Buffer.from('font'), 'abc', 'woff2', null, [1, 2]],
      },
      {
        desc: 'extraOptions',
        args: [
          Buffer.from('font'),
          'abc',
          'woff2',
          null,
          null,
          { dropMathTable: true },
        ],
      },
    ].forEach(({ desc, args }) => {
      it(`should differ when ${desc} changes`, function () {
        expect(
          subsetCacheKey(...base),
          'not to equal',
          subsetCacheKey(...args)
        );
      });
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

    it('should return undefined for a cache miss', async function () {
      expect(
        await new SubsetDiskCache(tmpDir).get('nonexistent'),
        'to be undefined'
      );
    });

    it('should round-trip a buffer through set/get', async function () {
      const cache = new SubsetDiskCache(tmpDir);
      const buf = Buffer.from('hello');
      await cache.set('mykey', buf);
      expect(await cache.get('mykey'), 'to equal', buf);
    });

    it('should create nested cache directories on first write', async function () {
      const nested = pathModule.join(tmpDir, 'sub', 'dir');
      await new SubsetDiskCache(nested).set('key', Buffer.from('data'));
      expect(fs.existsSync(nested), 'to be true');
    });

    it('should not reject on write errors', async function () {
      const filePath = pathModule.join(tmpDir, 'afile');
      fs.writeFileSync(filePath, 'x');
      // set() should resolve without throwing even when the path is invalid
      await new SubsetDiskCache(filePath).set('key', Buffer.from('data'));
    });
  });
});
