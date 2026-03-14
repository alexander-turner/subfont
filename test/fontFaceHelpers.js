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
  getFontFaceForFontUsage,
  getFontUsageStylesheet,
  getUnusedVariantsStylesheet,
} = require('../lib/fontFaceHelpers');

describe('fontFaceHelpers', function () {
  describe('stringifyFontFamily', function () {
    [
      { input: 'Arial', expected: 'Arial', desc: 'simple name' },
      { input: 'Open-Sans', expected: 'Open-Sans', desc: 'hyphenated name' },
      { input: 'font\\name', expected: '"font\\\\name"', desc: 'name with backslash' },
      { input: 'font"name', expected: '"font\\"name"', desc: 'name with double quote' },
      { input: 'Open Sans', expected: '"Open Sans"', desc: 'name with space' },
    ].forEach(({ input, expected, desc }) => {
      it(`should handle ${desc}: ${JSON.stringify(input)}`, function () {
        expect(stringifyFontFamily(input), 'to equal', expected);
      });
    });
  });

  describe('cssQuoteIfNecessary', function () {
    [
      { input: 'normal', expected: 'normal', desc: 'simple word' },
      { input: 'Open Sans', expected: "'Open Sans'", desc: 'value with space' },
      { input: 'font-name!', expected: "'font-name!'", desc: 'value with special char' },
      { input: "it's", expected: "'it\\'s'", desc: 'value with single quote' },
    ].forEach(({ input, expected, desc }) => {
      it(`should handle ${desc}: ${JSON.stringify(input)}`, function () {
        expect(cssQuoteIfNecessary(input), 'to equal', expected);
      });
    });
  });

  describe('getPreferredFontUrl', function () {
    [
      { relations: [], expected: undefined, desc: 'empty relations' },
      { relations: undefined, expected: undefined, desc: 'no arguments' },
    ].forEach(({ relations, expected, desc }) => {
      it(`should return undefined for ${desc}`, function () {
        expect(getPreferredFontUrl(relations), 'to equal', expected);
      });
    });

    [
      {
        desc: 'woff2 over woff and truetype by format',
        relations: [
          { format: 'woff', to: { url: 'font.woff', type: 'Woff' } },
          { format: 'woff2', to: { url: 'font.woff2', type: 'Woff2' } },
          { format: 'truetype', to: { url: 'font.ttf', type: 'Ttf' } },
        ],
        expected: 'font.woff2',
      },
      {
        desc: 'woff when woff2 is unavailable',
        relations: [
          { format: 'woff', to: { url: 'font.woff', type: 'Woff' } },
          { format: 'truetype', to: { url: 'font.ttf', type: 'Ttf' } },
        ],
        expected: 'font.woff',
      },
      {
        desc: 'truetype as last format fallback',
        relations: [
          { format: 'truetype', to: { url: 'font.ttf', type: 'Ttf' } },
        ],
        expected: 'font.ttf',
      },
      {
        desc: 'asset type when no format is specified',
        relations: [{ to: { url: 'font.ttf', type: 'Ttf' } }],
        expected: 'font.ttf',
      },
      {
        desc: 'Woff2 type over Woff type when formats are absent',
        relations: [
          { to: { url: 'font.woff', type: 'Woff' } },
          { to: { url: 'font.woff2', type: 'Woff2' } },
        ],
        expected: 'font.woff2',
      },
      {
        desc: 'case-insensitive format matching',
        relations: [
          { format: 'WOFF2', to: { url: 'font.woff2', type: 'Woff2' } },
        ],
        expected: 'font.woff2',
      },
    ].forEach(({ desc, relations, expected }) => {
      it(`should prefer ${desc}`, function () {
        expect(getPreferredFontUrl(relations), 'to equal', expected);
      });
    });
  });

  describe('getCodepoints', function () {
    it('should return codepoints for the given text', function () {
      const codepoints = getCodepoints('ab');
      expect(codepoints, 'to contain', 97, 98);
    });

    it('should add space codepoint when text has no space', function () {
      expect(getCodepoints('abc'), 'to contain', 32);
    });

    it('should not add an extra space when text already has a space', function () {
      const spaceCount = getCodepoints('a b').filter((cp) => cp === 32).length;
      expect(spaceCount, 'to equal', 1);
    });

    it('should handle emoji (surrogate pairs)', function () {
      expect(getCodepoints('\u{1F600}'), 'to contain', 0x1f600);
    });

    it('should handle empty string by adding space', function () {
      expect(getCodepoints(''), 'to equal', [32]);
    });
  });

  describe('parseFontWeightRange', function () {
    [
      { input: undefined, expected: [-Infinity, Infinity], desc: 'undefined' },
      { input: 'auto', expected: [-Infinity, Infinity], desc: '"auto"' },
      { input: '700', expected: [700, 700], desc: 'single value' },
      { input: '400 700', expected: [400, 700], desc: 'range' },
      { input: 'bold', expected: [400, 400], desc: 'non-numeric (defaults to 400)' },
    ].forEach(({ input, expected, desc }) => {
      it(`should parse ${desc}`, function () {
        expect(parseFontWeightRange(input), 'to equal', expected);
      });
    });
  });

  describe('parseFontStretchRange', function () {
    [
      { input: undefined, expected: [-Infinity, Infinity], desc: 'undefined' },
      { input: 'auto', expected: [-Infinity, Infinity], desc: '"auto"' },
      { input: 'Auto', expected: [-Infinity, Infinity], desc: '"Auto" (case insensitive)' },
      { input: '75%', expected: [75, 75], desc: 'single value' },
      { input: '75% 125%', expected: [75, 125], desc: 'range' },
    ].forEach(({ input, expected, desc }) => {
      it(`should parse ${desc}`, function () {
        expect(parseFontStretchRange(input), 'to equal', expected);
      });
    });
  });

  describe('uniqueChars', function () {
    [
      { input: 'banana', expected: 'abn', desc: 'duplicates' },
      { input: '', expected: '', desc: 'empty string' },
      { input: 'abc', expected: 'abc', desc: 'already unique' },
    ].forEach(({ input, expected, desc }) => {
      it(`should handle ${desc}: ${JSON.stringify(input)}`, function () {
        expect(uniqueChars(input), 'to equal', expected);
      });
    });
  });

  describe('uniqueCharsFromArray', function () {
    [
      { input: ['abc', 'cde'], expected: 'abcde', desc: 'overlapping strings' },
      { input: [], expected: '', desc: 'empty array' },
      { input: ['', ''], expected: '', desc: 'array of empty strings' },
    ].forEach(({ input, expected, desc }) => {
      it(`should handle ${desc}`, function () {
        expect(uniqueCharsFromArray(input), 'to equal', expected);
      });
    });
  });

  describe('md5HexPrefix', function () {
    ['hello', 'test', 'subfont'].forEach((input) => {
      it(`should return a 10-char hex string for ${JSON.stringify(input)}`, function () {
        expect(md5HexPrefix(input), 'to match', /^[a-f0-9]{10}$/);
      });
    });

    it('should produce consistent results for the same input', function () {
      expect(md5HexPrefix('test'), 'to equal', md5HexPrefix('test'));
    });

    it('should produce different results for different inputs', function () {
      expect(md5HexPrefix('a'), 'not to equal', md5HexPrefix('b'));
    });

    it('should accept a Buffer', function () {
      expect(md5HexPrefix(Buffer.from('hello')), 'to match', /^[a-f0-9]{10}$/);
    });
  });

  describe('cssAssetIsEmpty', function () {
    [
      {
        desc: 'only non-important comments',
        nodes: [{ type: 'comment', text: 'just a comment' }],
        expected: true,
      },
      {
        desc: 'important comment (! prefix)',
        nodes: [{ type: 'comment', text: '! keep this' }],
        expected: false,
      },
      {
        desc: 'a rule node',
        nodes: [{ type: 'rule' }],
        expected: false,
      },
      {
        desc: 'no nodes at all',
        nodes: [],
        expected: true,
      },
    ].forEach(({ desc, nodes, expected }) => {
      it(`should return ${expected} for ${desc}`, function () {
        expect(cssAssetIsEmpty({ parseTree: { nodes } }), 'to equal', expected);
      });
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

      ['@font-face {', '__subset', 'unicode-range:', "format('woff2')", 'data:font/woff2;base64,'].forEach((expected) => {
        expect(result, 'to contain', expected);
      });
    });

    it('should include multiple formats in order woff2, woff, truetype', function () {
      const fontUsage = {
        props: {
          'font-family': 'Test',
          src: 'url(original.woff2)',
        },
        subsets: {
          woff2: Buffer.from('w2'),
          woff: Buffer.from('w1'),
          truetype: Buffer.from('tt'),
        },
        codepoints: { used: [65] },
      };
      const result = getFontFaceForFontUsage(fontUsage);
      const woff2Pos = result.indexOf("format('woff2')");
      const woffPos = result.indexOf("format('woff')");
      const ttPos = result.indexOf("format('truetype')");
      expect(woff2Pos, 'to be less than', woffPos);
      expect(woffPos, 'to be less than', ttPos);
    });

    it('should produce correct unicode-range for given codepoints', function () {
      const fontUsage = {
        props: {
          'font-family': 'Test',
          src: 'url(x)',
        },
        subsets: { woff2: Buffer.from('data') },
        codepoints: { used: [0x41, 0x42, 0x43] },
      };
      expect(getFontFaceForFontUsage(fontUsage), 'to contain', 'U+41-43');
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
      expect(getFontUsageStylesheet(fontUsages), 'to equal', '');
    });
  });

  describe('getUnusedVariantsStylesheet', function () {
    function makeFontUsage(family, style, weight) {
      return {
        fontFamilies: new Set([family]),
        props: {
          'font-family': family.toLowerCase(),
          'font-style': style,
          'font-weight': weight,
          'font-stretch': 'normal',
        },
      };
    }

    function makeDeclaration(family, style, weight, opts = {}) {
      return {
        'font-family': family,
        'font-style': style,
        'font-weight': weight,
        'font-stretch': 'normal',
        src: opts.src || "url('font.woff2') format('woff2')",
        relations: opts.relations || [],
      };
    }

    it('should return empty string when all variants are used', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [makeDeclaration('Arial', 'normal', '400')]
      );
      expect(result, 'to equal', '');
    });

    it('should include unused variants for used font families', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [makeDeclaration('Arial', 'italic', '700')]
      );
      ['Arial__subset', 'font-weight:700', 'font-style:italic'].forEach((s) => {
        expect(result, 'to contain', s);
      });
    });

    it('should rewrite URLs from relations when present', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Arial', 'normal', '400')],
        [
          makeDeclaration('Arial', 'italic', '700', {
            src: "url('old.woff2') format('woff2')",
            relations: [
              {
                to: { url: 'https://cdn.example.com/new-font.woff2' },
                tokenRegExp: /url\([^)]+\)/g,
              },
            ],
          }),
        ]
      );
      expect(result, 'to contain', 'https://cdn.example.com/new-font.woff2');
    });

    it('should not include variants for unused font families', function () {
      const result = getUnusedVariantsStylesheet(
        [makeFontUsage('Helvetica', 'normal', '400')],
        [makeDeclaration('Arial', 'normal', '400')]
      );
      expect(result, 'to equal', '');
    });
  });
});
