const expect = require('unexpected');
const proxyquire = require('proxyquire');
const {
  renderNumberRange,
  parseFontSizePx,
  getVariationAxisUsage,
} = require('../lib/variationAxes');
const {
  parseFontWeightRange,
  parseFontStretchRange,
} = require('../lib/fontFaceHelpers');

describe('variationAxes', function () {
  describe('renderNumberRange', function () {
    [
      { min: 400, max: 400, expected: '400', desc: 'single value' },
      { min: 100, max: 900, expected: '100-900', desc: 'range' },
      { min: 0, max: 0, expected: '0', desc: 'zero' },
      { min: -14, max: 0, expected: '-14-0', desc: 'negative to zero' },
    ].forEach(({ min, max, expected, desc }) => {
      it(`should render ${desc}: ${expected}`, function () {
        expect(renderNumberRange(min, max), 'to equal', expected);
      });
    });
  });

  describe('parseFontSizePx', function () {
    [
      { input: '16px', expected: 16, desc: 'px value' },
      { input: '12pt', expected: 16, desc: 'pt value (12pt = 16px)' },
      { input: '24px', expected: 24, desc: 'larger px value' },
      { input: '9pt', expected: 12, desc: 'pt value (9pt = 12px)' },
      { input: 14, expected: 14, desc: 'numeric value' },
      { input: '0px', expected: NaN, desc: 'zero px' },
      { input: '1.5em', expected: NaN, desc: 'em unit (relative)' },
      { input: '2rem', expected: NaN, desc: 'rem unit (relative)' },
      { input: '80%', expected: NaN, desc: 'percentage (relative)' },
      { input: '10vw', expected: NaN, desc: 'viewport unit' },
      { input: undefined, expected: NaN, desc: 'undefined' },
      { input: null, expected: NaN, desc: 'null' },
      { input: '', expected: NaN, desc: 'empty string' },
      { input: 'large', expected: NaN, desc: 'keyword' },
    ].forEach(({ input, expected, desc }) => {
      it(`should return ${expected} for ${desc}: ${JSON.stringify(input)}`, function () {
        const result = parseFontSizePx(input);
        if (Number.isNaN(expected)) {
          expect(Number.isNaN(result), 'to be true');
        } else {
          expect(result, 'to equal', expected);
        }
      });
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

    function runUsage(fontUsages) {
      return getVariationAxisUsage(
        [{ fontUsages }],
        parseFontWeightRange,
        parseFontStretchRange
      );
    }

    function getAxes(result, fontUrl) {
      return result.seenAxisValuesByFontUrlAndAxisName.get(
        fontUrl || 'https://example.com/font.woff2'
      );
    }

    it('should return empty maps for empty fontUsages', function () {
      const result = getVariationAxisUsage(
        [],
        parseFontWeightRange,
        parseFontStretchRange
      );
      expect(result.seenAxisValuesByFontUrlAndAxisName.size, 'to equal', 0);
    });

    describe('font-style to ital/slnt axis mapping', function () {
      [
        {
          fontStyles: ['normal'],
          axis: 'ital',
          expectedValues: [0],
          desc: 'normal -> ital=0',
        },
        {
          fontStyles: ['italic'],
          axis: 'ital',
          expectedValues: [1],
          desc: 'italic -> ital=1',
        },
        {
          fontStyles: ['normal', 'italic'],
          axis: 'ital',
          expectedValues: [0, 1],
          desc: 'normal+italic -> ital=0,1',
        },
        {
          fontStyles: ['oblique'],
          axis: 'slnt',
          expectedValues: [-14],
          desc: 'oblique -> slnt=-14',
        },
        {
          fontStyles: ['normal'],
          axis: 'slnt',
          expectedValues: [0],
          desc: 'normal -> slnt=0',
        },
        {
          fontStyles: ['normal', 'oblique'],
          axis: 'slnt',
          expectedValues: [0, -14],
          desc: 'normal+oblique -> slnt=0,-14',
        },
      ].forEach(({ fontStyles, axis, expectedValues, desc }) => {
        it(`should record ${desc}`, function () {
          const result = runUsage([
            makeFontUsage({ fontStyles: new Set(fontStyles) }),
          ]);
          const axes = getAxes(result);
          expectedValues.forEach((val) => {
            expect(axes.get(axis).has(val), 'to be true');
          });
        });
      });
    });

    describe('font-weight to wght axis mapping', function () {
      [
        {
          weight: 700,
          range: '400 700',
          expectedPresent: [700],
          expectedAbsent: [],
          desc: 'in-range value',
        },
        {
          weight: 900,
          range: '400 700',
          expectedPresent: [700],
          expectedAbsent: [900],
          desc: 'out-of-range value clamped to max',
        },
        {
          weight: 100,
          range: '400 700',
          expectedPresent: [400],
          expectedAbsent: [100],
          desc: 'below-range value clamped to min',
        },
      ].forEach(({ weight, range, expectedPresent, expectedAbsent, desc }) => {
        it(`should handle ${desc}`, function () {
          const result = runUsage([
            makeFontUsage({
              fontWeights: new Set([weight]),
              props: { 'font-weight': range, 'font-stretch': '100%' },
            }),
          ]);
          const axes = getAxes(result);
          expectedPresent.forEach((val) => {
            expect(axes.get('wght').has(val), 'to be true');
          });
          expectedAbsent.forEach((val) => {
            expect(axes.get('wght').has(val), 'to be false');
          });
        });
      });
    });

    it('should record font stretch values as wdth axis', function () {
      const result = runUsage([
        makeFontUsage({
          fontStretches: new Set([75]),
          props: { 'font-weight': '400', 'font-stretch': '75% 125%' },
        }),
      ]);
      expect(getAxes(result).get('wdth').has(75), 'to be true');
    });

    it('should parse font-variation-settings and record axis values', function () {
      const result = runUsage([
        makeFontUsage({
          fontVariationSettings: new Set(['"wght" 600']),
        }),
      ]);
      expect(getAxes(result).get('wght').has(600), 'to be true');
    });

    it('should track multiple distinct fontUrls independently', function () {
      const result = runUsage([
        makeFontUsage({
          fontUrl: 'https://example.com/font1.woff2',
          fontWeights: new Set([400]),
          props: { 'font-weight': '100 900', 'font-stretch': '100%' },
        }),
        makeFontUsage({
          fontUrl: 'https://example.com/font2.woff2',
          fontWeights: new Set([700]),
          props: { 'font-weight': '100 900', 'font-stretch': '100%' },
        }),
      ]);

      [
        { url: 'https://example.com/font1.woff2', present: 400, absent: 700 },
        { url: 'https://example.com/font2.woff2', present: 700, absent: 400 },
      ].forEach(({ url, present, absent }) => {
        const axes = getAxes(result, url);
        expect(axes.get('wght').has(present), 'to be true');
        expect(axes.get('wght').has(absent), 'to be false');
      });
    });

    describe('font-size to opsz axis mapping', function () {
      it('should map px font-size values to opsz axis', function () {
        const result = runUsage([
          makeFontUsage({
            fontSizes: new Set(['16px', '24px']),
          }),
        ]);
        const axes = getAxes(result);
        expect(axes.get('opsz').has(16), 'to be true');
        expect(axes.get('opsz').has(24), 'to be true');
      });

      it('should map pt font-size values to opsz axis in px', function () {
        const result = runUsage([
          makeFontUsage({
            fontSizes: new Set(['12pt']),
          }),
        ]);
        const axes = getAxes(result);
        // 12pt = 16px
        expect(axes.get('opsz').has(16), 'to be true');
      });

      it('should skip relative font-size units', function () {
        const result = runUsage([
          makeFontUsage({
            fontSizes: new Set(['1.5em', '2rem', '80%']),
          }),
        ]);
        const axes = getAxes(result);
        expect(axes.has('opsz'), 'to be false');
      });

      it('should not set opsz when fontSizes is undefined', function () {
        const result = runUsage([makeFontUsage()]);
        const axes = getAxes(result);
        expect(axes.has('opsz'), 'to be false');
      });
    });

    it('should deduplicate fontUrls across multiple pages', function () {
      const result = getVariationAxisUsage(
        [
          { fontUsages: [makeFontUsage({ fontWeights: new Set([400]) })] },
          { fontUsages: [makeFontUsage({ fontWeights: new Set([700]) })] },
        ],
        parseFontWeightRange,
        parseFontStretchRange
      );
      // Only the first page's values should be recorded (dedup by fontUrl)
      expect(getAxes(result).get('wght').has(400), 'to be true');
    });
  });

  describe('getVariationAxisBounds', function () {
    // Use proxyquire to mock getFontInfo so we don't need real font files
    const { getVariationAxisBounds } = proxyquire('../lib/variationAxes', {
      './getFontInfo': async function mockGetFontInfo() {
        return {
          variationAxes: {
            wght: { min: 100, max: 900, default: 400 },
            wdth: { min: 75, max: 125, default: 100 },
          },
        };
      },
    });

    function makeSeenAxes(entries) {
      const map = new Map();
      for (const [axisName, values] of entries) {
        map.set(axisName, new Set(values));
      }
      const outer = new Map();
      outer.set('font://test', map);
      return outer;
    }

    it('should narrow axis min to the highest of seen min and axis min', async function () {
      // Seen values: wght 400 and 700, font range 100-900
      // min = max(400, 100) = 400, max = min(700, 900) = 700
      const fontAssetsByUrl = new Map();
      fontAssetsByUrl.set('font://test', { rawSrc: Buffer.from('mock') });

      const result = await getVariationAxisBounds(
        fontAssetsByUrl,
        'font://test',
        makeSeenAxes([['wght', [400, 700]]])
      );

      expect(result.variationAxes.wght.min, 'to equal', 400);
      expect(result.variationAxes.wght.max, 'to equal', 700);
      // wght is reduced (400>100 || 700<900); wdth is pinned to default
      expect(result.numAxesReduced, 'to equal', 1);
      expect(result.fullyInstanced, 'to be false');
    });

    it('should clamp to axis min when seen min is below axis min', async function () {
      // Seen values: wght 50 and 500, font range 100-900
      // min = max(50, 100) = 100, max = min(500, 900) = 500
      const fontAssetsByUrl = new Map();
      fontAssetsByUrl.set('font://test', { rawSrc: Buffer.from('mock') });

      const result = await getVariationAxisBounds(
        fontAssetsByUrl,
        'font://test',
        makeSeenAxes([['wght', [50, 500]]])
      );

      expect(result.variationAxes.wght.min, 'to equal', 100);
      expect(result.variationAxes.wght.max, 'to equal', 500);
    });

    it('should pin axis when only one value is seen', async function () {
      const fontAssetsByUrl = new Map();
      fontAssetsByUrl.set('font://test', { rawSrc: Buffer.from('mock') });

      const result = await getVariationAxisBounds(
        fontAssetsByUrl,
        'font://test',
        makeSeenAxes([['wght', [400]]])
      );

      // Single value should be pinned (scalar, not range)
      expect(result.variationAxes.wght, 'to equal', 400);
      // Both wght and wdth are pinned (wdth defaults to single value)
      expect(result.numAxesPinned, 'to be greater than or equal to', 1);
      expect(result.fullyInstanced, 'to be true');
    });

    describe('opsz axis handling', function () {
      const { getVariationAxisBounds: getVariationAxisBoundsWithOpsz } =
        proxyquire('../lib/variationAxes', {
          './getFontInfo': async function mockGetFontInfo() {
            return {
              variationAxes: {
                wght: { min: 100, max: 900, default: 400 },
                opsz: { min: 8, max: 144, default: 14 },
              },
            };
          },
        });

      it('should pin opsz to default when no explicit values are seen', async function () {
        const fontAssetsByUrl = new Map();
        fontAssetsByUrl.set('font://test', { rawSrc: Buffer.from('mock') });

        const result = await getVariationAxisBoundsWithOpsz(
          fontAssetsByUrl,
          'font://test',
          makeSeenAxes([['wght', [400]]])
        );

        // opsz should be pinned to default (14), not preserved as full range
        expect(result.variationAxes.opsz, 'to equal', 14);
      });

      it('should respect explicit opsz values from font-variation-settings', async function () {
        const fontAssetsByUrl = new Map();
        fontAssetsByUrl.set('font://test', { rawSrc: Buffer.from('mock') });

        const result = await getVariationAxisBoundsWithOpsz(
          fontAssetsByUrl,
          'font://test',
          makeSeenAxes([
            ['wght', [400]],
            ['opsz', [12, 48]],
          ])
        );

        // opsz should be narrowed to the seen range
        expect(result.variationAxes.opsz.min, 'to equal', 12);
        expect(result.variationAxes.opsz.max, 'to equal', 48);
      });
    });
  });
});
