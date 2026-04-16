const getFontInfo = require('./getFontInfo');
const parseFontVariationSettings = require('./parseFontVariationSettings');

const standardVariationAxes = new Set(['wght', 'wdth', 'ital', 'slnt', 'opsz']);

// CSS oblique without an explicit <angle> defaults to 14deg. The OpenType slnt
// axis uses the opposite sign convention (positive = counter-clockwise), so
// CSS maps oblique to slnt -14.
const DEFAULT_OBLIQUE_SLNT = -14;

// When no opsz values are determined from font-size or font-variation-settings,
// the axis is pinned to its default value rather than preserving the full range,
// which can significantly bloat variable font subsets.
const ignoredVariationAxes = new Set();

// Parse a CSS font-size value to a numeric px value.
// Returns the number if the value is in absolute units (px, pt), NaN otherwise.
// Relative units (em, rem, %, vw, etc.) cannot be resolved without DOM context.
const PX_PER_PT = 4 / 3;
function parseFontSizePx(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  const match = value.match(/^([\d.]+)(px|pt)?$/i);
  if (!match) return NaN;
  const num = parseFloat(match[1]);
  if (Number.isNaN(num) || num <= 0) return NaN;
  const unit = (match[2] || 'px').toLowerCase();
  return unit === 'pt' ? num * PX_PER_PT : num;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function renderNumberRange(min, max) {
  if (min === max) {
    return String(min);
  } else {
    return `${min}-${max}`;
  }
}

function getVariationAxisUsage(
  htmlOrSvgAssetTextsWithProps,
  parseFontWeightRange,
  parseFontStretchRange
) {
  const seenAxisValuesByFontUrlAndAxisName = new Map();

  function noteUsedValue(fontUrl, axisName, axisValue) {
    let seenAxes = seenAxisValuesByFontUrlAndAxisName.get(fontUrl);
    if (!seenAxes) {
      seenAxes = new Map();
      seenAxisValuesByFontUrlAndAxisName.set(fontUrl, seenAxes);
    }
    if (seenAxes.has(axisName)) {
      seenAxes.get(axisName).add(axisValue);
    } else {
      seenAxes.set(axisName, new Set([axisValue]));
    }
  }

  // Since fontUsages are built from shared templates, all pages produce
  // the same fontStyles/fontWeights/etc. for a given fontUrl. Process
  // each unique fontUrl only once to avoid num_pages × redundant iterations.
  const seenFontUrls = new Set();
  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const {
      fontUrl,
      fontStyles,
      fontWeights,
      fontStretches,
      fontVariationSettings,
      fontSizes,
      props,
    } of fontUsages) {
      if (seenFontUrls.has(fontUrl)) continue;
      seenFontUrls.add(fontUrl);
      if (fontStyles.has('italic')) {
        noteUsedValue(fontUrl, 'ital', 1);
      }
      // If any font-style value except italic is seen (including normal or oblique)
      // we're also utilizing value 0:
      if (fontStyles.size > (fontStyles.has('italic') ? 1 : 0)) {
        noteUsedValue(fontUrl, 'ital', 0);
      }
      if (fontStyles.has('oblique')) {
        // https://www.w3.org/TR/css-fonts-4/#font-style-prop
        // oblique <angle>?
        //   [...] The lack of an <angle> represents 14deg.
        // And also:
        //   Note: the OpenType slnt axis is defined with a positive angle meaning a counter-clockwise slant, the opposite direction to CSS.
        // The CSS implementation will take this into account when using variations to produce oblique faces.
        noteUsedValue(fontUrl, 'slnt', DEFAULT_OBLIQUE_SLNT);
      }
      // If any font-style value except oblique is seen (including normal or italic)
      // we're also utilizing value 0:
      if (fontStyles.size > (fontStyles.has('oblique') ? 1 : 0)) {
        noteUsedValue(fontUrl, 'slnt', 0);
      }

      const minMaxFontWeight = parseFontWeightRange(props['font-weight']);
      for (const fontWeight of fontWeights) {
        noteUsedValue(fontUrl, 'wght', clamp(fontWeight, ...minMaxFontWeight));
      }

      const minMaxFontStretch = parseFontStretchRange(props['font-stretch']);
      for (const fontStretch of fontStretches) {
        noteUsedValue(
          fontUrl,
          'wdth',
          clamp(fontStretch, ...minMaxFontStretch)
        );
      }

      // Map font-size to the opsz axis. With font-optical-sizing: auto
      // (the CSS default), browsers set opsz = font-size in px.
      // Only absolute units (px, pt) can be resolved without DOM context.
      if (fontSizes) {
        for (const fontSize of fontSizes) {
          const px = parseFontSizePx(fontSize);
          if (!Number.isNaN(px)) {
            noteUsedValue(fontUrl, 'opsz', px);
          }
        }
      }

      for (const fontVariationSettingsValue of fontVariationSettings) {
        for (const [axisName, axisValue] of parseFontVariationSettings(
          fontVariationSettingsValue
        )) {
          noteUsedValue(fontUrl, axisName, axisValue);
        }
      }
    }
  }

  return { seenAxisValuesByFontUrlAndAxisName };
}

async function getVariationAxisBounds(
  fontAssetsByUrl,
  fontUrl,
  seenAxisValuesByFontUrlAndAxisName
) {
  let fontInfo;
  try {
    fontInfo = await getFontInfo(fontAssetsByUrl.get(fontUrl).rawSrc);
  } catch {
    // Invalid font -- skip instancing, return safe defaults
    return {
      fullyInstanced: false,
      numAxesPinned: 0,
      numAxesReduced: 0,
      variationAxes: {},
    };
  }

  const variationAxes = {};
  let fullyInstanced = true;
  let numAxesPinned = 0;
  let numAxesReduced = 0;
  const fontVariationEntries = Object.entries(fontInfo.variationAxes);
  const seenAxisValuesByAxisName =
    seenAxisValuesByFontUrlAndAxisName.get(fontUrl);
  if (fontVariationEntries.length > 0 && seenAxisValuesByAxisName) {
    for (const [
      axisName,
      { min, max, default: defaultValue },
    ] of fontVariationEntries) {
      let seenAxisValues = seenAxisValuesByAxisName.get(axisName);
      if (!seenAxisValues && !ignoredVariationAxes.has(axisName)) {
        seenAxisValues = new Set([defaultValue]);
      }
      if (seenAxisValues && seenAxisValues.size === 1) {
        variationAxes[axisName] = clamp([...seenAxisValues][0], min, max);
        numAxesPinned += 1;
      } else if (seenAxisValues) {
        const minSeenValue = Math.min(...seenAxisValues);
        const maxSeenValue = Math.max(...seenAxisValues);
        variationAxes[axisName] = {
          min: Math.max(minSeenValue, min),
          max: Math.min(maxSeenValue, max),
        };
        fullyInstanced = false;
        if (minSeenValue > min || maxSeenValue < max) {
          numAxesReduced += 1;
        }
      }
    }
  }
  return { fullyInstanced, numAxesPinned, numAxesReduced, variationAxes };
}

module.exports = {
  standardVariationAxes,
  ignoredVariationAxes,
  parseFontSizePx,
  renderNumberRange,
  getVariationAxisUsage,
  getVariationAxisBounds,
};
