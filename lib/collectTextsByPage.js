const memoizeSync = require('memoizesync');
const os = require('os');

const fontTracer = require('font-tracer');
const fontSnapper = require('font-snapper');
const cssFontParser = require('css-font-parser');
const parseAnimationShorthand = require('@hookun/parse-animation-shorthand');

const HeadlessBrowser = require('./HeadlessBrowser');
const FontTracerPool = require('./FontTracerPool');
const gatherStylesheetsWithPredicates = require('./gatherStylesheetsWithPredicates');
const getCssRulesByProperty = require('./getCssRulesByProperty');
const unquote = require('./unquote');
const normalizeFontPropertyValue = require('./normalizeFontPropertyValue');
const {
  stringifyFontFamily,
  getPreferredFontUrl,
  uniqueChars,
  uniqueCharsFromArray,
} = require('./fontFaceHelpers');

const allInitialValues = require('./initialValueByProp');
const initialValueByProp = {
  'font-style': allInitialValues['font-style'],
  'font-weight': allInitialValues['font-weight'],
  'font-stretch': allInitialValues['font-stretch'],
};

// Relation types followed when traversing from HTML to CSS for @font-face gathering
const fontFaceTraversalTypes = new Set(['HtmlStyle', 'SvgStyle', 'CssImport']);

// CSS properties that trigger OpenType feature glyph collection
const featureSettingsProps = new Set([
  'font-feature-settings',
  'font-variant-alternates',
  'font-variant-caps',
  'font-variant-east-asian',
  'font-variant-ligatures',
  'font-variant-numeric',
  'font-variant-position',
]);

function ruleUsesFeatureSettings(rule) {
  return rule.nodes.some(
    (node) =>
      node.type === 'decl' && featureSettingsProps.has(node.prop.toLowerCase())
  );
}

function ruleFontFamily(rule) {
  for (let i = rule.nodes.length - 1; i >= 0; i--) {
    const node = rule.nodes[i];
    if (node.type === 'decl' && node.prop.toLowerCase() === 'font-family') {
      return node.value;
    }
  }
  return null;
}

// Determine which font-families use font-feature-settings or font-variant-*.
// Returns null (none detected), a Set of lowercase family names, or true (all).
function findFontFamiliesWithFeatureSettings(stylesheetsWithPredicates) {
  let result = null;
  for (const { asset } of stylesheetsWithPredicates) {
    if (!asset || !asset.parseTree) continue;
    asset.parseTree.walkRules((rule) => {
      if (result === true) return;
      if (!ruleUsesFeatureSettings(rule)) return;

      const fontFamily = ruleFontFamily(rule);
      if (!fontFamily) {
        result = true;
        return;
      }
      if (!result) result = new Set();
      for (const family of cssFontParser.parseFontFamily(fontFamily)) {
        result.add(family.toLowerCase());
      }
    });
    if (result === true) break;
  }
  return result;
}

function isOutOfBoundsAnimationTimingFunction(animationTimingFunctionStr) {
  if (typeof animationTimingFunctionStr !== 'string') {
    return false;
  }
  const { timingFunction } = parseAnimationShorthand.parseSingle(
    `${animationTimingFunctionStr} ignored-name`
  ).value;

  if (timingFunction.type === 'cubic-bezier') {
    const [, y1, , y2] = timingFunction.value;
    return y1 > 1 || y1 < 0 || y2 > 1 || y2 < 0;
  }
  return false;
}

function debugLog(console, debug, ...args) {
  if (debug && console) {
    console.log(...args);
  }
}

function buildStylesheetRelIndex(assetGraph) {
  const stylesheetRelTypes = [
    'HtmlStyle',
    'SvgStyle',
    'CssImport',
    'HtmlConditionalComment',
    'HtmlNoscript',
  ];
  const index = new Map();
  for (const relation of assetGraph.findRelations({
    type: { $in: stylesheetRelTypes },
  })) {
    let arr = index.get(relation.from);
    if (!arr) {
      arr = [];
      index.set(relation.from, arr);
    }
    arr.push(relation);
  }
  return index;
}

function getStylesheetCacheKey(htmlOrSvgAsset, stylesheetRelsByFromAsset) {
  const keyParts = [];
  const visited = new Set();
  (function traverse(asset, isNoscript) {
    if (visited.has(asset)) return;
    if (!asset.isLoaded) return;
    visited.add(asset);
    const rels = stylesheetRelsByFromAsset.get(asset) || [];
    for (const relation of rels) {
      if (relation.type === 'HtmlNoscript') {
        traverse(relation.to, true);
      } else if (relation.type === 'HtmlConditionalComment') {
        keyParts.push(`cc:${relation.condition}`);
        traverse(relation.to, isNoscript);
      } else {
        const media = relation.media || '';
        keyParts.push(`${relation.to.id}:${media}:${isNoscript ? 'ns' : ''}`);
        traverse(relation.to, isNoscript);
      }
    }
  })(htmlOrSvgAsset, false);
  return keyParts.join('\x1d');
}

function collectFontFaceDeclarations(
  htmlOrSvgAsset,
  stylesheetRelsByFromAsset
) {
  const accumulatedFontFaceDeclarations = [];
  const visitedAssets = new Set();

  (function traverseForFontFace(asset) {
    if (visitedAssets.has(asset)) return;
    visitedAssets.add(asset);

    if (asset.type === 'Css' && asset.isLoaded) {
      const seenNodes = new Set();
      const fontRelations = asset.outgoingRelations.filter(
        (relation) => relation.type === 'CssFontFaceSrc'
      );

      for (const fontRelation of fontRelations) {
        const node = fontRelation.node;

        if (!seenNodes.has(node)) {
          seenNodes.add(node);

          const fontFaceDeclaration = {
            relations: fontRelations.filter((r) => r.node === node),
            ...initialValueByProp,
          };

          node.walkDecls((declaration) => {
            const propName = declaration.prop.toLowerCase();
            if (propName === 'font-family') {
              fontFaceDeclaration[propName] = cssFontParser.parseFontFamily(
                declaration.value
              )[0];
            } else {
              fontFaceDeclaration[propName] = declaration.value;
            }
          });

          if (fontFaceDeclaration['font-family'] && fontFaceDeclaration.src) {
            accumulatedFontFaceDeclarations.push(fontFaceDeclaration);
          }
        }
      }
    }

    const rels = stylesheetRelsByFromAsset.get(asset) || [];
    for (const rel of rels) {
      if (
        fontFaceTraversalTypes.has(rel.type) ||
        (rel.to && rel.to.type === 'Html' && rel.to.isInline)
      ) {
        traverseForFontFace(rel.to);
      }
    }
  })(htmlOrSvgAsset);

  if (accumulatedFontFaceDeclarations.length > 0) {
    const seenFontFaceCombos = new Set();
    for (const fontFace of accumulatedFontFaceDeclarations) {
      const comboKey = `${fontFace['font-family']}/${fontFace['font-style']}/${fontFace['font-weight']}`;
      if (seenFontFaceCombos.has(comboKey)) {
        throw new Error(
          `Multiple @font-face with the same font-family/font-style/font-weight (maybe with different unicode-range?) is not supported yet: ${comboKey}`
        );
      }
      seenFontFaceCombos.add(comboKey);
    }
  }

  return accumulatedFontFaceDeclarations;
}

function computeSnappedGlobalEntries(declarations, globalTextByProps) {
  const entries = [];
  const snappingResultCache = new Map();

  for (const textAndProps of globalTextByProps) {
    const family = textAndProps.props['font-family'];
    if (family === undefined) continue;

    const propsKey = `${family}\x1d${
      textAndProps.props['font-weight'] || ''
    }\x1d${textAndProps.props['font-style'] || ''}\x1d${
      textAndProps.props['font-stretch'] || ''
    }`;

    let snappedResults = snappingResultCache.get(propsKey);
    if (!snappedResults) {
      snappedResults = [];
      const families = cssFontParser
        .parseFontFamily(family)
        .filter((fam) =>
          declarations.some(
            (fontFace) =>
              fontFace['font-family'].toLowerCase() === fam.toLowerCase()
          )
        );

      for (const fam of families) {
        const activeFontFaceDeclaration = fontSnapper(declarations, {
          ...textAndProps.props,
          'font-family': stringifyFontFamily(fam),
        });

        if (!activeFontFaceDeclaration) continue;

        const {
          relations,
          '-subfont-text': _subfontText,
          ...props
        } = activeFontFaceDeclaration;
        const fontUrl = getPreferredFontUrl(relations);
        if (!fontUrl) continue;

        let fontWeight = normalizeFontPropertyValue(
          'font-weight',
          textAndProps.props['font-weight']
        );
        if (fontWeight === 'normal') fontWeight = 400;

        snappedResults.push({
          fontUrl,
          props,
          fontRelations: relations,
          fontStyle: normalizeFontPropertyValue(
            'font-style',
            textAndProps.props['font-style']
          ),
          fontWeight,
          fontStretch: normalizeFontPropertyValue(
            'font-stretch',
            textAndProps.props['font-stretch']
          ),
        });
      }
      snappingResultCache.set(propsKey, snappedResults);
    }

    for (const snapped of snappedResults) {
      entries.push({
        textAndProps,
        ...snapped,
        fontVariationSettings: textAndProps.props['font-variation-settings'],
        animationTimingFunction:
          textAndProps.props['animation-timing-function'],
      });
    }
  }
  return entries;
}

function buildFontUsageIndices(snappedGlobalEntries) {
  const pageTextIndex = new Map();
  const entriesByFontUrl = new Map();
  const textAndPropsToFontUrl = new Map();

  for (const entry of snappedGlobalEntries) {
    if (!entry.fontUrl) continue;

    const asset = entry.textAndProps.htmlOrSvgAsset;
    let assetMap = pageTextIndex.get(asset);
    if (!assetMap) {
      assetMap = new Map();
      pageTextIndex.set(asset, assetMap);
    }
    let texts = assetMap.get(entry.fontUrl);
    if (!texts) {
      texts = [];
      assetMap.set(entry.fontUrl, texts);
    }
    texts.push(entry.textAndProps.text);

    let arr = entriesByFontUrl.get(entry.fontUrl);
    if (!arr) {
      arr = [];
      entriesByFontUrl.set(entry.fontUrl, arr);
    }
    arr.push(entry);

    textAndPropsToFontUrl.set(entry.textAndProps, entry.fontUrl);
  }

  return { pageTextIndex, entriesByFontUrl, textAndPropsToFontUrl };
}

function buildFontUsageTemplates(
  accumulatedFontFaceDeclarations,
  entriesByFontUrl,
  text
) {
  const extraTextsByFontUrl = new Map();
  for (const fontFaceDeclaration of accumulatedFontFaceDeclarations) {
    const {
      relations,
      '-subfont-text': subfontText,
      ...props
    } = fontFaceDeclaration;
    const fontUrl = getPreferredFontUrl(relations);
    if (!fontUrl) continue;

    const extras = [];
    if (subfontText !== undefined) extras.push(unquote(subfontText));
    if (text !== undefined) extras.push(text);
    if (extras.length > 0) {
      let arr = extraTextsByFontUrl.get(fontUrl);
      if (!arr) {
        arr = { texts: [], props, fontRelations: relations };
        extraTextsByFontUrl.set(fontUrl, arr);
      }
      arr.texts.push(...extras);
    }
  }

  const fontUsageTemplates = [];
  const allFontUrls = new Set([
    ...entriesByFontUrl.keys(),
    ...extraTextsByFontUrl.keys(),
  ]);

  for (const fontUrl of allFontUrls) {
    const entries = entriesByFontUrl.get(fontUrl) || [];
    const extra = extraTextsByFontUrl.get(fontUrl);

    const allTexts = [];
    if (extra) allTexts.push(...extra.texts);
    allTexts.push(...entries.map((e) => e.textAndProps.text));

    const fontFamilies = new Set(entries.map((e) => e.props['font-family']));
    const fontStyles = new Set(entries.map((e) => e.fontStyle));
    const fontWeights = new Set(entries.map((e) => e.fontWeight));
    const fontStretches = new Set(entries.map((e) => e.fontStretch));
    const fontVariationSettings = new Set(
      entries
        .map((e) => e.fontVariationSettings)
        .filter((fvs) => fvs && fvs.toLowerCase() !== 'normal')
    );
    const hasOutOfBoundsAnimationTimingFunction = entries.some((e) =>
      isOutOfBoundsAnimationTimingFunction(e.animationTimingFunction)
    );

    const fontRelations =
      entries.length > 0 ? entries[0].fontRelations : extra.fontRelations;
    let smallestOriginalSize = 0;
    let smallestOriginalFormat;
    for (const relation of fontRelations) {
      if (relation.to.isLoaded) {
        const size = relation.to.rawSrc.length;
        if (smallestOriginalSize === 0 || size < smallestOriginalSize) {
          smallestOriginalSize = size;
          smallestOriginalFormat = relation.to.type.toLowerCase();
        }
      }
    }

    const props =
      entries.length > 0 ? { ...entries[0].props } : { ...extra.props };
    const extraTextsStr = extra ? extra.texts.join('') : '';

    fontUsageTemplates.push({
      smallestOriginalSize,
      smallestOriginalFormat,
      texts: allTexts,
      text: uniqueCharsFromArray(allTexts),
      extraTextsStr,
      props,
      fontUrl,
      fontFamilies,
      fontStyles,
      fontStretches,
      fontWeights,
      fontVariationSettings,
      hasOutOfBoundsAnimationTimingFunction,
    });
  }

  return fontUsageTemplates;
}

async function collectTextsByPage(
  assetGraph,
  htmlOrSvgAssets,
  { text, console, dynamic = false, debug = false } = {}
) {
  const htmlOrSvgAssetTextsWithProps = [];
  const memoizedGetCssRulesByProperty = memoizeSync(getCssRulesByProperty);
  const fontFaceDeclarationsByHtmlOrSvgAsset = new Map();
  const stylesheetResultCache = new Map();
  const stylesheetRelsByFromAsset = buildStylesheetRelIndex(assetGraph);

  debugLog(console, debug, '[subfont timing] collectTextsByPage started');
  const timingStart = Date.now();

  // Pre-compute stylesheet results for all pages
  const stylesheetPrecomputeStart = Date.now();
  const pageData = [];
  for (const htmlOrSvgAsset of htmlOrSvgAssets) {
    const key = getStylesheetCacheKey(
      htmlOrSvgAsset,
      stylesheetRelsByFromAsset
    );
    let result = stylesheetResultCache.get(key);
    if (!result) {
      const stylesheetsWithPredicates = gatherStylesheetsWithPredicates(
        htmlOrSvgAsset.assetGraph,
        htmlOrSvgAsset,
        stylesheetRelsByFromAsset
      );
      const accumulatedFontFaceDeclarations = collectFontFaceDeclarations(
        htmlOrSvgAsset,
        stylesheetRelsByFromAsset
      );
      const fontFamiliesWithFeatureSettings =
        findFontFamiliesWithFeatureSettings(stylesheetsWithPredicates);

      result = {
        accumulatedFontFaceDeclarations,
        stylesheetsWithPredicates,
        fontFamiliesWithFeatureSettings,
      };
      stylesheetResultCache.set(key, result);
    }

    fontFaceDeclarationsByHtmlOrSvgAsset.set(
      htmlOrSvgAsset,
      result.accumulatedFontFaceDeclarations
    );

    if (result.accumulatedFontFaceDeclarations.length === 0) continue;

    pageData.push({
      htmlOrSvgAsset,
      ...result,
    });
  }

  debugLog(
    console,
    debug,
    `[subfont timing] Stylesheet precompute: ${
      Date.now() - stylesheetPrecomputeStart
    }ms (${pageData.length} pages with fonts)`
  );

  // Use worker pool for parallel fontTracer when there are enough pages
  const headlessBrowser = dynamic && new HeadlessBrowser({ console });
  const globalTextByProps = [];
  const useWorkerPool = !headlessBrowser && pageData.length >= 4;

  const tracingStart = Date.now();
  try {
    if (useWorkerPool) {
      const numWorkers = Math.min(os.cpus().length, pageData.length, 8);
      const pool = new FontTracerPool(numWorkers);
      await pool.init();

      try {
        const tracePromises = pageData.map(async (pd) => {
          try {
            pd.textByProps = await pool.trace(
              pd.htmlOrSvgAsset.text || '',
              pd.stylesheetsWithPredicates
            );
          } catch (err) {
            if (console) {
              console.warn(
                `Worker fontTracer failed for ${pd.htmlOrSvgAsset.url}, falling back to main thread: ${err.message}`
              );
            }
            pd.textByProps = fontTracer(pd.htmlOrSvgAsset.parseTree, {
              stylesheetsWithPredicates: pd.stylesheetsWithPredicates,
              getCssRulesByProperty: memoizedGetCssRulesByProperty,
              asset: pd.htmlOrSvgAsset,
            });
          }
        });
        await Promise.all(tracePromises);
        await pool.destroy();
      } catch (err) {
        await pool.destroy();
        throw err;
      }
    } else if (pageData.length > 0) {
      for (const pd of pageData) {
        pd.textByProps = fontTracer(pd.htmlOrSvgAsset.parseTree, {
          stylesheetsWithPredicates: pd.stylesheetsWithPredicates,
          getCssRulesByProperty: memoizedGetCssRulesByProperty,
          asset: pd.htmlOrSvgAsset,
        });
        if (headlessBrowser) {
          pd.textByProps.push(
            ...(await headlessBrowser.tracePage(pd.htmlOrSvgAsset))
          );
        }
      }
    }

    debugLog(
      console,
      debug,
      `[subfont timing] Full tracing (${pageData.length} pages): ${
        Date.now() - tracingStart
      }ms`
    );

    for (const pd of pageData) {
      for (const textByPropsEntry of pd.textByProps) {
        textByPropsEntry.htmlOrSvgAsset = pd.htmlOrSvgAsset;
      }
      globalTextByProps.push(...pd.textByProps);
      htmlOrSvgAssetTextsWithProps.push({
        htmlOrSvgAsset: pd.htmlOrSvgAsset,
        textByProps: pd.textByProps,
        accumulatedFontFaceDeclarations: pd.accumulatedFontFaceDeclarations,
        fontFamiliesWithFeatureSettings: pd.fontFamiliesWithFeatureSettings,
      });
    }
  } finally {
    if (headlessBrowser) {
      await headlessBrowser.close();
    }
  }

  const postProcessStart = Date.now();

  // Consolidated cache for per-declarations-key data
  const declCache = new Map();

  function getDeclarationsKey(declarations) {
    return declarations
      .map(
        (d) =>
          `${d['font-family']}/${d['font-style']}/${d['font-weight']}/${d['font-stretch']}`
      )
      .join('\x1d');
  }

  function getOrComputeGlobalFontUsages(
    declKey,
    accumulatedFontFaceDeclarations
  ) {
    const cached = declCache.get(declKey);
    if (cached.fontUsageTemplates) return;

    const { pageTextIndex, entriesByFontUrl, textAndPropsToFontUrl } =
      buildFontUsageIndices(cached.snappedEntries);

    cached.fontUsageTemplates = buildFontUsageTemplates(
      accumulatedFontFaceDeclarations,
      entriesByFontUrl,
      text
    );
    cached.pageTextIndex = pageTextIndex;
    cached.preloadIndex = textAndPropsToFontUrl;
  }

  const uniqueCharsCache = new Map();

  for (const htmlOrSvgAssetTextsWithPropsEntry of htmlOrSvgAssetTextsWithProps) {
    const {
      htmlOrSvgAsset,
      textByProps,
      accumulatedFontFaceDeclarations,
      fontFamiliesWithFeatureSettings,
    } = htmlOrSvgAssetTextsWithPropsEntry;

    const declKey = getDeclarationsKey(accumulatedFontFaceDeclarations);
    if (!declCache.has(declKey)) {
      declCache.set(declKey, {
        snappedEntries: computeSnappedGlobalEntries(
          accumulatedFontFaceDeclarations,
          globalTextByProps
        ),
        fontUsageTemplates: null,
        pageTextIndex: null,
        preloadIndex: null,
      });
    }

    getOrComputeGlobalFontUsages(declKey, accumulatedFontFaceDeclarations);

    const declCacheEntry = declCache.get(declKey);
    const fontUsageTemplates = declCacheEntry.fontUsageTemplates;
    const pageTextIndex = declCacheEntry.pageTextIndex;
    const textAndPropsToFontUrl = declCacheEntry.preloadIndex;

    const preloadFontUrls = new Set();
    for (const entry of textByProps) {
      const fontUrl = textAndPropsToFontUrl.get(entry);
      if (fontUrl) preloadFontUrls.add(fontUrl);
    }

    const assetTexts = pageTextIndex.get(htmlOrSvgAsset);
    htmlOrSvgAssetTextsWithPropsEntry.fontUsages = fontUsageTemplates.map(
      (template) => {
        const pageTexts = assetTexts
          ? assetTexts.get(template.fontUrl)
          : undefined;
        let pageTextStr = pageTexts ? pageTexts.join('') : '';
        if (template.extraTextsStr) pageTextStr += template.extraTextsStr;

        let pageTextUnique = uniqueCharsCache.get(pageTextStr);
        if (pageTextUnique === undefined) {
          pageTextUnique = uniqueChars(pageTextStr);
          uniqueCharsCache.set(pageTextStr, pageTextUnique);
        }

        return {
          smallestOriginalSize: template.smallestOriginalSize,
          smallestOriginalFormat: template.smallestOriginalFormat,
          texts: template.texts,
          pageText: pageTextUnique,
          text: template.text,
          props: { ...template.props },
          fontUrl: template.fontUrl,
          fontFamilies: template.fontFamilies,
          fontStyles: template.fontStyles,
          fontStretches: template.fontStretches,
          fontWeights: template.fontWeights,
          fontVariationSettings: template.fontVariationSettings,
          hasOutOfBoundsAnimationTimingFunction:
            template.hasOutOfBoundsAnimationTimingFunction,
          preload: preloadFontUrls.has(template.fontUrl),
          hasFontFeatureSettings:
            fontFamiliesWithFeatureSettings === true ||
            (fontFamiliesWithFeatureSettings instanceof Set &&
              [...template.fontFamilies].some((f) =>
                fontFamiliesWithFeatureSettings.has(f.toLowerCase())
              )) ||
            false,
        };
      }
    );
  }

  debugLog(
    console,
    debug,
    `[subfont timing] Post-processing total: ${Date.now() - postProcessStart}ms`
  );
  debugLog(
    console,
    debug,
    `[subfont timing] collectTextsByPage total: ${Date.now() - timingStart}ms`
  );

  for (const fontFaceDeclarations of fontFaceDeclarationsByHtmlOrSvgAsset.values()) {
    for (const fontFaceDeclaration of fontFaceDeclarations) {
      const firstRelation = fontFaceDeclaration.relations[0];
      const subfontTextNode = firstRelation.node.nodes.find(
        (childNode) =>
          childNode.type === 'decl' &&
          childNode.prop.toLowerCase() === '-subfont-text'
      );

      if (subfontTextNode) {
        subfontTextNode.remove();
        firstRelation.from.markDirty();
      }
    }
  }
  return { htmlOrSvgAssetTextsWithProps, fontFaceDeclarationsByHtmlOrSvgAsset };
}

module.exports = collectTextsByPage;
