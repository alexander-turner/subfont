const memoizeSync = require('memoizesync');
const os = require('os');

const fontTracer = require('font-tracer');
const fontSnapper = require('font-snapper');

const HeadlessBrowser = require('./HeadlessBrowser');
const FontTracerPool = require('./FontTracerPool');
const gatherStylesheetsWithPredicates = require('./gatherStylesheetsWithPredicates');
const cssFontParser = require('css-font-parser');
const unquote = require('./unquote');
const normalizeFontPropertyValue = require('./normalizeFontPropertyValue');
const getCssRulesByProperty = require('./getCssRulesByProperty');
const extractVisibleText = require('./extractVisibleText');
const {
  stringifyFontFamily,
  getPreferredFontUrl,
  uniqueChars,
  uniqueCharsFromArray,
} = require('./fontFaceHelpers');

const fontRelevantCssRegex =
  /font-family|font-weight|font-style|font-stretch|font-display|@font-face|font-variation|font-feature/i;

// The \s before style ensures we don't match data-style or similar.
const inlineFontStyleRegex =
  /(?:^|\s)style\s*=\s*["'][^"']*\b(?:font-family|font-weight|font-style|font-stretch|font\s*:)/i;
function hasInlineFontStyles(html) {
  return inlineFontStyleRegex.test(html);
}

const fontFaceTraversalTypes = new Set(['HtmlStyle', 'SvgStyle', 'CssImport']);

// Minimum number of pages that justifies spawning a worker pool (below this
// the overhead of worker thread startup exceeds the parallelism benefit).
const MIN_PAGES_FOR_WORKER_POOL = 4;

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
        // No font-family in this rule — conservatively assume all fonts
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

const allInitialValues = require('./initialValueByProp');
const initialValueByProp = {
  'font-style': allInitialValues['font-style'],
  'font-weight': allInitialValues['font-weight'],
  'font-stretch': allInitialValues['font-stretch'],
};

// Null byte delimiter is collision-safe — CSS property values cannot contain \0.
function fontPropsKey(family, weight, style, stretch) {
  return `${family}\0${weight}\0${style}\0${stretch}`;
}

const declKeyCache = new WeakMap();
function getDeclarationsKey(declarations) {
  if (declKeyCache.has(declarations)) {
    return declKeyCache.get(declarations);
  }
  const key = JSON.stringify(
    declarations.map((d) => [
      d['font-family'],
      d['font-style'],
      d['font-weight'],
      d['font-stretch'],
    ])
  );
  declKeyCache.set(declarations, key);
  return key;
}

// Snap each globalTextByProps entry against font-face declarations
// to determine which font URL and properties each text segment maps to.
function computeSnappedGlobalEntries(declarations, globalTextByProps) {
  const entries = [];
  // Cache snapping results per unique props key within this declarations
  // set. Many globalTextByProps entries share the same font properties
  // (only text differs), so we avoid redundant fontSnapper + family
  // parsing calls.
  const snappingResultCache = new Map();

  for (const textAndProps of globalTextByProps) {
    const family = textAndProps.props['font-family'];
    if (family === undefined) {
      continue;
    }

    const propsKey = fontPropsKey(
      family,
      textAndProps.props['font-weight'] || '',
      textAndProps.props['font-style'] || '',
      textAndProps.props['font-stretch'] || ''
    );

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

        if (!activeFontFaceDeclaration) {
          continue;
        }

        const {
          relations,
          '-subfont-text': _,
          ...props
        } = activeFontFaceDeclaration;
        const fontUrl = getPreferredFontUrl(relations);
        if (!fontUrl) {
          continue;
        }

        let fontWeight = normalizeFontPropertyValue(
          'font-weight',
          textAndProps.props['font-weight']
        );
        if (fontWeight === 'normal') {
          fontWeight = 400;
        }

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
      });
    }
  }
  return entries;
}

// Build global font usage templates and per-page indices from
// snapped entries. Mutates the declCache entry for declKey in place.
function getOrComputeGlobalFontUsages(
  cached,
  accumulatedFontFaceDeclarations,
  text
) {
  if (cached.fontUsageTemplates) {
    return;
  }

  const snappedGlobalEntries = cached.snappedEntries;

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
    if (subfontText !== undefined) {
      extras.push(unquote(subfontText));
    }
    if (text !== undefined) {
      extras.push(text);
    }
    if (extras.length > 0) {
      let arr = extraTextsByFontUrl.get(fontUrl);
      if (!arr) {
        arr = { texts: [], props, fontRelations: relations };
        extraTextsByFontUrl.set(fontUrl, arr);
      }
      arr.texts.push(...extras);
    }
  }

  // Build the global fontUsage template for each fontUrl
  const fontUsageTemplates = [];
  const allFontUrls = new Set([
    ...entriesByFontUrl.keys(),
    ...extraTextsByFontUrl.keys(),
  ]);

  for (const fontUrl of allFontUrls) {
    const fontEntries = entriesByFontUrl.get(fontUrl) || [];
    const extra = extraTextsByFontUrl.get(fontUrl);

    // Collect all texts (extras first, then global entries)
    const allTexts = [];
    if (extra) {
      allTexts.push(...extra.texts);
    }
    for (const e of fontEntries) {
      allTexts.push(e.textAndProps.text);
    }

    const fontFamilies = new Set(
      fontEntries.map((e) => e.props['font-family'])
    );
    const fontStyles = new Set(fontEntries.map((e) => e.fontStyle));
    const fontWeights = new Set(fontEntries.map((e) => e.fontWeight));
    const fontStretches = new Set(fontEntries.map((e) => e.fontStretch));
    const fontVariationSettings = new Set(
      fontEntries
        .map((e) => e.fontVariationSettings)
        .filter((fvs) => fvs && fvs.toLowerCase() !== 'normal')
    );
    // Use first entry's relations for size computation, or extra's if no entries
    const fontRelations =
      fontEntries.length > 0
        ? fontEntries[0].fontRelations
        : extra.fontRelations;
    let smallestOriginalSize = 0;
    // undefined is fine here — only used for display/logging, never in arithmetic
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
      fontEntries.length > 0 ? { ...fontEntries[0].props } : { ...extra.props };
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
    });
  }

  cached.fontUsageTemplates = fontUsageTemplates;
  cached.pageTextIndex = pageTextIndex;
  cached.preloadIndex = textAndPropsToFontUrl;
}

// Extract font tracing (worker pool + sequential) to reduce
// cyclomatic complexity of collectTextsByPage.
async function tracePages(
  pagesNeedingFullTrace,
  { headlessBrowser, concurrency, console, memoizedGetCssRulesByProperty }
) {
  const useWorkerPool =
    !headlessBrowser &&
    pagesNeedingFullTrace.length >= MIN_PAGES_FOR_WORKER_POOL;

  if (useWorkerPool) {
    const maxWorkers =
      concurrency > 0 ? concurrency : Math.min(os.cpus().length, 8);
    const numWorkers = Math.min(maxWorkers, pagesNeedingFullTrace.length);
    const pool = new FontTracerPool(numWorkers);
    await pool.init();

    try {
      const totalPages = pagesNeedingFullTrace.length;
      const showProgress = totalPages >= 10 && console;
      let tracedCount = 0;
      const tracePromises = pagesNeedingFullTrace.map(async (pd) => {
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
        tracedCount++;
        if (showProgress && tracedCount % 10 === 0) {
          console.log(`  Tracing fonts: ${tracedCount}/${totalPages} pages...`);
        }
      });
      await Promise.all(tracePromises);
    } finally {
      await pool.destroy();
    }
  } else if (pagesNeedingFullTrace.length > 0) {
    const totalPages = pagesNeedingFullTrace.length;
    const showProgress = totalPages >= 10 && console;
    for (let pi = 0; pi < totalPages; pi++) {
      const pd = pagesNeedingFullTrace[pi];
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
      if (showProgress && (pi + 1) % 10 === 0) {
        console.log(`  Tracing fonts: ${pi + 1}/${totalPages} pages...`);
      }
    }
  }
}

// Extract fast-path text extraction to reduce collectTextsByPage complexity.
// Pages sharing the same CSS configuration reuse the representative's
// props and only extract visible text content.
function processFastPathPages(
  fastPathPages,
  { memoizedGetCssRulesByProperty, console, debug, subTimings }
) {
  if (fastPathPages.length === 0) return;

  const fastPathStart = Date.now();

  const repDataCache = new Map();
  function getRepData(representativePd) {
    if (repDataCache.has(representativePd)) {
      return repDataCache.get(representativePd);
    }
    const repTextByProps = representativePd.textByProps;

    const uniquePropsMap = new Map();
    const textPerPropsKey = new Map();
    const seenVariantKeys = new Set();
    for (const entry of repTextByProps) {
      const family = entry.props['font-family'] || '';
      const propsKey = fontPropsKey(
        family,
        entry.props['font-weight'] || '',
        entry.props['font-style'] || '',
        entry.props['font-stretch'] || ''
      );
      if (!uniquePropsMap.has(propsKey)) {
        uniquePropsMap.set(propsKey, entry.props);
        textPerPropsKey.set(propsKey, []);
      }
      textPerPropsKey.get(propsKey).push(entry.text);
      if (family) {
        const weight = entry.props['font-weight'] || 'normal';
        const style = entry.props['font-style'] || 'normal';
        const stretch = entry.props['font-stretch'] || 'normal';
        for (const fam of cssFontParser.parseFontFamily(family)) {
          seenVariantKeys.add(
            fontPropsKey(fam.toLowerCase(), weight, style, stretch)
          );
        }
      }
    }
    const data = { uniquePropsMap, textPerPropsKey, seenVariantKeys };
    repDataCache.set(representativePd, data);
    return data;
  }

  let fastPathFallbacks = 0;
  for (const pd of fastPathPages) {
    if (hasInlineFontStyles(pd.htmlOrSvgAsset.text || '')) {
      fastPathFallbacks++;
      pd.textByProps = fontTracer(pd.htmlOrSvgAsset.parseTree, {
        stylesheetsWithPredicates: pd.stylesheetsWithPredicates,
        getCssRulesByProperty: memoizedGetCssRulesByProperty,
        asset: pd.htmlOrSvgAsset,
      });
      continue;
    }

    const { uniquePropsMap, textPerPropsKey, seenVariantKeys } = getRepData(
      pd.representativePd
    );

    // Check if any @font-face variants are unseen by the representative.
    // Only copy Maps when extensions are actually needed.
    let effectivePropsMap = uniquePropsMap;
    let effectiveTextPerPropsKey = textPerPropsKey;
    for (const decl of pd.accumulatedFontFaceDeclarations) {
      const family = decl['font-family'];
      if (!family) continue;
      const weight = decl['font-weight'] || 'normal';
      const style = decl['font-style'] || 'normal';
      const stretch = decl['font-stretch'] || 'normal';
      const variantKey = fontPropsKey(
        family.toLowerCase(),
        weight,
        style,
        stretch
      );
      if (!seenVariantKeys.has(variantKey)) {
        // Lazy-copy on first unseen variant
        if (effectivePropsMap === uniquePropsMap) {
          effectivePropsMap = new Map(uniquePropsMap);
          effectiveTextPerPropsKey = new Map(textPerPropsKey);
        }
        const propsKey = fontPropsKey(
          stringifyFontFamily(family),
          weight,
          style,
          stretch
        );
        if (!effectivePropsMap.has(propsKey)) {
          effectivePropsMap.set(propsKey, {
            'font-family': stringifyFontFamily(family),
            'font-weight': weight,
            'font-style': style,
            'font-stretch': stretch,
          });
          effectiveTextPerPropsKey.set(propsKey, []);
        }
      }
    }

    const pageText = extractVisibleText(pd.htmlOrSvgAsset.text || '');

    pd.textByProps = [];
    for (const [propsKey, props] of effectivePropsMap) {
      const repTexts = effectiveTextPerPropsKey.get(propsKey) || [];
      pd.textByProps.push({
        text: pageText + repTexts.join(''),
        props: { ...props },
      });
    }
  }
  subTimings['Fast-path extraction'] = Date.now() - fastPathStart;
  if (debug && console)
    console.log(
      `[subfont timing] Fast-path text extraction (${fastPathPages.length} pages, ${fastPathFallbacks} fell back to full trace): ${subTimings['Fast-path extraction']}ms`
    );
}

async function collectTextsByPage(
  assetGraph,
  htmlOrSvgAssets,
  {
    text,
    console,
    dynamic = false,
    debug = false,
    concurrency,
    chromeArgs = [],
  } = {}
) {
  const htmlOrSvgAssetTextsWithProps = [];

  const memoizedGetCssRulesByProperty = memoizeSync(getCssRulesByProperty);

  const fontFaceDeclarationsByHtmlOrSvgAsset = new Map();

  // Cache stylesheet-dependent results for pages with identical CSS
  // configurations.
  const stylesheetResultCache = new Map();

  // Pre-build an index of stylesheet-related relations by source asset
  // to avoid repeated assetGraph.findRelations scans (O(allRelations) each).
  const stylesheetRelTypes = [
    'HtmlStyle',
    'SvgStyle',
    'CssImport',
    'HtmlConditionalComment',
    'HtmlNoscript',
  ];
  const stylesheetRelsByFromAsset = new Map();
  for (const relation of assetGraph.findRelations({
    type: {
      $in: stylesheetRelTypes,
    },
  })) {
    let arr = stylesheetRelsByFromAsset.get(relation.from);
    if (!arr) {
      arr = [];
      stylesheetRelsByFromAsset.set(relation.from, arr);
    }
    arr.push(relation);
  }

  // Build a cache key by traversing stylesheet relations, capturing
  // both asset identity and relation context (media, conditionalComment,
  // noscript) that affect gatherStylesheetsWithPredicates output.
  function buildStylesheetKey(htmlOrSvgAsset, skipNonFontInlineCss) {
    const keyParts = [];
    const visited = new Set();
    (function traverse(asset, isNoscript) {
      if (visited.has(asset)) return;
      if (!asset.isLoaded) return;
      visited.add(asset);
      for (const relation of stylesheetRelsByFromAsset.get(asset) || []) {
        if (relation.type === 'HtmlNoscript') {
          traverse(relation.to, true);
        } else if (relation.type === 'HtmlConditionalComment') {
          keyParts.push(`cc:${relation.condition}`);
          traverse(relation.to, isNoscript);
        } else {
          const target = relation.to;
          if (
            skipNonFontInlineCss &&
            target.isInline &&
            target.type === 'Css' &&
            !fontRelevantCssRegex.test(target.text || '')
          ) {
            continue;
          }
          const media = relation.media || '';
          keyParts.push(`${target.id}:${media}:${isNoscript ? 'ns' : ''}`);
          traverse(target, isNoscript);
        }
      }
    })(htmlOrSvgAsset, false);
    return keyParts.join('\x1d');
  }

  function getOrComputeStylesheetResults(htmlOrSvgAsset) {
    const key = buildStylesheetKey(htmlOrSvgAsset);
    if (stylesheetResultCache.has(key)) {
      return stylesheetResultCache.get(key);
    }

    const stylesheetsWithPredicates = gatherStylesheetsWithPredicates(
      htmlOrSvgAsset.assetGraph,
      htmlOrSvgAsset,
      stylesheetRelsByFromAsset
    );

    // Compute accumulatedFontFaceDeclarations by traversing CSS relations
    const accumulatedFontFaceDeclarations = [];
    {
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
            if (seenNodes.has(node)) continue;
            seenNodes.add(node);

            const fontFaceDeclaration = {
              relations: fontRelations.filter((r) => r.node === node),
              ...initialValueByProp,
            };

            node.walkDecls((declaration) => {
              const propName = declaration.prop.toLowerCase();
              fontFaceDeclaration[propName] =
                propName === 'font-family'
                  ? cssFontParser.parseFontFamily(declaration.value)[0]
                  : declaration.value;
            });
            // Disregard incomplete @font-face declarations (must contain font-family and src per spec):
            if (fontFaceDeclaration['font-family'] && fontFaceDeclaration.src) {
              accumulatedFontFaceDeclarations.push(fontFaceDeclaration);
            }
          }
        }

        // Traverse children using the pre-built index
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
    }

    // Group @font-face declarations that share family/style/weight but have
    // different unicode-range values. Each group's members cover a disjoint
    // subset of the Unicode space (common for CJK / large character-set fonts).
    const comboGroups = new Map();
    for (const fontFace of accumulatedFontFaceDeclarations) {
      const comboKey = `${fontFace['font-family']}/${fontFace['font-style']}/${fontFace['font-weight']}`;
      if (!comboGroups.has(comboKey)) comboGroups.set(comboKey, []);
      comboGroups.get(comboKey).push(fontFace);
    }
    for (const [comboKey, group] of comboGroups) {
      if (group.length <= 1) continue;
      const withoutRange = group.filter((d) => !d['unicode-range']);
      if (withoutRange.length > 0) {
        throw new Error(
          `Multiple @font-face with the same font-family/font-style/font-weight combo but missing unicode-range on ${withoutRange.length} of ${group.length} declarations: ${comboKey}`
        );
      }
    }

    const fontFamiliesWithFeatureSettings = findFontFamiliesWithFeatureSettings(
      stylesheetsWithPredicates
    );

    const result = {
      accumulatedFontFaceDeclarations,
      stylesheetsWithPredicates,
      fontFamiliesWithFeatureSettings,
      fastPathKey: buildStylesheetKey(htmlOrSvgAsset, true),
    };
    stylesheetResultCache.set(key, result);
    return result;
  }

  const headlessBrowser =
    dynamic && new HeadlessBrowser({ console, chromeArgs });
  const globalTextByProps = [];
  const subTimings = {};

  if (debug && console)
    console.log('[subfont timing] collectTextsByPage started');
  const timingStart = Date.now();

  // Pre-compute stylesheet results for all pages
  const stylesheetPrecomputeStart = Date.now();
  const pageData = [];
  for (const htmlOrSvgAsset of htmlOrSvgAssets) {
    const {
      accumulatedFontFaceDeclarations,
      stylesheetsWithPredicates,
      fontFamiliesWithFeatureSettings,
      fastPathKey,
    } = getOrComputeStylesheetResults(htmlOrSvgAsset);
    fontFaceDeclarationsByHtmlOrSvgAsset.set(
      htmlOrSvgAsset,
      accumulatedFontFaceDeclarations
    );

    if (accumulatedFontFaceDeclarations.length === 0) {
      continue;
    }

    pageData.push({
      htmlOrSvgAsset,
      accumulatedFontFaceDeclarations,
      stylesheetsWithPredicates,
      fontFamiliesWithFeatureSettings,
      stylesheetCacheKey: fastPathKey,
    });
  }

  if (debug && console)
    console.log(
      `[subfont timing] Stylesheet precompute: ${(subTimings['Stylesheet precompute'] = Date.now() - stylesheetPrecomputeStart)}ms (${pageData.length} pages with fonts)`
    );

  // Group pages by stylesheet cache key — pages sharing the same CSS
  // configuration produce identical font-tracer props, only text differs.
  const pagesByStylesheetKey = new Map();
  for (const pd of pageData) {
    let group = pagesByStylesheetKey.get(pd.stylesheetCacheKey);
    if (!group) {
      group = [];
      pagesByStylesheetKey.set(pd.stylesheetCacheKey, group);
    }
    group.push(pd);
  }

  const pagesNeedingFullTrace = [];
  const fastPathPages = [];
  if (headlessBrowser) {
    for (const pd of pageData) {
      pagesNeedingFullTrace.push(pd);
    }
  } else {
    for (const group of pagesByStylesheetKey.values()) {
      pagesNeedingFullTrace.push(group[0]);
      for (let i = 1; i < group.length; i++) {
        group[i].representativePd = group[0];
        fastPathPages.push(group[i]);
      }
    }
  }

  if (debug && console)
    console.log(
      `[subfont timing] CSS groups: ${pagesByStylesheetKey.size} unique, ${pagesNeedingFullTrace.length} to trace, ${fastPathPages.length} fast-path`
    );

  const tracingStart = Date.now();
  try {
    await tracePages(pagesNeedingFullTrace, {
      headlessBrowser,
      concurrency,
      console,
      memoizedGetCssRulesByProperty,
    });

    subTimings['Full tracing'] = Date.now() - tracingStart;
    if (debug && console)
      console.log(
        `[subfont timing] Full tracing (${pagesNeedingFullTrace.length} pages): ${subTimings['Full tracing']}ms`
      );

    processFastPathPages(fastPathPages, {
      memoizedGetCssRulesByProperty,
      console,
      debug,
      subTimings,
    });

    const assembleStart = Date.now();
    for (const pd of pageData) {
      for (const textByPropsEntry of pd.textByProps) {
        textByPropsEntry.htmlOrSvgAsset = pd.htmlOrSvgAsset;
      }
      // Use a loop instead of push(...spread) to avoid stack overflow on large sites
      for (const entry of pd.textByProps) {
        globalTextByProps.push(entry);
      }
      htmlOrSvgAssetTextsWithProps.push({
        htmlOrSvgAsset: pd.htmlOrSvgAsset,
        textByProps: pd.textByProps,
        accumulatedFontFaceDeclarations: pd.accumulatedFontFaceDeclarations,
        fontFamiliesWithFeatureSettings: pd.fontFamiliesWithFeatureSettings,
      });
    }

    subTimings['Result assembly'] = Date.now() - assembleStart;
    if (debug && console) {
      console.log(
        `[subfont timing] Result assembly: ${subTimings['Result assembly']}ms`
      );
      console.log(
        `[subfont timing] Total tracing+extraction+assembly: ${
          Date.now() - tracingStart
        }ms`
      );
    }
  } finally {
    if (headlessBrowser) {
      await headlessBrowser.close();
    }
  }

  const postProcessStart = Date.now();

  // Consolidated cache for per-declarations-key data.
  const declCache = new Map();

  const perPageLoopStart = Date.now();
  let snappingTime = 0;
  let globalUsageTime = 0;

  // Cache uniqueChars results by raw pageText string to avoid recomputing
  const uniqueCharsCache = new Map();
  let cloningTime = 0;

  for (const htmlOrSvgAssetTextsWithPropsEntry of htmlOrSvgAssetTextsWithProps) {
    const {
      htmlOrSvgAsset,
      textByProps,
      accumulatedFontFaceDeclarations,
      fontFamiliesWithFeatureSettings,
    } = htmlOrSvgAssetTextsWithPropsEntry;

    // Get or compute the snapped global entries for this declarations set
    const declKey = getDeclarationsKey(accumulatedFontFaceDeclarations);
    if (!declCache.has(declKey)) {
      const snapStart = Date.now();
      declCache.set(declKey, {
        snappedEntries: computeSnappedGlobalEntries(
          accumulatedFontFaceDeclarations,
          globalTextByProps
        ),
        fontUsageTemplates: null,
        pageTextIndex: null,
        preloadIndex: null,
      });
      snappingTime += Date.now() - snapStart;
    }

    // Precompute global font usage templates and indices once per declarations key
    const declCacheEntry = declCache.get(declKey);
    const globalUsageStart = Date.now();
    getOrComputeGlobalFontUsages(
      declCacheEntry,
      accumulatedFontFaceDeclarations,
      text
    );
    globalUsageTime += Date.now() - globalUsageStart;

    const fontUsageTemplates = declCacheEntry.fontUsageTemplates;
    const pageTextIndex = declCacheEntry.pageTextIndex;
    const textAndPropsToFontUrl = declCacheEntry.preloadIndex;

    // Compute preload per fontUrl using inverted index
    const preloadFontUrls = new Set();
    for (const entry of textByProps) {
      const fontUrl = textAndPropsToFontUrl.get(entry);
      if (fontUrl) {
        preloadFontUrls.add(fontUrl);
      }
    }

    // Build per-page fontUsages from precomputed templates
    const cloneStart = Date.now();
    const assetTexts = pageTextIndex.get(htmlOrSvgAsset);
    htmlOrSvgAssetTextsWithPropsEntry.fontUsages = fontUsageTemplates.map(
      (template) => {
        const pageTexts = assetTexts
          ? assetTexts.get(template.fontUrl)
          : undefined;
        let pageTextStr = pageTexts ? pageTexts.join('') : '';
        if (template.extraTextsStr) {
          pageTextStr += template.extraTextsStr;
        }

        let pageTextUnique = uniqueCharsCache.get(pageTextStr);
        if (pageTextUnique === undefined) {
          pageTextUnique = uniqueChars(pageTextStr);
          uniqueCharsCache.set(pageTextStr, pageTextUnique);
        }

        let hasFontFeatureSettings = false;
        if (fontFamiliesWithFeatureSettings === true) {
          hasFontFeatureSettings = true;
        } else if (fontFamiliesWithFeatureSettings instanceof Set) {
          for (const f of template.fontFamilies) {
            if (fontFamiliesWithFeatureSettings.has(f.toLowerCase())) {
              hasFontFeatureSettings = true;
              break;
            }
          }
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
          preload: preloadFontUrls.has(template.fontUrl),
          hasFontFeatureSettings,
        };
      }
    );
    cloningTime += Date.now() - cloneStart;
  }

  subTimings['Per-page loop'] = Date.now() - perPageLoopStart;
  subTimings['Post-processing total'] = Date.now() - postProcessStart;
  if (debug && console)
    console.log(
      `[subfont timing] Per-page loop: ${subTimings['Per-page loop']}ms (snapping: ${snappingTime}ms, globalUsage: ${globalUsageTime}ms, cloning: ${cloningTime}ms)`
    );
  if (debug && console)
    console.log(
      `[subfont timing] Post-processing total: ${subTimings['Post-processing total']}ms`
    );
  if (debug && console)
    console.log(
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
  return {
    htmlOrSvgAssetTextsWithProps,
    fontFaceDeclarationsByHtmlOrSvgAsset,
    subTimings,
  };
}

module.exports = collectTextsByPage;
