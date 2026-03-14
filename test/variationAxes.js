const expect = require('unexpected');
const {
  renderNumberRange,
  getVariationAxisUsage,
} = require('../lib/variationAxes');
const {
  parseFontWeightRange,
  parseFontStretchRange,
} = require('../lib/fontFaceHelpers');

describe('variationAxes', function () {
  describe('renderNumberRange', function () {
    it('should render a single number when min equals max', function () {
      expect(renderNumberRange(400, 400), 'to equal', '400');
    });

    it('should render a range when min differs from max', function () {
      expect(renderNumberRange(100, 900), 'to equal', '100-900');
    });

    it('should handle zero', function () {
      expect(renderNumberRange(0, 0), 'to equal', '0');
    });

    it('should handle negative numbers', function () {
      expect(renderNumberRange(-14, 0), 'to equal', '-14-0');
    });
  });

  describe('getVariationAxisUsage', function () {
    function makeFontUsage(overrides = {}) {
      return {
        fontUrl: 'https://example.com/font.woff2',
        fontStyles: new Set(['normal']),
        fontWeights: new Set([400]),
        fontStretches: new Set([100]),
        fontVariationSettings: new Set(['normal']),
        hasOutOfBoundsAnimationTimingFunction: false,
        props: {
          'font-weight': '100 900',
          'font-stretch': '75% 125%',
        },
        ...overrides,
      };
    }

    it('should return empty maps for empty fontUsages', function () {
      const result = getVariationAxisUsage(
        [],
        parseFontWeightRange,
        parseFontStretchRange
      );
      expect(result.seenAxisValuesByFontUrlAndAxisName.size, 'to equal', 0);
      expect(result.outOfBoundsAxesByFontUrl.size, 'to equal', 0);
    });

    it('should track multiple distinct fontUrls independently', function () {
      const usage1 = makeFontUsage({
        fontUrl: 'https://example.com/font1.woff2',
        fontWeights: new Set([400]),
        props: { 'font-weight': '100 900', 'font-stretch': '100%' },
      });
      const usage2 = makeFontUsage({
        fontUrl: 'https://example.com/font2.woff2',
        fontWeights: new Set([700]),
        props: { 'font-weight': '100 900', 'font-stretch': '100%' },
      });
      const result = getVariationAxisUsage(
        [{ fontUsages: [usage1, usage2] }],
        parseFontWeightRange,
        parseFontStretchRange
      );
      const axes1 = result.seenAxisValuesByFontUrlAndAxisName.get(
        'https://example.com/font1.woff2'
      );
      const axes2 = result.seenAxisValuesByFontUrlAndAxisName.get(
        'https://example.com/font2.woff2'
      );
      expect(axes1.get('wght').has(400), 'to be true');
      expect(axes1.get('wght').has(700), 'to be false');
      expect(axes2.get('wght').has(700), 'to be true');
      expect(axes2.get('wght').has(400), 'to be false');
    });

    it('should record ital=0 for normal font-style', function () {
      const result = getVariationAxisUsage(
        [{ fontUsages: [makeFontUsage({ fontStyles: new Set(['normal']) })] }],
        parseFontWeightRange,
        parseFontStretchRange
      );
      const axes = result.seenAxisValuesByFontUrlAndAxisName.get(
        'https://example.com/font.woff2'
      );
      expect(axes.get('ital').has(0), 'to be true');
    });

    it('should record ital=1 for italic font-style', function () {
      const result = getVariationAxisUsage(
        [{ fontUsages: [makeFontUsage({ fontStyles: new Set(['italic']) })] }],
        parseFontWeightRange,
        parseFontStretchRange
      );
      const axes = result.seenAxisValuesByFontUrlAndAxisName.get(
        'https://example.com/font.woff2'
      );
      expect(axes.get('ital').has(1), 'to be true');
    });

    it('should record both ital=0 and ital=1 for normal+italic', function () {
      const result = getVariationAxisUsage(
        [
          {
            fontUsages: [
              makeFontUsage({
                fontStyles: new Set(['normal', 'italic']),
              }),
            ],
          },
        ],
        parseFontWeightRange,
        parseFontStretchRange
      );
      const axes = result.seenAxisValuesByFontUrlAndAxisName.get(
        'https://example.com/font.woff2'
      );
      expect(axes.get('ital').has(0), 'to be true');
      expect(axes.get('ital').has(1), 'to be true');
    });

    it('should record slnt=-14 for oblique font-style', function () {
      const result = getVariationAxisUsage(
        [{ fontUsages: [makeFontUsage({ fontStyles: new Set(['oblique']) })] }],
        parseFontWeightRange,
        parseFontStretchRange
      );
      const axes = result.seenAxisValuesByFontUrlAndAxisName.get(
        'https://example.com/font.woff2'
      );
      expect(axes.get('slnt').has(-14), 'to be true');
    });

    it('should record slnt=0 for normal font-style', function () {
      const result = getVariationAxisUsage(
        [{ fontUsages: [makeFontUsage({ fontStyles: new Set(['normal']) })] }],
        parseFontWeightRange,
        parseFontStretchRange
      );
      const axes = result.seenAxisValuesByFontUrlAndAxisName.get(
        'https://example.com/font.woff2'
      );
      expect(axes.get('slnt').has(0), 'to be true');
    });

    it('should record font weight values clamped to the range', function () {
      const result = getVariationAxisUsage(
        [
          {
            fontUsages: [
              makeFontUsage({
                fontWeights: new Set([700]),
                props: { 'font-weight': '400 700', 'font-stretch': '100%' },
              }),
            ],
          },
        ],
        parseFontWeightRange,
        parseFontStretchRange
      );
      const axes = result.seenAxisValuesByFontUrlAndAxisName.get(
        'https://example.com/font.woff2'
      );
      expect(axes.get('wght').has(700), 'to be true');
    });

    it('should clamp font weight values to the declared range', function () {
      const result = getVariationAxisUsage(
        [
          {
            fontUsages: [
              makeFontUsage({
                fontWeights: new Set([900]),
                props: { 'font-weight': '400 700', 'font-stretch': '100%' },
              }),
            ],
          },
        ],
        parseFontWeightRange,
        parseFontStretchRange
      );
      const axes = result.seenAxisValuesByFontUrlAndAxisName.get(
        'https://example.com/font.woff2'
      );
      expect(axes.get('wght').has(700), 'to be true');
      expect(axes.get('wght').has(900), 'to be false');
    });

    it('should record font stretch values', function () {
      const result = getVariationAxisUsage(
        [
          {
            fontUsages: [
              makeFontUsage({
                fontStretches: new Set([75]),
                props: { 'font-weight': '400', 'font-stretch': '75% 125%' },
              }),
            ],
          },
        ],
        parseFontWeightRange,
        parseFontStretchRange
      );
      const axes = result.seenAxisValuesByFontUrlAndAxisName.get(
        'https://example.com/font.woff2'
      );
      expect(axes.get('wdth').has(75), 'to be true');
    });

    it('should parse font-variation-settings and record axis values', function () {
      const result = getVariationAxisUsage(
        [
          {
            fontUsages: [
              makeFontUsage({
                fontVariationSettings: new Set(['"wght" 600']),
              }),
            ],
          },
        ],
        parseFontWeightRange,
        parseFontStretchRange
      );
      const axes = result.seenAxisValuesByFontUrlAndAxisName.get(
        'https://example.com/font.woff2'
      );
      expect(axes.get('wght').has(600), 'to be true');
    });

    it('should track out-of-bounds axes when hasOutOfBoundsAnimationTimingFunction is true', function () {
      const result = getVariationAxisUsage(
        [
          {
            fontUsages: [
              makeFontUsage({
                fontVariationSettings: new Set(['"CUST" 100']),
                hasOutOfBoundsAnimationTimingFunction: true,
              }),
            ],
          },
        ],
        parseFontWeightRange,
        parseFontStretchRange
      );
      const outOfBounds = result.outOfBoundsAxesByFontUrl.get(
        'https://example.com/font.woff2'
      );
      expect(outOfBounds.has('CUST'), 'to be true');
    });

    it('should not track out-of-bounds axes when hasOutOfBoundsAnimationTimingFunction is false', function () {
      const result = getVariationAxisUsage(
        [
          {
            fontUsages: [
              makeFontUsage({
                fontVariationSettings: new Set(['"CUST" 100']),
                hasOutOfBoundsAnimationTimingFunction: false,
              }),
            ],
          },
        ],
        parseFontWeightRange,
        parseFontStretchRange
      );
      const outOfBounds = result.outOfBoundsAxesByFontUrl.get(
        'https://example.com/font.woff2'
      );
      expect(outOfBounds, 'to be undefined');
    });

    it('should deduplicate fontUrls across multiple pages', function () {
      const fontUsage1 = makeFontUsage({ fontWeights: new Set([400]) });
      const fontUsage2 = makeFontUsage({ fontWeights: new Set([700]) });
      // Same fontUrl appears in two "pages"
      const result = getVariationAxisUsage(
        [{ fontUsages: [fontUsage1] }, { fontUsages: [fontUsage2] }],
        parseFontWeightRange,
        parseFontStretchRange
      );
      const axes = result.seenAxisValuesByFontUrlAndAxisName.get(
        'https://example.com/font.woff2'
      );
      // Only the first page's values should be recorded (dedup by fontUrl)
      expect(axes.get('wght').has(400), 'to be true');
    });
  });
});
