const expect = require('unexpected');
const initialValueByProp = require('../lib/initialValueByProp');

describe('initialValueByProp', function () {
  it('should return "normal" for font-weight', function () {
    expect(initialValueByProp['font-weight'], 'to equal', 'normal');
  });

  it('should return "normal" for font-style', function () {
    expect(initialValueByProp['font-style'], 'to equal', 'normal');
  });

  it('should return "normal" for font-stretch', function () {
    expect(initialValueByProp['font-stretch'], 'to equal', 'normal');
  });

  it('should not define a default for font-family', function () {
    expect(initialValueByProp, 'not to have key', 'font-family');
  });

  it('should return "inline" for display', function () {
    expect(initialValueByProp.display, 'to equal', 'inline');
  });

  it('should return "none" for animation-name', function () {
    expect(initialValueByProp['animation-name'], 'to equal', 'none');
  });

  it('should return "none" for text-transform', function () {
    expect(initialValueByProp['text-transform'], 'to equal', 'none');
  });

  it('should return "none" for counter-increment', function () {
    expect(initialValueByProp['counter-increment'], 'to equal', 'none');
  });

  it('should return "none" for counter-reset', function () {
    expect(initialValueByProp['counter-reset'], 'to equal', 'none');
  });

  it('should return "none" for counter-set', function () {
    expect(initialValueByProp['counter-set'], 'to equal', 'none');
  });

  it('should return "all" for transition-property', function () {
    expect(initialValueByProp['transition-property'], 'to equal', 'all');
  });

  it('should return "0s" for transition-duration', function () {
    expect(initialValueByProp['transition-duration'], 'to equal', '0s');
  });

  it('should return "normal" for white-space', function () {
    expect(initialValueByProp['white-space'], 'to equal', 'normal');
  });

  it('should return "normal" for content', function () {
    expect(initialValueByProp.content, 'to equal', 'normal');
  });

  it('should return "none" for list-style-type', function () {
    expect(initialValueByProp['list-style-type'], 'to equal', 'none');
  });

  it('should have a quotes value containing quotation marks', function () {
    expect(initialValueByProp.quotes, 'to be a', 'string');
    expect(initialValueByProp.quotes, 'to contain', '«');
  });
});
