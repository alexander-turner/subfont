const cssFontWeightNames = require('css-font-weight-names');
const initialValueByProp = require('./initialValueByProp');
const unquote = require('./unquote');
const normalizeFontStretch = require('font-snapper/lib/normalizeFontStretch');

function normalizeFontPropertyValue(propName, value) {
  const propNameLowerCase = propName.toLowerCase();
  if (value === undefined) {
    return initialValueByProp[propName];
  }
  if (propNameLowerCase === 'font-family') {
    return unquote(value);
  } else if (propNameLowerCase === 'font-weight') {
    let parsedValue = value;
    if (typeof parsedValue === 'string') {
      // Strip "+bolder"/"+lighter" suffix added during animation/transition
      // interpolation. This loses the relative adjustment, which can produce
      // incorrect weights when the parent has a non-default font-weight.
      // A proper fix requires cascade context this function doesn't have.
      parsedValue = parsedValue.replace(/\+.*$/, '').toLowerCase();
    }
    parsedValue = parseFloat(cssFontWeightNames[parsedValue] || parsedValue);
    if (parsedValue >= 1 && parsedValue <= 1000) {
      return parsedValue;
    } else {
      return value;
    }
  } else if (propNameLowerCase === 'font-stretch') {
    return normalizeFontStretch(value);
  } else if (typeof value === 'string' && propNameLowerCase !== 'src') {
    return value.toLowerCase();
  }
  return value;
}

module.exports = normalizeFontPropertyValue;
