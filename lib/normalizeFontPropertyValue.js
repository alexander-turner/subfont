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
      // When CSS animations or transitions interpolate font-weight, values
      // may arrive with a "+bolder" or "+lighter" suffix (e.g. "400+bolder").
      // Stripping the suffix loses the relative adjustment, so the resolved
      // weight may be incorrect for elements whose parent has a non-default
      // font-weight. A proper fix would require cascade context (the parent's
      // computed font-weight) which this function doesn't have access to.
      // In practice this only affects edge cases where font-weight is animated
      // with relative keywords, so we accept the approximation.
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
