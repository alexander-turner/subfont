const expect = require('unexpected');
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
});
