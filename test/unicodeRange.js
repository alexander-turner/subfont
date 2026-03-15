const expect = require('unexpected');
const unicodeRange = require('../lib/unicodeRange');

describe('unicode range', function () {
  // https://github.com/Munter/subfont/issues/106
  it('should compress into a range', function () {
    expect(unicodeRange([0x64, 0x20, 0x62, 0x63]), 'to equal', 'U+20,U+62-64');
  });

  it('should return an empty string for an empty array', function () {
    expect(unicodeRange([]), 'to equal', '');
  });

  it('should return a single code point for a single-element array', function () {
    expect(unicodeRange([0x41]), 'to equal', 'U+41');
  });

  it('should handle duplicate characters in the input array', function () {
    // The function does not deduplicate; duplicates appear as individual entries
    // adjacent to the range they belong to
    expect(unicodeRange([0x41, 0x41, 0x42]), 'to equal', 'U+41,U+41-42');
  });

  it('should handle non-contiguous ranges with multiple gaps', function () {
    expect(
      unicodeRange([0x41, 0x42, 0x43, 0x50, 0x51, 0x60]),
      'to equal',
      'U+41-43,U+50-51,U+60'
    );
  });

  it('should handle the maximum unicode value U+10FFFF', function () {
    expect(unicodeRange([0x10ffff]), 'to equal', 'U+10FFFF');
  });

  it('should handle large unicode values in a range', function () {
    expect(
      unicodeRange([0x10fffe, 0x10ffff]),
      'to equal',
      'U+10FFFE-10FFFF'
    );
  });

  it('should sort unsorted input and produce the same result as sorted input', function () {
    const unsorted = [0x63, 0x61, 0x62];
    const sorted = [0x61, 0x62, 0x63];
    expect(unicodeRange(unsorted), 'to equal', unicodeRange(sorted));
  });

  it('should produce a range for consecutive code points', function () {
    expect(unicodeRange([0x61, 0x62]), 'to equal', 'U+61-62');
  });

  it('should handle a single code point of zero', function () {
    expect(unicodeRange([0x0]), 'to equal', 'U+0');
  });

  it('should handle all isolated code points with no consecutive ranges', function () {
    expect(
      unicodeRange([0x41, 0x43, 0x45]),
      'to equal',
      'U+41,U+43,U+45'
    );
  });
});
