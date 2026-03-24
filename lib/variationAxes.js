const _ = require('lodash');
const getFontInfo = require('./getFontInfo');
const parseFontVariationSettings = require('./parseFontVariationSettings');

const standardVariationAxes = new Set(['wght', 'wdth', 'ital', 'slnt', 'opsz']);
// It would be very hard to trace statically which values of opsz (font-optical-sizing)
// are going to be used, so we ignore that one:
const ignoredVariationAxes = new Set(['opsz']);

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
  const outOfBoundsAxesByFontUrl = new Map();

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
  // each unique fontUrl only once to avoid 187× redundant iterations.
  const seenFontUrls = new Set();
  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const {
      fontUrl,
      fontStyles,
      fontWeights,
      fontStretches,
      fontVariationSettings,
      hasOutOfBoundsAnimationTimingFunction,
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
        noteUsedValue(fontUrl, 'slnt', -14);
      }
      // If any font-style value except oblique is seen (including normal or italic)
      // we're also utilizing value 0:
      if (fontStyles.size > (fontStyles.has('oblique') ? 1 : 0)) {
        noteUsedValue(fontUrl, 'slnt', 0);
      }

      const minMaxFontWeight = parseFontWeightRange(props['font-weight']);
      for (const fontWeight of fontWeights) {
        noteUsedValue(
          fontUrl,
          'wght',
          _.clamp(fontWeight, ...minMaxFontWeight)
        );
      }

      const minMaxFontStretch = parseFontStretchRange(props['font-stretch']);
      for (const fontStrech of fontStretches) {
        noteUsedValue(
          fontUrl,
          'wdth',
          _.clamp(fontStrech, ...minMaxFontStretch)
        );
      }

      for (const fontVariationSettingsValue of fontVariationSettings) {
        for (const [axisName, axisValue] of parseFontVariationSettings(
          fontVariationSettingsValue
        )) {
          noteUsedValue(fontUrl, axisName, axisValue);
          if (hasOutOfBoundsAnimationTimingFunction) {
            let outOfBoundsAxes = outOfBoundsAxesByFontUrl.get(fontUrl);
            if (!outOfBoundsAxes) {
              outOfBoundsAxes = new Set();
              outOfBoundsAxesByFontUrl.set(fontUrl, outOfBoundsAxes);
            }
            outOfBoundsAxes.add(axisName);
          }
        }
      }
    }
  }

  return { seenAxisValuesByFontUrlAndAxisName, outOfBoundsAxesByFontUrl };
}

async function getVariationAxisBounds(
  fontAssetsByUrl,
  fontUrl,
  seenAxisValuesByFontUrlAndAxisName
) {
  const fontInfo = await getFontInfo(fontAssetsByUrl.get(fontUrl).rawSrc);

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
        variationAxes[axisName] = _.clamp([...seenAxisValues][0], min, max);
        numAxesPinned += 1;
      } else if (seenAxisValues) {
        const minSeenValue = Math.min(...seenAxisValues);
        const maxSeenValue = Math.max(...seenAxisValues);
        variationAxes[axisName] = {
          min: Math.min(minSeenValue, min),
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

async function warnAboutUnusedVariationAxes(
  assetGraph,
  fontAssetsByUrl,
  seenAxisValuesByFontUrlAndAxisName,
  outOfBoundsAxesByFontUrl
) {
  const warnings = [];
  for (const [
    fontUrl,
    seenAxisValuesByAxisName,
  ] of seenAxisValuesByFontUrlAndAxisName.entries()) {
    const outOfBoundsAxes = outOfBoundsAxesByFontUrl.get(fontUrl) || new Set();
    let fontInfo;
    try {
      const fontAsset = fontAssetsByUrl.get(fontUrl);
      if (!fontAsset) continue;
      fontInfo = await getFontInfo(fontAsset.rawSrc);
    } catch (err) {
      // Don't break if we encounter an invalid font
      continue;
    }

    const unusedAxes = [];
    const underutilizedAxes = [];
    for (const [name, { min, max, default: defaultValue }] of Object.entries(
      fontInfo.variationAxes
    )) {
      if (ignoredVariationAxes.has(name)) {
        continue;
      }
      let usedValues = [];
      if (seenAxisValuesByAxisName.has(name) && !outOfBoundsAxes.has(name)) {
        usedValues = [...seenAxisValuesByAxisName.get(name)].map((usedValue) =>
          _.clamp(usedValue, min, max)
        );
      }
      if (!usedValues.every((value) => value === defaultValue)) {
        if (!standardVariationAxes.has(name)) {
          usedValues.push(defaultValue);
        }
        const minUsed = Math.min(...usedValues);
        const maxUsed = Math.max(...usedValues);
        if (minUsed > min || maxUsed < max) {
          underutilizedAxes.push({
            name,
            minUsed,
            maxUsed,
            min,
            max,
          });
        }
      } else {
        unusedAxes.push(name);
      }
    }

    if (unusedAxes.length > 0 || underutilizedAxes.length > 0) {
      let message = `${fontUrl}:\n`;
      if (unusedAxes.length > 0) {
        message += `  Unused axes: ${unusedAxes.join(', ')}\n`;
      }
      if (underutilizedAxes.length > 0) {
        message += `  Underutilized axes:\n${underutilizedAxes
          .map(
            ({ name, min, max, minUsed, maxUsed }) =>
              `    ${name}: ${renderNumberRange(
                minUsed,
                maxUsed
              )} used (${min}-${max} available)`
          )
          .join('\n')}\n`;
      }
      warnings.push(message);
    }
  }

  if (warnings.length > 0) {
    assetGraph.info(
      new Error(`\u{1FA93} Unused variation axes detected in your variable fonts.
The below variable fonts contain custom axes that do not appear to be fully used on any of your pages.
This bloats your fonts and also the subset fonts that subfont creates.
Consider removing the unused axis ranges by specifying the --instance switch
${warnings.join('\n')}`)
    );
  }
}

module.exports = {
  standardVariationAxes,
  ignoredVariationAxes,
  renderNumberRange,
  getVariationAxisUsage,
  getVariationAxisBounds,
  warnAboutUnusedVariationAxes,
};
