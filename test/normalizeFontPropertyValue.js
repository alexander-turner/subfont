const expect = require('unexpected');
const normalizeFontPropertyValue = require('../lib/normalizeFontPropertyValue');

describe('normalizeFontPropertyValue', function () {
  describe('with font-weight', function () {
    it('should convert normal to 400', function () {
      expect(
        normalizeFontPropertyValue('font-weight', 'normal'),
        'to equal',
        400
      );
    });

    it('should convert bold to 700', function () {
      expect(
        normalizeFontPropertyValue('font-weight', 'bold'),
        'to equal',
        700
      );
    });

    it('should parse an in-range integer as a number', function () {
      expect(normalizeFontPropertyValue('font-weight', '300'), 'to equal', 300);
    });

    it('should parse in-range exponential notation', function () {
      expect(normalizeFontPropertyValue('font-weight', '3e2'), 'to equal', 300);
    });

    it('should ignore a value > 1000', function () {
      expect(
        normalizeFontPropertyValue('font-weight', '1001'),
        'to equal',
        '1001'
      );
    });

    it('should ignore a value < 1', function () {
      expect(
        normalizeFontPropertyValue('font-weight', '0.1'),
        'to equal',
        '0.1'
      );
    });

    it('should parse an in-range value with decimals', function () {
      expect(
        normalizeFontPropertyValue('font-weight', '234.56'),
        'to be close to',
        234.56
      );
    });

    it('should resolve bold+lighter+bolder to 700 via CSS spec relative weights', function () {
      // bold=700 → lighter(700)=400 → bolder(400)=700
      expect(
        normalizeFontPropertyValue('font-weight', 'bold+lighter+bolder'),
        'to equal',
        700
      );
    });

    it('should resolve bolder from a light weight (< 350) to 400', function () {
      expect(
        normalizeFontPropertyValue('font-weight', '100+bolder'),
        'to equal',
        400
      );
    });

    it('should resolve bolder from a medium weight (350-549) to 700', function () {
      expect(
        normalizeFontPropertyValue('font-weight', '400+bolder'),
        'to equal',
        700
      );
    });

    it('should resolve bolder from a heavy weight (>= 550) to 900', function () {
      expect(
        normalizeFontPropertyValue('font-weight', '600+bolder'),
        'to equal',
        900
      );
    });

    it('should resolve lighter from a heavy weight (>= 750) to 700', function () {
      expect(
        normalizeFontPropertyValue('font-weight', '900+lighter'),
        'to equal',
        700
      );
    });

    it('should resolve lighter from a semi-heavy weight (550-749) to 400', function () {
      expect(
        normalizeFontPropertyValue('font-weight', '600+lighter'),
        'to equal',
        400
      );
    });

    it('should resolve lighter from a normal weight (100-549) to 100', function () {
      expect(
        normalizeFontPropertyValue('font-weight', '400+lighter'),
        'to equal',
        100
      );
    });

    it('should chain multiple bolder modifiers', function () {
      // 100 → bolder → 400 → bolder → 700
      expect(
        normalizeFontPropertyValue('font-weight', '100+bolder+bolder'),
        'to equal',
        700
      );
    });
  });

  describe('with undefined value', function () {
    it('should return the initial value for the property', function () {
      expect(
        normalizeFontPropertyValue('font-style', undefined),
        'to equal',
        'normal'
      );
    });
  });

  describe('with font-family', function () {
    it('should unquote a quoted font-family', function () {
      expect(
        normalizeFontPropertyValue('font-family', '"Helvetica Neue"'),
        'to equal',
        'Helvetica Neue'
      );
    });
  });

  describe('with font-style', function () {
    it('should lowercase the value', function () {
      expect(
        normalizeFontPropertyValue('font-style', 'Italic'),
        'to equal',
        'italic'
      );
    });
  });

  describe('with src', function () {
    it('should not lowercase src values', function () {
      expect(
        normalizeFontPropertyValue('src', 'url(MyFont.woff2)'),
        'to equal',
        'url(MyFont.woff2)'
      );
    });
  });

  describe('with another property', function () {
    it('should return the value', function () {
      expect(
        normalizeFontPropertyValue('foo-bar', 'quux baz'),
        'to equal',
        'quux baz'
      );
    });
  });
});
