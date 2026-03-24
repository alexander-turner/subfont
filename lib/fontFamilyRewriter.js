const cssFontParser = require('css-font-parser');
const cssListHelpers = require('css-list-helpers');

const unquote = require('./unquote');
const findCustomPropertyDefinitions = require('./findCustomPropertyDefinitions');
const extractReferencedCustomPropertyNames = require('./extractReferencedCustomPropertyNames');
const injectSubsetDefinitions = require('./injectSubsetDefinitions');
const { cssQuoteIfNecessary } = require('./fontFaceHelpers');

// Build a map of original font-family -> subset font-family name
function buildWebfontNameMap(htmlOrSvgAssetTextsWithProps) {
  const webfontNameMap = {};
  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const { subsets, fontFamilies, props } of fontUsages) {
      if (subsets) {
        for (const fontFamily of fontFamilies) {
          webfontNameMap[
            fontFamily.toLowerCase()
          ] = `${props['font-family']}__subset`;
        }
      }
    }
  }
  return webfontNameMap;
}

function rewriteSvgFontFamilies(assetGraph, webfontNameMap, omitFallbacks) {
  for (const svgAsset of assetGraph.findAssets({ type: 'Svg' })) {
    if (!svgAsset.isLoaded) continue;
    let changesMade = false;
    for (const element of Array.from(
      svgAsset.parseTree.querySelectorAll('[font-family]')
    )) {
      const fontFamilies = cssListHelpers.splitByCommas(
        element.getAttribute('font-family')
      );
      for (let i = 0; i < fontFamilies.length; i += 1) {
        const subsetFontFamily =
          webfontNameMap[
            cssFontParser.parseFontFamily(fontFamilies[i])[0].toLowerCase()
          ];
        if (subsetFontFamily && !fontFamilies.includes(subsetFontFamily)) {
          fontFamilies.splice(
            i,
            omitFallbacks ? 1 : 0,
            cssQuoteIfNecessary(subsetFontFamily)
          );
          i += 1;
          element.setAttribute('font-family', fontFamilies.join(', '));
          changesMade = true;
        }
      }
    }
    if (changesMade) svgAsset.markDirty();
  }
}

function rewriteCssFontFamilies(assetGraph, webfontNameMap, omitFallbacks) {
  const cssAssets = assetGraph.findAssets({ type: 'Css', isLoaded: true });
  let customPropertyDefinitions;
  let changesMadeToCustomPropertyDefinitions = false;

  for (const cssAsset of cssAssets) {
    let changesMade = false;
    cssAsset.eachRuleInParseTree((cssRule) => {
      if (cssRule.parent.type !== 'rule' || cssRule.type !== 'decl') return;

      const propName = cssRule.prop.toLowerCase();

      if (
        (propName === 'font' || propName === 'font-family') &&
        cssRule.value.includes('var(')
      ) {
        if (!customPropertyDefinitions) {
          customPropertyDefinitions =
            findCustomPropertyDefinitions(cssAssets);
        }
        for (const customPropertyName of extractReferencedCustomPropertyNames(
          cssRule.value
        )) {
          for (const relatedCssRule of [
            cssRule,
            ...(customPropertyDefinitions[customPropertyName] || []),
          ]) {
            const modifiedValue = injectSubsetDefinitions(
              relatedCssRule.value,
              webfontNameMap,
              omitFallbacks
            );
            if (modifiedValue !== relatedCssRule.value) {
              relatedCssRule.value = modifiedValue;
              changesMadeToCustomPropertyDefinitions = true;
            }
          }
        }
      } else if (propName === 'font-family') {
        const fontFamilies = cssListHelpers.splitByCommas(cssRule.value);
        for (let i = 0; i < fontFamilies.length; i += 1) {
          const subsetFontFamily =
            webfontNameMap[
              cssFontParser.parseFontFamily(fontFamilies[i])[0].toLowerCase()
            ];
          if (subsetFontFamily && !fontFamilies.includes(subsetFontFamily)) {
            fontFamilies.splice(
              i,
              omitFallbacks ? 1 : 0,
              cssQuoteIfNecessary(subsetFontFamily)
            );
            i += 1;
            cssRule.value = fontFamilies.join(', ');
            changesMade = true;
          }
        }
      } else if (propName === 'font') {
        const fontProperties = cssFontParser.parseFont(cssRule.value);
        const fontFamilies =
          fontProperties && fontProperties['font-family'].map(unquote);
        if (fontFamilies) {
          const subsetFontFamily =
            webfontNameMap[fontFamilies[0].toLowerCase()];
          if (subsetFontFamily && !fontFamilies.includes(subsetFontFamily)) {
            if (omitFallbacks) fontFamilies.shift();
            fontFamilies.unshift(subsetFontFamily);
            const stylePrefix = fontProperties['font-style']
              ? `${fontProperties['font-style']} `
              : '';
            const weightPrefix = fontProperties['font-weight']
              ? `${fontProperties['font-weight']} `
              : '';
            const lineHeightSuffix = fontProperties['line-height']
              ? `/${fontProperties['line-height']}`
              : '';
            cssRule.value = `${stylePrefix}${weightPrefix}${
              fontProperties['font-size']
            }${lineHeightSuffix} ${fontFamilies
              .map(cssQuoteIfNecessary)
              .join(', ')}`;
            changesMade = true;
          }
        }
      }
    });
    if (changesMade) cssAsset.markDirty();
  }

  if (changesMadeToCustomPropertyDefinitions) {
    for (const cssAsset of cssAssets) {
      cssAsset.markDirty();
    }
  }
}

function rewriteFontFamilyReferences(
  assetGraph,
  htmlOrSvgAssetTextsWithProps,
  omitFallbacks
) {
  const webfontNameMap = buildWebfontNameMap(htmlOrSvgAssetTextsWithProps);
  rewriteSvgFontFamilies(assetGraph, webfontNameMap, omitFallbacks);
  rewriteCssFontFamilies(assetGraph, webfontNameMap, omitFallbacks);
}

module.exports = rewriteFontFamilyReferences;
