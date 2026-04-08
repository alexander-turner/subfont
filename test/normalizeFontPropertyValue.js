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

    it('should strip extra characters', function () {
      expect(
        normalizeFontPropertyValue('font-weight', 'bold+lighter+bolder'),
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
