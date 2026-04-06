const expect = require('unexpected');
const {
  _escapeJsStringLiteral: escapeJsStringLiteral,
} = require('../lib/subsetFonts');

describe('escapeJsStringLiteral', function () {
  it('should return plain strings unchanged', function () {
    expect(escapeJsStringLiteral('hello'), 'to equal', 'hello');
  });

  it('should escape single quotes', function () {
    expect(escapeJsStringLiteral("it's"), 'to equal', "it\\'s");
  });

  it('should escape double quotes', function () {
    expect(escapeJsStringLiteral('say "hi"'), 'to equal', 'say \\"hi\\"');
  });

  it('should escape backslashes', function () {
    expect(escapeJsStringLiteral('a\\b'), 'to equal', 'a\\\\b');
  });

  it('should escape newlines', function () {
    expect(escapeJsStringLiteral('a\nb'), 'to equal', 'a\\nb');
  });

  it('should escape carriage returns', function () {
    expect(escapeJsStringLiteral('a\rb'), 'to equal', 'a\\rb');
  });

  it('should pass through line separator (U+2028) — safe in ES2019+ strings', function () {
    const result = escapeJsStringLiteral('a\u2028b');
    // U+2028 is legal in JSON and ES2019+ string literals.
    // Either escaping or passing through is acceptable.
    expect(result, 'to match', /^a(?:\u2028|\\u2028)b$/);
  });

  it('should pass through paragraph separator (U+2029) — safe in ES2019+ strings', function () {
    const result = escapeJsStringLiteral('a\u2029b');
    expect(result, 'to match', /^a(?:\u2029|\\u2029)b$/);
  });

  it('should escape < to prevent </script> injection', function () {
    expect(
      escapeJsStringLiteral("</script><script>alert('xss')"),
      'to equal',
      "\\x3c/script>\\x3cscript>alert(\\'xss\\')"
    );
  });

  it('should handle a URL with a single quote', function () {
    const url = "https://example.com/font's.css";
    const escaped = escapeJsStringLiteral(url);
    // The escaped value should be safe inside single-quoted JS string:
    // raw single quotes must not appear (only escaped ones)
    expect(escaped, 'not to match', /(?<!\\)'/);
    expect(escaped, 'to contain', "\\'");
  });

  it('should handle combined special characters', function () {
    const input = 'a\'b"c\\d\ne\rf';
    const escaped = escapeJsStringLiteral(input);
    // Verify the escaped string can be safely embedded in a single-quoted JS literal
    // by checking none of the dangerous raw characters remain
    expect(escaped, 'not to match', /(?<!\\)'/);
    expect(escaped, 'not to contain', '\n');
    expect(escaped, 'not to contain', '\r');
  });
});
