const expect = require('unexpected');
const unquote = require('../lib/unquote');

describe('unquote', function () {
  describe('with a non-string', function () {
    it('should return the argument unchanged', function () {
      expect(unquote(undefined), 'to be undefined');
    });
  });

  describe('with a singlequoted string', function () {
    it('should return the contents of the quotes', function () {
      expect(unquote("'foo'"), 'to equal', 'foo');
    });

    describe('with a 4 letter hex escape sequence', function () {
      describe('followed by a single whitespace character', function () {
        it('should decode the escape sequence and not include the whitespace', function () {
          expect(unquote("'foo \\263a bar'"), 'to equal', 'foo ☺bar');
        });
      });

      describe('followed by two whitespace characters', function () {
        it('should decode the escape sequence and not include the first whitespace', function () {
          expect(unquote("'foo \\263a  bar'"), 'to equal', 'foo ☺ bar');
        });
      });

      describe('not followed by a space or hex character', function () {
        it('should decode the escape sequence', function () {
          expect(unquote("'foo \\263az'"), 'to equal', 'foo ☺z');
        });
      });
    });

    describe('with a 6 letter hex escape sequence', function () {
      describe('followed by a single whitespace character', function () {
        it('should decode the escape sequence and include the whitespace', function () {
          expect(unquote("'foo \\00263a bar'"), 'to equal', 'foo ☺ bar');
        });
      });

      describe('followed by two whitespace characters', function () {
        it('should decode the escape sequence and include the whitespace', function () {
          expect(unquote("'foo \\00263a  bar'"), 'to equal', 'foo ☺  bar');
        });
      });

      describe('not followed by a space or hex character', function () {
        it('should decode the escape sequence', function () {
          expect(unquote("'foo \\00263az'"), 'to equal', 'foo ☺z');
        });
      });

      describe('followed by a hex character', function () {
        it('should decode the escape sequence without the following hex character', function () {
          expect(unquote("'foo \\00263a0'"), 'to equal', 'foo ☺0');
        });
      });
    });

    describe('with multiple escape sequences', function () {
      it('should decode all the escape sequences', function () {
        expect(unquote("'foo \\263a bar \\263a'"), 'to equal', 'foo ☺bar ☺');
      });
    });

    describe('with astral Unicode codepoints (above U+FFFF)', function () {
      [
        { desc: '5-digit emoji', input: "'\\1f600'", expected: '😀' },
        {
          desc: '6-digit zero-padded emoji',
          input: "'\\01f600'",
          expected: '😀',
        },
        {
          desc: 'CJK Extension B (U+20000)',
          input: "'\\20000'",
          expected: '𠀀',
        },
        { desc: 'musical symbol (U+1D11E)', input: "'\\1d11e'", expected: '𝄞' },
        {
          desc: 'astral codepoint with surrounding text',
          input: "'hi \\1f600 bye'",
          expected: 'hi 😀bye',
        },
      ].forEach(({ desc, input, expected }) => {
        it(`should decode ${desc}`, function () {
          expect(unquote(input), 'to equal', expected);
        });
      });
    });
  });

  describe('with a doublequoted string', function () {
    it('should return the contents of the quotes', function () {
      expect(unquote('"foo"'), 'to equal', 'foo');
    });
  });

  describe('with an unquoted string', function () {
    it('should return the string', function () {
      expect(unquote('foo'), 'to equal', 'foo');
    });
  });

  describe('with an out-of-range hex escape', function () {
    it('should preserve the raw escape sequence', function () {
      expect(unquote("'\\ffffff'"), 'to equal', '\\ffffff');
    });
  });
});
