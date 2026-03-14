const expect = require('unexpected');
const { getSubsetPromiseId } = require('../lib/subsetGeneration');

describe('subsetGeneration', function () {
  describe('getSubsetPromiseId', function () {
    it('should produce a deterministic id from fontUsage, format, and axes', function () {
      const fontUsage = {
        text: 'abc',
        fontUrl: 'https://example.com/font.woff2',
      };
      const id = getSubsetPromiseId(fontUsage, 'woff2', { wght: 400 });
      expect(id, 'to be a string');
      // Should be the same for the same inputs
      expect(id, 'to equal', getSubsetPromiseId(fontUsage, 'woff2', { wght: 400 }));
    });

    it('should produce different ids for different formats', function () {
      const fontUsage = {
        text: 'abc',
        fontUrl: 'https://example.com/font.woff2',
      };
      const id1 = getSubsetPromiseId(fontUsage, 'woff2');
      const id2 = getSubsetPromiseId(fontUsage, 'woff');
      expect(id1, 'not to equal', id2);
    });

    it('should produce different ids for different texts', function () {
      const fontUsage1 = {
        text: 'abc',
        fontUrl: 'https://example.com/font.woff2',
      };
      const fontUsage2 = {
        text: 'xyz',
        fontUrl: 'https://example.com/font.woff2',
      };
      expect(
        getSubsetPromiseId(fontUsage1, 'woff2'),
        'not to equal',
        getSubsetPromiseId(fontUsage2, 'woff2')
      );
    });

    it('should produce different ids for different font URLs', function () {
      const fontUsage1 = {
        text: 'abc',
        fontUrl: 'https://example.com/font1.woff2',
      };
      const fontUsage2 = {
        text: 'abc',
        fontUrl: 'https://example.com/font2.woff2',
      };
      expect(
        getSubsetPromiseId(fontUsage1, 'woff2'),
        'not to equal',
        getSubsetPromiseId(fontUsage2, 'woff2')
      );
    });

    it('should produce different ids for different variation axes', function () {
      const fontUsage = {
        text: 'abc',
        fontUrl: 'https://example.com/font.woff2',
      };
      const id1 = getSubsetPromiseId(fontUsage, 'woff2', { wght: 400 });
      const id2 = getSubsetPromiseId(fontUsage, 'woff2', { wght: 700 });
      expect(id1, 'not to equal', id2);
    });

    it('should handle null variation axes', function () {
      const fontUsage = {
        text: 'abc',
        fontUrl: 'https://example.com/font.woff2',
      };
      const id = getSubsetPromiseId(fontUsage, 'woff2', null);
      expect(id, 'to be a string');
    });

    it('should handle no variation axes argument', function () {
      const fontUsage = {
        text: 'abc',
        fontUrl: 'https://example.com/font.woff2',
      };
      const id = getSubsetPromiseId(fontUsage, 'woff2');
      expect(id, 'to be a string');
    });

    it('should use record separator as delimiter', function () {
      const fontUsage = {
        text: 'abc',
        fontUrl: 'https://example.com/font.woff2',
      };
      const id = getSubsetPromiseId(fontUsage, 'woff2');
      expect(id, 'to contain', '\x1d');
    });
  });
});
