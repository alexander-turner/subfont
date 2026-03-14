const expect = require('unexpected');
const {
  stringifyFontFamily,
  cssQuoteIfNecessary,
  getPreferredFontUrl,
  getCodepoints,
  parseFontWeightRange,
  parseFontStretchRange,
  uniqueChars,
  uniqueCharsFromArray,
  md5HexPrefix,
  cssAssetIsEmpty,
  contentTypeByFontFormat,
  getFontFaceForFontUsage,
  getFontUsageStylesheet,
  getUnusedVariantsStylesheet,
} = require('../lib/fontFaceHelpers');

describe('fontFaceHelpers', function () {
  describe('contentTypeByFontFormat', function () {
    it('should map woff to font/woff', function () {
      expect(contentTypeByFontFormat.woff, 'to equal', 'font/woff');
    });

    it('should map woff2 to font/woff2', function () {
      expect(contentTypeByFontFormat.woff2, 'to equal', 'font/woff2');
    });

    it('should map truetype to font/ttf', function () {
      expect(contentTypeByFontFormat.truetype, 'to equal', 'font/ttf');
    });
  });

  describe('stringifyFontFamily', function () {
    it('should return a simple name as-is', function () {
      expect(stringifyFontFamily('Arial'), 'to equal', 'Arial');
    });

    it('should return a hyphenated name as-is', function () {
      expect(stringifyFontFamily('Open-Sans'), 'to equal', 'Open-Sans');
    });

    it('should escape backslashes in names with special characters', function () {
      expect(
        stringifyFontFamily('font\\name'),
        'to equal',
        'font\\\\name'
      );
    });

    it('should escape double quotes in names with special characters', function () {
      expect(
        stringifyFontFamily('font"name'),
        'to equal',
        'font\\"name'
      );
    });

    it('should handle names with spaces', function () {
      expect(stringifyFontFamily('Open Sans'), 'to equal', 'Open Sans');
    });
  });

  describe('cssQuoteIfNecessary', function () {
    it('should not quote simple word values', function () {
      expect(cssQuoteIfNecessary('normal'), 'to equal', 'normal');
    });

    it('should quote values with spaces', function () {
      expect(cssQuoteIfNecessary('Open Sans'), 'to equal', "'Open Sans'");
    });

    it('should quote values with special characters', function () {
      expect(cssQuoteIfNecessary('font-name!'), 'to equal', "'font-name!'");
    });

    it('should escape single quotes within values', function () {
      expect(cssQuoteIfNecessary("it's"), 'to equal', "'it\\'s'");
    });
  });

  describe('getPreferredFontUrl', function () {
    it('should return undefined for empty relations', function () {
      expect(getPreferredFontUrl([]), 'to be undefined');
    });

    it('should return undefined when called with no arguments', function () {
      expect(getPreferredFontUrl(), 'to be undefined');
    });

    it('should prefer woff2 format', function () {
      const relations = [
        { format: 'woff', to: { url: 'font.woff', type: 'Woff' } },
        { format: 'woff2', to: { url: 'font.woff2', type: 'Woff2' } },
        { format: 'truetype', to: { url: 'font.ttf', type: 'Ttf' } },
      ];
      expect(getPreferredFontUrl(relations), 'to equal', 'font.woff2');
    });

    it('should fall back to woff when woff2 is not available', function () {
      const relations = [
        { format: 'woff', to: { url: 'font.woff', type: 'Woff' } },
        { format: 'truetype', to: { url: 'font.ttf', type: 'Ttf' } },
      ];
      expect(getPreferredFontUrl(relations), 'to equal', 'font.woff');
    });

    it('should fall back to truetype', function () {
      const relations = [
        { format: 'truetype', to: { url: 'font.ttf', type: 'Ttf' } },
      ];
      expect(getPreferredFontUrl(relations), 'to equal', 'font.ttf');
    });

    it('should fall back to asset type matching when no format is specified', function () {
      const relations = [
        { to: { url: 'font.ttf', type: 'Ttf' } },
      ];
      expect(getPreferredFontUrl(relations), 'to equal', 'font.ttf');
    });

    it('should prefer Woff2 type over Woff type when formats are absent', function () {
      const relations = [
        { to: { url: 'font.woff', type: 'Woff' } },
        { to: { url: 'font.woff2', type: 'Woff2' } },
      ];
      expect(getPreferredFontUrl(relations), 'to equal', 'font.woff2');
    });

    it('should handle case-insensitive format matching', function () {
      const relations = [
        { format: 'WOFF2', to: { url: 'font.woff2', type: 'Woff2' } },
      ];
      expect(getPreferredFontUrl(relations), 'to equal', 'font.woff2');
    });
  });

  describe('getCodepoints', function () {
    it('should return codepoints for the given text', function () {
      const codepoints = getCodepoints('ab');
      expect(codepoints, 'to contain', 97, 98);
    });

    it('should add space codepoint when text has no space', function () {
      const codepoints = getCodepoints('abc');
      expect(codepoints, 'to contain', 32);
    });

    it('should not add an extra space when text already has a space', function () {
      const codepoints = getCodepoints('a b');
      const spaceCount = codepoints.filter((cp) => cp === 32).length;
      expect(spaceCount, 'to equal', 1);
    });

    it('should handle emoji (surrogate pairs)', function () {
      const codepoints = getCodepoints('\u{1F600}');
      expect(codepoints, 'to contain', 0x1f600);
    });

    it('should handle empty string by adding space', function () {
      const codepoints = getCodepoints('');
      expect(codepoints, 'to equal', [32]);
    });
  });

  describe('parseFontWeightRange', function () {
    it('should return [-Infinity, Infinity] for undefined', function () {
      expect(parseFontWeightRange(undefined), 'to equal', [-Infinity, Infinity]);
    });

    it('should return [-Infinity, Infinity] for "auto"', function () {
      expect(parseFontWeightRange('auto'), 'to equal', [-Infinity, Infinity]);
    });

    it('should parse a single weight value', function () {
      expect(parseFontWeightRange('700'), 'to equal', [700, 700]);
    });

    it('should parse a weight range', function () {
      expect(parseFontWeightRange('400 700'), 'to equal', [400, 700]);
    });

    it('should default to 400 for non-numeric input', function () {
      expect(parseFontWeightRange('bold'), 'to equal', [400, 400]);
    });
  });

  describe('parseFontStretchRange', function () {
    it('should return [-Infinity, Infinity] for undefined', function () {
      expect(parseFontStretchRange(undefined), 'to equal', [-Infinity, Infinity]);
    });

    it('should return [-Infinity, Infinity] for "auto"', function () {
      expect(parseFontStretchRange('auto'), 'to equal', [-Infinity, Infinity]);
    });

    it('should return [-Infinity, Infinity] for "Auto" (case insensitive)', function () {
      expect(parseFontStretchRange('Auto'), 'to equal', [-Infinity, Infinity]);
    });

    it('should parse a single numeric stretch value', function () {
      expect(parseFontStretchRange('75%'), 'to equal', [75, 75]);
    });

    it('should parse a stretch range', function () {
      expect(parseFontStretchRange('75% 125%'), 'to equal', [75, 125]);
    });
  });

  describe('uniqueChars', function () {
    it('should return unique sorted characters', function () {
      expect(uniqueChars('banana'), 'to equal', 'abn');
    });

    it('should handle empty string', function () {
      expect(uniqueChars(''), 'to equal', '');
    });

    it('should handle already unique chars', function () {
      expect(uniqueChars('abc'), 'to equal', 'abc');
    });
  });

  describe('uniqueCharsFromArray', function () {
    it('should return unique sorted characters from multiple strings', function () {
      expect(uniqueCharsFromArray(['abc', 'cde']), 'to equal', 'abcde');
    });

    it('should handle empty array', function () {
      expect(uniqueCharsFromArray([]), 'to equal', '');
    });

    it('should handle array with empty strings', function () {
      expect(uniqueCharsFromArray(['', '']), 'to equal', '');
    });
  });

  describe('md5HexPrefix', function () {
    it('should return a 10-character hex string', function () {
      const result = md5HexPrefix('hello');
      expect(result, 'to match', /^[a-f0-9]{10}$/);
    });

    it('should produce consistent results for the same input', function () {
      expect(md5HexPrefix('test'), 'to equal', md5HexPrefix('test'));
    });

    it('should produce different results for different inputs', function () {
      expect(md5HexPrefix('a'), 'not to equal', md5HexPrefix('b'));
    });

    it('should accept a Buffer', function () {
      const result = md5HexPrefix(Buffer.from('hello'));
      expect(result, 'to match', /^[a-f0-9]{10}$/);
    });
  });

  describe('cssAssetIsEmpty', function () {
    it('should return true for a CSS asset with only non-important comments', function () {
      const cssAsset = {
        parseTree: {
          nodes: [{ type: 'comment', text: 'just a comment' }],
        },
      };
      expect(cssAssetIsEmpty(cssAsset), 'to be true');
    });

    it('should return false for a CSS asset with important comments', function () {
      const cssAsset = {
        parseTree: {
          nodes: [{ type: 'comment', text: '! keep this' }],
        },
      };
      expect(cssAssetIsEmpty(cssAsset), 'to be false');
    });

    it('should return false for a CSS asset with rules', function () {
      const cssAsset = {
        parseTree: {
          nodes: [{ type: 'rule' }],
        },
      };
      expect(cssAssetIsEmpty(cssAsset), 'to be false');
    });

    it('should return true for a CSS asset with no nodes', function () {
      const cssAsset = {
        parseTree: { nodes: [] },
      };
      expect(cssAssetIsEmpty(cssAsset), 'to be true');
    });
  });

  describe('getFontFaceForFontUsage', function () {
    it('should generate a @font-face declaration with subset data', function () {
      const fontUsage = {
        props: {
          'font-family': 'Open Sans',
          'font-style': 'normal',
          'font-weight': '400',
          src: 'url(original.woff2)',
        },
        subsets: {
          woff2: Buffer.from('fake-woff2-data'),
        },
        codepoints: {
          used: [65, 66, 67],
        },
      };
      const result = getFontFaceForFontUsage(fontUsage);
      expect(result, 'to contain', '@font-face {');
      expect(result, 'to contain', "__subset");
      expect(result, 'to contain', 'unicode-range:');
      expect(result, 'to contain', "format('woff2')");
      expect(result, 'to contain', 'data:font/woff2;base64,');
    });
  });

  describe('getFontUsageStylesheet', function () {
    it('should combine multiple font usages into a stylesheet', function () {
      const fontUsages = [
        {
          props: {
            'font-family': 'Arial',
            'font-style': 'normal',
            'font-weight': '400',
            src: 'url(a.woff2)',
          },
          subsets: { woff2: Buffer.from('data1') },
          codepoints: { used: [65] },
        },
        {
          props: {
            'font-family': 'Arial',
            'font-style': 'italic',
            'font-weight': '400',
            src: 'url(b.woff2)',
          },
          subsets: { woff2: Buffer.from('data2') },
          codepoints: { used: [66] },
        },
      ];
      const result = getFontUsageStylesheet(fontUsages);
      expect(result, 'to contain', '@font-face {');
      // Should have two @font-face blocks
      const matches = result.match(/@font-face/g);
      expect(matches.length, 'to equal', 2);
    });

    it('should skip font usages without subsets', function () {
      const fontUsages = [
        {
          props: { 'font-family': 'Arial', src: 'url(a.woff2)' },
          codepoints: { used: [65] },
        },
      ];
      const result = getFontUsageStylesheet(fontUsages);
      expect(result, 'to equal', '');
    });
  });

  describe('getUnusedVariantsStylesheet', function () {
    it('should return empty string when all variants are used', function () {
      const fontUsages = [
        {
          fontFamilies: new Set(['Arial']),
          props: {
            'font-family': 'arial',
            'font-style': 'normal',
            'font-weight': '400',
            'font-stretch': 'normal',
          },
        },
      ];
      const declarations = [
        {
          'font-family': 'Arial',
          'font-style': 'normal',
          'font-weight': '400',
          'font-stretch': 'normal',
          src: "url('font.woff2') format('woff2')",
          relations: [],
        },
      ];
      const result = getUnusedVariantsStylesheet(fontUsages, declarations);
      expect(result, 'to equal', '');
    });

    it('should include unused variants for used font families', function () {
      const fontUsages = [
        {
          fontFamilies: new Set(['Arial']),
          props: {
            'font-family': 'arial',
            'font-style': 'normal',
            'font-weight': '400',
            'font-stretch': 'normal',
          },
        },
      ];
      const declarations = [
        {
          'font-family': 'Arial',
          'font-style': 'italic',
          'font-weight': '700',
          'font-stretch': 'normal',
          src: "url('font-bold-italic.woff2') format('woff2')",
          relations: [],
        },
      ];
      const result = getUnusedVariantsStylesheet(fontUsages, declarations);
      expect(result, 'to contain', 'Arial__subset');
      expect(result, 'to contain', 'font-weight:700');
      expect(result, 'to contain', 'font-style:italic');
    });

    it('should not include variants for unused font families', function () {
      const fontUsages = [
        {
          fontFamilies: new Set(['Helvetica']),
          props: {
            'font-family': 'helvetica',
            'font-style': 'normal',
            'font-weight': '400',
            'font-stretch': 'normal',
          },
        },
      ];
      const declarations = [
        {
          'font-family': 'Arial',
          'font-style': 'normal',
          'font-weight': '400',
          'font-stretch': 'normal',
          src: "url('arial.woff2')",
          relations: [],
        },
      ];
      const result = getUnusedVariantsStylesheet(fontUsages, declarations);
      expect(result, 'to equal', '');
    });
  });
});
