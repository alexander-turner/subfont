const expect = require('unexpected');
const {
  pageNeedsMathTable,
  pageNeedsColorTables,
} = require('../lib/codepointHeuristics');

describe('codepointHeuristics', function () {
  describe('pageNeedsMathTable', function () {
    it('returns false for ASCII-only text', function () {
      expect(
        pageNeedsMathTable('The quick brown fox jumps over the lazy dog'),
        'to be false'
      );
    });

    it('returns false for Latin-1 supplement (é, ñ, ü)', function () {
      expect(pageNeedsMathTable('café piñata über'), 'to be false');
    });

    [
      ['Mathematical Operators', '∑ sums to infinity'],
      ['Misc Mathematical Symbols-A', '⟀'],
      ['Misc Mathematical Symbols-B', '⦀'],
      ['Supplemental Math Operators', '⨀'],
      ['Mathematical Alphanumeric Symbols', '\u{1d400}'],
      ['Arrows', 'a → b'],
    ].forEach(([label, sample]) => {
      it(`returns true for ${label}`, function () {
        expect(pageNeedsMathTable(sample), 'to be true');
      });
    });
  });

  describe('pageNeedsColorTables', function () {
    it('returns false for ASCII-only text', function () {
      expect(pageNeedsColorTables('hello world'), 'to be false');
    });

    [
      ['Emoticons', '\u{1f600}'],
      ['Misc Symbols and Pictographs', '\u{1f300}'],
      ['Supplemental Symbols and Pictographs', '\u{1f9ff}'],
      ['Misc Symbols (☂)', '☂'],
      ['Dingbats (✓)', '✓'],
    ].forEach(([label, sample]) => {
      it(`returns true for ${label}`, function () {
        expect(pageNeedsColorTables(sample), 'to be true');
      });
    });
  });
});
