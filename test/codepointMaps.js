const expect = require('unexpected');
const {
  pageNeedsMathTable,
  pageNeedsColorTables,
  scriptsForText,
} = require('../lib/codepointMaps');

describe('codepointMaps', function () {
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

  describe('scriptsForText', function () {
    it('always returns DFLT and latn even for empty text', function () {
      expect(scriptsForText('').sort(), 'to equal', ['DFLT', 'latn']);
    });

    it('returns just DFLT+latn for ASCII Latin text', function () {
      expect(scriptsForText('Hello world').sort(), 'to equal', [
        'DFLT',
        'latn',
      ]);
    });

    [
      { name: 'Cyrillic', text: 'Привет', expected: 'cyrl' },
      { name: 'Greek', text: 'Γεια σας', expected: 'grek' },
      { name: 'Arabic', text: 'مرحبا', expected: 'arab' },
      { name: 'Hebrew', text: 'שלום', expected: 'hebr' },
      { name: 'Devanagari', text: 'नमस्ते', expected: 'deva' },
      { name: 'Bengali', text: 'হ্যালো', expected: 'beng' },
      { name: 'Tamil', text: 'வணக்கம்', expected: 'taml' },
      { name: 'Hiragana/Katakana', text: 'こんにちは', expected: 'kana' },
      { name: 'Hangul', text: '안녕하세요', expected: 'hang' },
      { name: 'Han / CJK ideographs', text: '你好', expected: 'hani' },
    ].forEach(({ name, text, expected }) => {
      it(`detects ${name}`, function () {
        const tags = scriptsForText(text);
        expect(tags, 'to contain', expected);
        expect(tags, 'to contain', 'DFLT');
        expect(tags, 'to contain', 'latn');
      });
    });

    it('handles mixed-script text', function () {
      const tags = scriptsForText('Hello Привет 你好');
      expect(tags, 'to contain', 'latn');
      expect(tags, 'to contain', 'cyrl');
      expect(tags, 'to contain', 'hani');
    });

    it('skips unmappable codepoints (math operators)', function () {
      // Should only include DFLT + latn; ∑ (math) doesn't map to a script.
      expect(scriptsForText('a + b ∑ c').sort(), 'to equal', ['DFLT', 'latn']);
    });
  });
});
