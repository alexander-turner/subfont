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
const {
  createPageProgress,
  logTracedPage,
  makePhaseTracker,
} = require('./progress');

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

const {
  findFontFamiliesWithFeatureSettings,
  resolveFeatureSettings,
} = require('./fontFeatureHelpers');

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

// Fill in fontUsageTemplates/pageTextIndex/preloadIndex on the cached
// declarations entry. No-op on repeat calls — results are shared across
// pages that resolve to the same @font-face set.
function populateGlobalFontUsages(
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

// Trace fonts across the given pages. Uses a worker pool when the workload
// justifies the thread-startup overhead; otherwise falls back to sequential
// in-process tracing (required when a HeadlessBrowser is driving things).
async function tracePages(
  pagesNeedingFullTrace,
  {
    headlessBrowser,
    concurrency,
    console,
    memoizedGetCssRulesByProperty,
    debug = false,
  }
) {
  const totalPages = pagesNeedingFullTrace.length;
  if (totalPages === 0) return;

  const useWorkerPool =
    !headlessBrowser && totalPages >= MIN_PAGES_FOR_WORKER_POOL;

  const progress = createPageProgress({
    total: totalPages,
    console,
    label: 'Tracing fonts',
  });

  if (useWorkerPool) {
    const maxWorkers =
      concurrency > 0 ? concurrency : Math.min(os.cpus().length, 8);
    const numWorkers = Math.min(maxWorkers, totalPages);
    const pool = new FontTracerPool(numWorkers);
    await pool.init();

    try {
      progress.banner(
        `  Tracing fonts across ${totalPages} pages using ${numWorkers} worker${numWorkers === 1 ? '' : 's'}...`
      );
      await Promise.all(
        pagesNeedingFullTrace.map(async (pd) => {
          const pageStart = debug ? Date.now() : 0;
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
          const idx = progress.tick();
          logTracedPage(
            console,
            debug,
            idx,
            totalPages,
            pd.htmlOrSvgAsset,
            pageStart
          );
        })
      );
      progress.done();
    } finally {
      await pool.destroy();
    }
  } else {
    progress.banner(
      `  Tracing fonts across ${totalPages} page${totalPages === 1 ? '' : 's'} (single-threaded${headlessBrowser ? ' + headless browser' : ''})...`
    );
    for (let pi = 0; pi < totalPages; pi++) {
      const pd = pagesNeedingFullTrace[pi];
      const pageStart = debug ? Date.now() : 0;
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
      const idx = progress.tick();
      logTracedPage(
        console,
        debug,
        idx,
        totalPages,
        pd.htmlOrSvgAsset,
        pageStart
      );
    }
    progress.done();
  }
}

// For each page that shares a representative's CSS configuration, copy the
// representative's font-variant props and overlay this page's visible text.
// Returns the number of pages that had to fall back to a full trace
// (because inline style attributes made the fast path unsafe).
function processFastPathPages(
  fastPathPages,
  { memoizedGetCssRulesByProperty }
) {
  if (fastPathPages.length === 0) return 0;

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
  return fastPathFallbacks;
}

// Pre-build an index of stylesheet-related relations by source asset
// to avoid repeated assetGraph.findRelations scans (O(allRelations) each).
const STYLESHEET_REL_TYPES = [
  'HtmlStyle',
  'SvgStyle',
  'CssImport',
  'HtmlConditionalComment',
  'HtmlNoscript',
];

function indexStylesheetRelations(assetGraph) {
  const byFromAsset = new Map();
  for (const relation of assetGraph.findRelations({
    type: { $in: STYLESHEET_REL_TYPES },
  })) {
    let arr = byFromAsset.get(relation.from);
    if (!arr) {
      arr = [];
      byFromAsset.set(relation.from, arr);
    }
    arr.push(relation);
  }
  return byFromAsset;
}

// Build a cache key by traversing stylesheet relations, capturing
// both asset identity and relation context (media, conditionalComment,
// noscript) that affect gatherStylesheetsWithPredicates output.
function buildStylesheetKey(
  htmlOrSvgAsset,
  skipNonFontInlineCss,
  stylesheetRelsByFromAsset
) {
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

// Walk the stylesheet graph rooted at htmlOrSvgAsset and collect every
// @font-face declaration into a flat list, preserving the CSS relation node
// so callers can correlate declarations back to their source rules.
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
  return accumulatedFontFaceDeclarations;
}

// Validate that @font-face declarations sharing family/style/weight carry
// disjoint unicode-range values; throws on incomplete coverage.
function validateFontFaceComboCoverage(accumulatedFontFaceDeclarations) {
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
}

function computeStylesheetResults(htmlOrSvgAsset, stylesheetRelsByFromAsset) {
  const stylesheetsWithPredicates = gatherStylesheetsWithPredicates(
    htmlOrSvgAsset.assetGraph,
    htmlOrSvgAsset,
    stylesheetRelsByFromAsset
  );

  const accumulatedFontFaceDeclarations = collectFontFaceDeclarations(
    htmlOrSvgAsset,
    stylesheetRelsByFromAsset
  );
  validateFontFaceComboCoverage(accumulatedFontFaceDeclarations);

  const featureTagsByFamily = new Map();
  const fontFamiliesWithFeatureSettings = findFontFamiliesWithFeatureSettings(
    stylesheetsWithPredicates,
    featureTagsByFamily
  );

  return {
    accumulatedFontFaceDeclarations,
    stylesheetsWithPredicates,
    fontFamiliesWithFeatureSettings,
    featureTagsByFamily,
    fastPathKey: buildStylesheetKey(
      htmlOrSvgAsset,
      true,
      stylesheetRelsByFromAsset
    ),
  };
}

// Strip `-subfont-text` nodes from CSS @font-face declarations once the
// subset planning is done, so they don't leak to the rendered output.
function stripSubfontTextNodes(fontFaceDeclarationsByHtmlOrSvgAsset) {
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
}

// Split trace work: with a headless browser every page needs a full trace
// (dynamic content); otherwise one representative per stylesheet group is
// traced and the rest use fast-path text extraction.
function planTracing(pageData, hasHeadlessBrowser) {
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
  if (hasHeadlessBrowser) {
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

  return {
    pagesNeedingFullTrace,
    fastPathPages,
    uniqueGroupCount: pagesByStylesheetKey.size,
  };
}

// Iterate every traced page, snap its text against the @font-face set, and
// emit fully-formed per-page fontUsages (one entry per font URL + props).
// Caching is per declarations-key (declCache) and per raw pageText
// (uniqueCharsCache) so sites with many similar pages stay linear.
function buildPerPageFontUsages(
  htmlOrSvgAssetTextsWithProps,
  globalTextByProps,
  text
) {
  const declCache = new Map();
  const uniqueCharsCache = new Map();
  let snappingTime = 0;
  let globalUsageTime = 0;
  let cloningTime = 0;

  for (const entry of htmlOrSvgAssetTextsWithProps) {
    const {
      htmlOrSvgAsset,
      textByProps,
      accumulatedFontFaceDeclarations,
      fontFamiliesWithFeatureSettings,
      featureTagsByFamily,
    } = entry;

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

    const declCacheEntry = declCache.get(declKey);
    const globalUsageStart = Date.now();
    populateGlobalFontUsages(
      declCacheEntry,
      accumulatedFontFaceDeclarations,
      text
    );
    globalUsageTime += Date.now() - globalUsageStart;

    const {
      fontUsageTemplates,
      pageTextIndex,
      preloadIndex: textAndPropsToFontUrl,
    } = declCacheEntry;

    const preloadFontUrls = new Set();
    for (const textByPropsEntry of textByProps) {
      const fontUrl = textAndPropsToFontUrl.get(textByPropsEntry);
      if (fontUrl) {
        preloadFontUrls.add(fontUrl);
      }
    }

    const cloneStart = Date.now();
    const assetTexts = pageTextIndex.get(htmlOrSvgAsset);
    entry.fontUsages = fontUsageTemplates.map((template) => {
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

      const { hasFontFeatureSettings, fontFeatureTags } =
        resolveFeatureSettings(
          template.fontFamilies,
          fontFamiliesWithFeatureSettings,
          featureTagsByFamily
        );

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
        fontFeatureTags,
      };
    });
    cloningTime += Date.now() - cloneStart;
  }

  return { snappingTime, globalUsageTime, cloningTime };
}

// Run computeStylesheetResults once per page, memoizing the result across
// pages that resolve to the same set of stylesheets. Pages without any
// @font-face declarations are recorded in the declarations map but skipped
// from pageData (nothing to trace or subset for them).
function precomputeStylesheetsForPages(
  htmlOrSvgAssets,
  stylesheetRelsByFromAsset,
  fontFaceDeclarationsByHtmlOrSvgAsset
) {
  const stylesheetResultCache = new Map();
  const pageData = [];

  for (const htmlOrSvgAsset of htmlOrSvgAssets) {
    const key = buildStylesheetKey(
      htmlOrSvgAsset,
      false,
      stylesheetRelsByFromAsset
    );
    let result = stylesheetResultCache.get(key);
    if (!result) {
      result = computeStylesheetResults(
        htmlOrSvgAsset,
        stylesheetRelsByFromAsset
      );
      stylesheetResultCache.set(key, result);
    }

    fontFaceDeclarationsByHtmlOrSvgAsset.set(
      htmlOrSvgAsset,
      result.accumulatedFontFaceDeclarations
    );

    if (result.accumulatedFontFaceDeclarations.length === 0) {
      continue;
    }

    pageData.push({
      htmlOrSvgAsset,
      accumulatedFontFaceDeclarations: result.accumulatedFontFaceDeclarations,
      stylesheetsWithPredicates: result.stylesheetsWithPredicates,
      fontFamiliesWithFeatureSettings: result.fontFamiliesWithFeatureSettings,
      featureTagsByFamily: result.featureTagsByFamily,
      stylesheetCacheKey: result.fastPathKey,
    });
  }

  return pageData;
}

// Flatten traced per-page textByProps into a single globalTextByProps array,
// tagging each entry with its owning asset so downstream code can map text
// back to the page that rendered it.
function flattenTracedPagesIntoGlobal(
  pageData,
  htmlOrSvgAssetTextsWithProps,
  globalTextByProps
) {
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
      featureTagsByFamily: pd.featureTagsByFamily,
    });
  }
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
  const stylesheetRelsByFromAsset = indexStylesheetRelations(assetGraph);

  const headlessBrowser =
    dynamic && new HeadlessBrowser({ console, chromeArgs });
  const globalTextByProps = [];
  const subTimings = {};

  const trackPhase = makePhaseTracker(console, debug);
  const overallPhase = trackPhase('collectTextsByPage');

  const stylesheetPrecompute = trackPhase('Stylesheet precompute');
  const pageData = precomputeStylesheetsForPages(
    htmlOrSvgAssets,
    stylesheetRelsByFromAsset,
    fontFaceDeclarationsByHtmlOrSvgAsset
  );
  subTimings['Stylesheet precompute'] = stylesheetPrecompute.end(
    `${pageData.length} pages with fonts`
  );

  // Pages sharing the same CSS configuration produce identical font-tracer
  // props, only text differs — so we trace one representative and fast-path
  // the rest. With --dynamic every page is traced individually.
  const { pagesNeedingFullTrace, fastPathPages, uniqueGroupCount } =
    planTracing(pageData, Boolean(headlessBrowser));

  // Always surface the per-page work breakdown so users can tell at a
  // glance how much of the run is actual tracing vs cheap CSS-group
  // reuse. The threshold matches createPageProgress's minTotal so it
  // only appears on non-trivial runs.
  if (console && pageData.length >= 5) {
    console.log(
      `  ${pageData.length} pages with fonts: ${pagesNeedingFullTrace.length} to trace, ${fastPathPages.length} via cached CSS group (${uniqueGroupCount} unique groups)`
    );
  }

  const tracingStart = Date.now();
  const fullTracing = trackPhase(
    `Full tracing (${pagesNeedingFullTrace.length} pages)`
  );
  try {
    await tracePages(pagesNeedingFullTrace, {
      headlessBrowser,
      concurrency,
      console,
      memoizedGetCssRulesByProperty,
      debug,
    });

    subTimings['Full tracing'] = fullTracing.end();

    const fastPathPhase = trackPhase('Fast-path extraction');
    const fastPathFallbacks = processFastPathPages(fastPathPages, {
      memoizedGetCssRulesByProperty,
    });
    subTimings['Fast-path extraction'] = fastPathPhase.end(
      `${fastPathPages.length} pages, ${fastPathFallbacks} fell back to full trace`
    );

    const assemblePhase = trackPhase('Result assembly');
    flattenTracedPagesIntoGlobal(
      pageData,
      htmlOrSvgAssetTextsWithProps,
      globalTextByProps
    );
    subTimings['Result assembly'] = assemblePhase.end();
    if (debug && console) {
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

  const postProcessPhase = trackPhase('Post-processing total');
  const perPageLoopPhase = trackPhase('Per-page loop');
  const { snappingTime, globalUsageTime, cloningTime } = buildPerPageFontUsages(
    htmlOrSvgAssetTextsWithProps,
    globalTextByProps,
    text
  );
  subTimings['Per-page loop'] = perPageLoopPhase.end(
    `snapping: ${snappingTime}ms, globalUsage: ${globalUsageTime}ms, cloning: ${cloningTime}ms`
  );
  subTimings['Post-processing total'] = postProcessPhase.end();
  overallPhase.end();

  stripSubfontTextNodes(fontFaceDeclarationsByHtmlOrSvgAsset);
  return {
    htmlOrSvgAssetTextsWithProps,
    fontFaceDeclarationsByHtmlOrSvgAsset,
    subTimings,
  };
}

module.exports = collectTextsByPage;
