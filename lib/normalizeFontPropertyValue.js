const cssFontWeightNames = require('css-font-weight-names');
const initialValueByProp = require('./initialValueByProp');
const unquote = require('./unquote');
const normalizeFontStretch = require('font-snapper/lib/normalizeFontStretch');

// Resolve the CSS relative font-weight keyword `bolder` according to CSS Fonts Level 4.
// https://www.w3.org/TR/css-fonts-4/#relative-weights
function applyBolder(weight) {
  if (weight < 350) return 400;
  if (weight < 550) return 700;
  return 900;
}

// Resolve the CSS relative font-weight keyword `lighter` according to CSS Fonts Level 4.
function applyLighter(weight) {
  if (weight < 100) return weight;
  if (weight < 550) return 100;
  if (weight < 750) return 400;
  return 700;
}

// Resolve a font-weight name (e.g. "bold") or numeric string to a number.
// Returns NaN if the value is not a recognized weight.
function resolveWeightToken(token) {
  const named = cssFontWeightNames[token];
  return parseFloat(named !== undefined ? named : token);
}

// Return true when the numeric weight is within the CSS spec range [1, 1000].
function isValidWeight(weight) {
  return weight >= 1 && weight <= 1000;
}

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
      // font-tracer encodes relative weight modifiers as "baseWeight+bolder+lighter+..."
      // Apply each modifier sequentially per the CSS Fonts Level 4 spec.
      const segments = parsedValue.split('+');
      const baseToken = segments[0].toLowerCase();
      let baseWeight = resolveWeightToken(baseToken);
      if (isValidWeight(baseWeight) && segments.length > 1) {
        for (let i = 1; i < segments.length; i++) {
          const modifier = segments[i].toLowerCase();
          if (modifier === 'bolder') {
            baseWeight = applyBolder(baseWeight);
          } else if (modifier === 'lighter') {
            baseWeight = applyLighter(baseWeight);
          }
        }
        return baseWeight;
      }
      parsedValue = baseToken;
    }
    const numericWeight = resolveWeightToken(parsedValue);
    if (isValidWeight(numericWeight)) {
      return numericWeight;
    }
    return value;
  } else if (propNameLowerCase === 'font-stretch') {
    return normalizeFontStretch(value);
  } else if (typeof value === 'string' && propNameLowerCase !== 'src') {
    return value.toLowerCase();
  }
  return value;
}

module.exports = normalizeFontPropertyValue;
