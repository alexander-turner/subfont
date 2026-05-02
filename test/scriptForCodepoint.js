const expect = require('unexpected');
const { scriptsForText } = require('../lib/scriptForCodepoint');

describe('scriptsForText', function () {
  it('always returns DFLT and latn even for empty text', function () {
    expect(scriptsForText('').sort(), 'to equal', ['DFLT', 'latn']);
  });

  it('returns just DFLT+latn for ASCII Latin text', function () {
    expect(scriptsForText('Hello world').sort(), 'to equal', ['DFLT', 'latn']);
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
    const tags = scriptsForText('a + b ∑ c');
    // Should only include DFLT + latn; ∑ (math) doesn't map to a script.
    expect(tags.sort(), 'to equal', ['DFLT', 'latn']);
  });
});
