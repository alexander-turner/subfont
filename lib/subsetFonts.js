const urltools = require('urltools');

const fontverter = require('fontverter');

const compileQuery = require('assetgraph/lib/compileQuery');

const findCustomPropertyDefinitions = require('./findCustomPropertyDefinitions');
const extractReferencedCustomPropertyNames = require('./extractReferencedCustomPropertyNames');
const injectSubsetDefinitions = require('./injectSubsetDefinitions');
const cssFontParser = require('css-font-parser');
const cssListHelpers = require('css-list-helpers');
const unquote = require('./unquote');
const normalizeFontPropertyValue = require('./normalizeFontPropertyValue');
const unicodeRange = require('./unicodeRange');
const getFontInfo = require('./getFontInfo');
const collectTextsByPage = require('./collectTextsByPage');

const {
  maybeCssQuote,
  getFontFaceDeclarationText,
  getUnusedVariantsStylesheet,
  getFontUsageStylesheet,
  getCodepoints,
  cssAssetIsEmpty,
  parseFontWeightRange,
  parseFontStretchRange,
  hashHexPrefix,
} = require('./fontFaceHelpers');
const { getVariationAxisUsage } = require('./variationAxes');
const { getSubsetsForFontUsage } = require('./subsetGeneration');

const googleFontsCssUrlRegex = /^(?:https?:)?\/\/fonts\.googleapis\.com\/css/;

function getParents(asset, assetQuery) {
  const assetMatcher = compileQuery(assetQuery);
  const seenAssets = new Set();
  const parents = [];
  (function visit(asset) {
    if (seenAssets.has(asset)) {
      return;
    }
    seenAssets.add(asset);

    for (const incomingRelation of asset.incomingRelations) {
      if (assetMatcher(incomingRelation.from)) {
        parents.push(incomingRelation.from);
      } else {
        visit(incomingRelation.from);
      }
    }
  })(asset);

  return parents;
}

// Escape a value for safe inclusion in any JS string context (single-quoted,
// double-quoted, or template literal). Uses JSON.stringify for robust escaping
// of backslashes, quotes, newlines, U+2028, U+2029, etc.
// The < escape prevents </script> from closing an inline script tag.
function escapeJsStringLiteral(str) {
  return JSON.stringify(str)
    .slice(1, -1)
    .replace(/'/g, "\\'")
    .replace(/`/g, '\\x60')
    .replace(/</g, '\\x3c');
}

function asyncLoadStyleRelationWithFallback(
  htmlOrSvgAsset,
  originalRelation,
  hrefType
) {
  // Async load google font stylesheet
  // Insert async CSS loading <script>
  const href = escapeJsStringLiteral(
    htmlOrSvgAsset.assetGraph.buildHref(
      originalRelation.to.url,
      htmlOrSvgAsset.url,
      { hrefType }
    )
  );
  const mediaAssignment = originalRelation.media
    ? `el.media = '${escapeJsStringLiteral(originalRelation.media)}';`
    : '';
  const asyncCssLoadingRelation = htmlOrSvgAsset.addRelation(
    {
      type: 'HtmlScript',
      hrefType: 'inline',
      to: {
        type: 'JavaScript',
        text: `
          (function () {
            var el = document.createElement('link');
            el.href = '${href}'.toString('url');
            el.rel = 'stylesheet';
            ${mediaAssignment}
            document.body.appendChild(el);
          }())
        `,
      },
    },
    'lastInBody'
  );

  // Insert <noscript> fallback sync CSS loading
  const noScriptFallbackRelation = htmlOrSvgAsset.addRelation(
    {
      type: 'HtmlNoscript',
      to: {
        type: 'Html',
        text: '',
      },
    },
    'lastInBody'
  );

  noScriptFallbackRelation.to.addRelation(
    {
      type: 'HtmlStyle',
      media: originalRelation.media,
      to: originalRelation.to,
      hrefType,
    },
    'last'
  );

  noScriptFallbackRelation.inline();
  asyncCssLoadingRelation.to.minify();
  htmlOrSvgAsset.markDirty();
}

const extensionByFormat = {
  truetype: '.ttf',
  woff: '.woff',
  woff2: '.woff2',
};

async function createSelfHostedGoogleFontsCssAsset(
  assetGraph,
  googleFontsCssAsset,
  formats,
  hrefType,
  subsetUrl
) {
  const lines = [];
  for (const cssFontFaceSrc of assetGraph.findRelations({
    from: googleFontsCssAsset,
    type: 'CssFontFaceSrc',
  })) {
    lines.push(`@font-face {`);
    const fontFaceDeclaration = cssFontFaceSrc.node;
    fontFaceDeclaration.walkDecls((declaration) => {
      const propName = declaration.prop.toLowerCase();
      if (propName !== 'src') {
        lines.push(`  ${propName}: ${declaration.value};`);
      }
    });
    // Convert to all formats in parallel
    const convertedFonts = await Promise.all(
      formats.map((format) =>
        fontverter.convert(cssFontFaceSrc.to.rawSrc, format)
      )
    );
    const srcFragments = [];
    for (let fi = 0; fi < formats.length; fi++) {
      const format = formats[fi];
      const rawSrc = convertedFonts[fi];
      const url = assetGraph.resolveUrl(
        subsetUrl,
        `${cssFontFaceSrc.to.baseName}-${hashHexPrefix(rawSrc)}${
          extensionByFormat[format]
        }`
      );
      const fontAsset =
        assetGraph.findAssets({ url })[0] ||
        (await assetGraph.addAsset({
          url,
          rawSrc,
        }));
      srcFragments.push(
        `url(${assetGraph.buildHref(fontAsset.url, subsetUrl, {
          hrefType,
        })}) format('${format}')`
      );
    }
    lines.push(`  src: ${srcFragments.join(', ')};`);
    lines.push(
      `  unicode-range: ${unicodeRange(
        (await getFontInfo(cssFontFaceSrc.to.rawSrc)).characterSet
      )};`
    );
    lines.push('}');
  }
  const text = lines.join('\n');
  const fallbackAsset = assetGraph.addAsset({
    type: 'Css',
    url: assetGraph.resolveUrl(
      subsetUrl,
      `fallback-${hashHexPrefix(text)}.css`
    ),
    text,
  });
  return fallbackAsset;
}

const validFontDisplayValues = [
  'auto',
  'block',
  'swap',
  'fallback',
  'optional',
];

const warnAboutMissingGlyphs = require('./warnAboutMissingGlyphs');

// Extract subset CSS asset creation/caching into a standalone function
// to reduce cyclomatic complexity of the main injection loop.
async function getOrCreateSubsetCssAsset({
  assetGraph,
  subsetCssText,
  subsetFontUsages,
  formats,
  subsetUrl,
  hrefType,
  inlineCss,
  fontUrlsUsedOnEveryPage,
  numPages,
  subsetCssAssetCache,
}) {
  let cssAsset = subsetCssAssetCache.get(subsetCssText);
  if (cssAsset) return cssAsset;

  cssAsset = assetGraph.addAsset({
    type: 'Css',
    url: `${subsetUrl}subfontTemp.css`,
    text: subsetCssText,
  });

  await cssAsset.minify();

  for (const [i, fontRelation] of cssAsset.outgoingRelations.entries()) {
    const fontAsset = fontRelation.to;
    if (!fontAsset.isLoaded) {
      // An unused variant that does not exist, don't try to hash
      fontRelation.hrefType = hrefType;
      continue;
    }

    const fontUsage = subsetFontUsages[i];
    if (
      formats.length === 1 &&
      fontUsage &&
      (!inlineCss || numPages === 1) &&
      fontUrlsUsedOnEveryPage.has(fontUsage.fontUrl)
    ) {
      // We're only outputting one font format, we're not inlining the subfont CSS (or there's only one page), and this font is used on every page -- keep it inline in the subfont CSS
      continue;
    }

    const extension = fontAsset.contentType.split('/').pop();

    const nameProps = ['font-family', 'font-weight', 'font-style']
      .map((prop) => fontRelation.node.nodes.find((decl) => decl.prop === prop))
      .map((decl) => decl.value);

    const fontWeightRangeStr = nameProps[1]
      .split(/\s+/)
      .map((token) => normalizeFontPropertyValue('font-weight', token))
      .join('_');
    const fileNamePrefix = `${unquote(
      cssFontParser.parseFontFamily(nameProps[0])[0]
    )
      .replace(/__subset$/, '')
      .replace(/[^a-z0-9_-]/gi, '_')}-${fontWeightRangeStr}${
      nameProps[2] === 'italic' ? 'i' : ''
    }`;

    const fontFileName = `${fileNamePrefix}-${fontAsset.md5Hex.slice(
      0,
      10
    )}.${extension}`;

    // If it's not inline, it's one of the unused variants that gets a mirrored declaration added
    // for the __subset @font-face. Do not move it to /subfont/
    if (fontAsset.isInline) {
      const fontAssetUrl = subsetUrl + fontFileName;
      const existingFontAsset = assetGraph.findAssets({
        url: fontAssetUrl,
      })[0];
      if (existingFontAsset) {
        fontRelation.to = existingFontAsset;
        assetGraph.removeAsset(fontAsset);
      } else {
        fontAsset.url = subsetUrl + fontFileName;
      }
    }

    fontRelation.hrefType = hrefType;
  }

  const cssAssetUrl = `${subsetUrl}fonts-${cssAsset.md5Hex.slice(0, 10)}.css`;
  const existingCssAsset = assetGraph.findAssets({ url: cssAssetUrl })[0];
  if (existingCssAsset) {
    assetGraph.removeAsset(cssAsset);
    cssAsset = existingCssAsset;
  } else {
    cssAsset.url = cssAssetUrl;
  }
  subsetCssAssetCache.set(subsetCssText, cssAsset);
  return cssAsset;
}

// Extract subset font preload insertion to reduce injection loop complexity.
function addSubsetFontPreloads({
  cssAsset,
  fontUsages,
  htmlOrSvgAsset,
  subsetUrl,
  hrefType,
  insertionPoint,
}) {
  if (htmlOrSvgAsset.type !== 'Html') return insertionPoint;

  // Only <link rel="preload"> for woff2 subset files whose original
  // font-family is marked for preloading.
  for (const fontRelation of cssAsset.outgoingRelations) {
    if (fontRelation.hrefType === 'inline') continue;

    const fontAsset = fontRelation.to;
    if (
      fontAsset.contentType !== 'font/woff2' ||
      !fontRelation.to.url.startsWith(subsetUrl)
    ) {
      continue;
    }

    const originalFontFamily = unquote(
      fontRelation.node.nodes.find((node) => node.prop === 'font-family').value
    ).replace(/__subset$/, '');
    if (
      !fontUsages.some(
        (fontUsage) =>
          fontUsage.fontFamilies.has(originalFontFamily) && fontUsage.preload
      )
    ) {
      continue;
    }

    const htmlPreloadLink = htmlOrSvgAsset.addRelation(
      {
        type: 'HtmlPreloadLink',
        hrefType,
        to: fontAsset,
        as: 'font',
      },
      insertionPoint ? 'before' : 'firstInHead',
      insertionPoint
    );
    insertionPoint = insertionPoint || htmlPreloadLink;
  }
  return insertionPoint;
}

async function subsetFonts(
  assetGraph,
  {
    formats = ['woff2'],
    subsetPath = 'subfont/',
    omitFallbacks = false,
    inlineCss,
    fontDisplay,
    hrefType = 'rootRelative',
    onlyInfo,
    dynamic,
    console = global.console,
    text,
    sourceMaps = false,
    debug = false,
    concurrency,
    chromeArgs = [],
    cacheDir = null,
  } = {}
) {
  if (!validFontDisplayValues.includes(fontDisplay)) {
    fontDisplay = undefined;
  }

  const subsetUrl = urltools.ensureTrailingSlash(assetGraph.root + subsetPath);

  const timings = {};

  let phaseStart = Date.now();
  if (sourceMaps) {
    await assetGraph.applySourceMaps({ type: 'Css' });
  }
  timings.applySourceMaps = Date.now() - phaseStart;
  if (debug && console)
    console.log(
      `[subfont timing] applySourceMaps: ${timings.applySourceMaps}ms`
    );

  phaseStart = Date.now();
  // Only run Google Fonts populate if there are actually Google Fonts
  // references in the graph. This avoids ~30s of wasted work on sites
  // that use only self-hosted fonts.
  const hasGoogleFonts =
    assetGraph.findRelations({
      to: { url: { $regex: googleFontsCssUrlRegex } },
    }).length > 0;

  if (hasGoogleFonts) {
    await assetGraph.populate({
      followRelations: {
        $or: [
          {
            to: {
              url: { $regex: googleFontsCssUrlRegex },
            },
          },
          {
            type: 'CssFontFaceSrc',
            from: {
              url: { $regex: googleFontsCssUrlRegex },
            },
          },
        ],
      },
    });
  }
  timings['populate (google fonts)'] = Date.now() - phaseStart;
  if (debug && console)
    console.log(
      `[subfont timing] populate (google fonts): ${timings['populate (google fonts)']}ms${hasGoogleFonts ? '' : ' (skipped, no Google Fonts found)'}`
    );

  const htmlOrSvgAssets = assetGraph.findAssets({
    $or: [
      {
        type: 'Html',
        isInline: false,
      },
      {
        type: 'Svg',
      },
    ],
  });

  if (debug && console)
    console.log(
      `[subfont timing] Starting collectTextsByPage for ${htmlOrSvgAssets.length} pages`
    );
  const collectStart = Date.now();
  const {
    htmlOrSvgAssetTextsWithProps,
    fontFaceDeclarationsByHtmlOrSvgAsset,
    subTimings,
  } = await collectTextsByPage(assetGraph, htmlOrSvgAssets, {
    text,
    console,
    dynamic,
    debug,
    concurrency,
    chromeArgs,
  });
  timings.collectTextsByPage = Date.now() - collectStart;
  timings.collectTextsByPageDetails = subTimings;
  if (debug && console)
    console.log(
      `[subfont timing] collectTextsByPage finished in ${timings.collectTextsByPage}ms`
    );

  phaseStart = Date.now();

  const potentiallyOrphanedAssets = new Set();
  if (omitFallbacks) {
    for (const htmlOrSvgAsset of htmlOrSvgAssets) {
      const accumulatedFontFaceDeclarations =
        fontFaceDeclarationsByHtmlOrSvgAsset.get(htmlOrSvgAsset);
      // Remove the original @font-face rules:
      for (const { relations } of accumulatedFontFaceDeclarations) {
        for (const relation of relations) {
          potentiallyOrphanedAssets.add(relation.to);
          if (relation.node.parentNode) {
            relation.node.parentNode.removeChild(relation.node);
          }
          relation.remove();
        }
      }
      htmlOrSvgAsset.markDirty();
    }
  }

  timings['omitFallbacks processing'] = Date.now() - phaseStart;
  if (debug && console)
    console.log(
      `[subfont timing] omitFallbacks processing: ${timings['omitFallbacks processing']}ms`
    );
  phaseStart = Date.now();

  if (fontDisplay) {
    for (const htmlOrSvgAssetTextWithProps of htmlOrSvgAssetTextsWithProps) {
      for (const fontUsage of htmlOrSvgAssetTextWithProps.fontUsages) {
        fontUsage.props['font-display'] = fontDisplay;
      }
    }
  }

  // Pre-compute the global codepoints (original, used, unused) once per fontUrl
  // since fontUsage.text is the same global union on every page.
  // Pre-index all loaded assets by URL for O(1) lookups instead of O(n) scans.
  const loadedAssetsByUrl = new Map();
  for (const asset of assetGraph.findAssets({ isLoaded: true })) {
    if (asset.url) loadedAssetsByUrl.set(asset.url, asset);
  }
  const codepointFontAssetByUrl = new Map();
  for (const htmlOrSvgAssetTextWithProps of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of htmlOrSvgAssetTextWithProps.fontUsages) {
      if (
        fontUsage.fontUrl &&
        !codepointFontAssetByUrl.has(fontUsage.fontUrl)
      ) {
        const originalFont = loadedAssetsByUrl.get(fontUsage.fontUrl);
        if (originalFont) {
          codepointFontAssetByUrl.set(fontUsage.fontUrl, originalFont);
        }
      }
    }
  }

  // getFontInfo internally serializes harfbuzzjs WASM calls (which are
  // not concurrency-safe), so Promise.all here just queues them up
  // and avoids awaiting each individually in the loop below.
  const fontInfoPromises = new Map();
  for (const [fontUrl, fontAsset] of codepointFontAssetByUrl) {
    if (fontAsset.isLoaded) {
      fontInfoPromises.set(
        fontUrl,
        getFontInfo(fontAsset.rawSrc).catch((err) => {
          err.asset = err.asset || fontAsset;
          assetGraph.warn(err);
          return null;
        })
      );
    }
  }
  const fontInfoResults = new Map(
    await Promise.all(
      [...fontInfoPromises].map(async ([key, promise]) => [key, await promise])
    )
  );

  // Build global codepoints synchronously from pre-fetched results
  const globalCodepointsByFontUrl = new Map();
  const codepointsCache = new Map();
  for (const htmlOrSvgAssetTextWithProps of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of htmlOrSvgAssetTextWithProps.fontUsages) {
      let cached = globalCodepointsByFontUrl.get(fontUsage.fontUrl);
      if (!cached) {
        cached = { originalCodepoints: null };
        const fontInfo = fontInfoResults.get(fontUsage.fontUrl);
        if (fontInfo) {
          cached.originalCodepoints = fontInfo.characterSet;
          cached.usedCodepoints = getCodepoints(fontUsage.text);
          const usedCodepointsSet = new Set(cached.usedCodepoints);
          cached.unusedCodepoints = cached.originalCodepoints.filter(
            (n) => !usedCodepointsSet.has(n)
          );
        }
        globalCodepointsByFontUrl.set(fontUsage.fontUrl, cached);
      }

      if (cached.originalCodepoints) {
        // Cache getCodepoints result by pageText string to avoid
        // recomputing for pages with identical text per font
        let pageCodepoints = codepointsCache.get(fontUsage.pageText);
        if (!pageCodepoints) {
          pageCodepoints = getCodepoints(fontUsage.pageText);
          codepointsCache.set(fontUsage.pageText, pageCodepoints);
        }
        fontUsage.codepoints = {
          original: cached.originalCodepoints,
          used: cached.usedCodepoints,
          unused: cached.unusedCodepoints,
          page: pageCodepoints,
        };
      } else {
        fontUsage.codepoints = {
          original: [],
          used: [],
          unused: [],
          page: [],
        };
      }
    }
  }

  timings['codepoint generation'] = Date.now() - phaseStart;
  if (debug && console)
    console.log(
      `[subfont timing] codepoint generation: ${timings['codepoint generation']}ms`
    );
  phaseStart = Date.now();

  if (onlyInfo) {
    return {
      fontInfo: htmlOrSvgAssetTextsWithProps.map(
        ({ fontUsages, htmlOrSvgAsset }) => ({
          assetFileName: htmlOrSvgAsset.nonInlineAncestor.urlOrDescription,
          fontUsages: fontUsages.map((fontUsage) =>
            (({ hasFontFeatureSettings, ...rest }) => rest)(fontUsage)
          ),
        })
      ),
      timings,
    };
  }

  const { seenAxisValuesByFontUrlAndAxisName } = getVariationAxisUsage(
    htmlOrSvgAssetTextsWithProps,
    parseFontWeightRange,
    parseFontStretchRange
  );

  timings['variation axis usage'] = Date.now() - phaseStart;
  if (debug && console)
    console.log(
      `[subfont timing] variation axis usage: ${timings['variation axis usage']}ms`
    );
  phaseStart = Date.now();

  // Generate subsets:
  await getSubsetsForFontUsage(
    assetGraph,
    htmlOrSvgAssetTextsWithProps,
    formats,
    seenAxisValuesByFontUrlAndAxisName,
    cacheDir,
    console
  );

  timings.getSubsetsForFontUsage = Date.now() - phaseStart;
  if (debug && console)
    console.log(
      `[subfont timing] getSubsetsForFontUsage: ${timings.getSubsetsForFontUsage}ms`
    );
  phaseStart = Date.now();

  await warnAboutMissingGlyphs(htmlOrSvgAssetTextsWithProps, assetGraph);
  timings.warnAboutMissingGlyphs = Date.now() - phaseStart;
  if (debug && console)
    console.log(
      `[subfont timing] warnAboutMissingGlyphs: ${timings.warnAboutMissingGlyphs}ms`
    );
  phaseStart = Date.now();

  // Insert subsets:

  // Pre-compute which fontUrls are used (with text) on every page,
  // so we can avoid O(pages × fontUsages) checks inside the font loop.
  const fontUrlsUsedOnEveryPage = new Set();
  if (htmlOrSvgAssetTextsWithProps.length > 0) {
    // Start with all fontUrls from the first page
    const firstPageFontUrls = new Set();
    for (const fu of htmlOrSvgAssetTextsWithProps[0].fontUsages) {
      if (fu.pageText) firstPageFontUrls.add(fu.fontUrl);
    }
    for (const fontUrl of firstPageFontUrls) {
      if (
        htmlOrSvgAssetTextsWithProps.every(({ fontUsages }) =>
          fontUsages.some((fu) => fu.pageText && fu.fontUrl === fontUrl)
        )
      ) {
        fontUrlsUsedOnEveryPage.add(fontUrl);
      }
    }
  }

  // Cache subset CSS assets by their source text to avoid redundant
  // addAsset/minify/removeAsset cycles for pages sharing identical CSS.
  const subsetCssAssetCache = new Map();

  // Pre-index relations by source asset to avoid O(allRelations) scans
  // in the per-page injection loop below. Build indices once, then use
  // O(1) lookups per page instead of repeated assetGraph.findRelations.
  const styleRelsByAsset = new Map();
  const noscriptRelsByAsset = new Map();
  const preloadRelsByAsset = new Map();
  const relTypeToIndex = {
    HtmlStyle: styleRelsByAsset,
    SvgStyle: styleRelsByAsset,
    HtmlNoscript: noscriptRelsByAsset,
    HtmlPrefetchLink: preloadRelsByAsset,
    HtmlPreloadLink: preloadRelsByAsset,
  };
  for (const relation of assetGraph.findRelations({
    type: { $in: Object.keys(relTypeToIndex) },
  })) {
    const index = relTypeToIndex[relation.type];
    const from = relation.from;
    if (!index.has(from)) index.set(from, []);
    index.get(from).push(relation);
  }

  let numFontUsagesWithSubset = 0;
  for (const {
    htmlOrSvgAsset,
    fontUsages,
    accumulatedFontFaceDeclarations,
  } of htmlOrSvgAssetTextsWithProps) {
    const styleRels = styleRelsByAsset.get(htmlOrSvgAsset) || [];
    let insertionPoint = styleRels[0];

    // Fall back to inserting before a <noscript> that contains a stylesheet
    // when no direct stylesheet relation exists (assetgraph#1251)
    if (!insertionPoint && htmlOrSvgAsset.type === 'Html') {
      for (const htmlNoScript of noscriptRelsByAsset.get(htmlOrSvgAsset) ||
        []) {
        const noscriptStyleRels = styleRelsByAsset.get(htmlNoScript.to) || [];
        if (noscriptStyleRels.length > 0) {
          insertionPoint = htmlNoScript;
          break;
        }
      }
    }
    const subsetFontUsages = fontUsages.filter(
      (fontUsage) => fontUsage.subsets
    );
    const subsetFontUsagesSet = new Set(subsetFontUsages);
    const unsubsettedFontUsages = fontUsages.filter(
      (fontUsage) => !subsetFontUsagesSet.has(fontUsage)
    );

    // Remove all existing preload hints to fonts that might have new subsets
    const fontUrls = new Set(fontUsages.map((fu) => fu.fontUrl));
    for (const relation of preloadRelsByAsset.get(htmlOrSvgAsset) || []) {
      if (!relation.to || !fontUrls.has(relation.to.url)) continue;

      if (relation.type === 'HtmlPrefetchLink') {
        const err = new Error(
          `Detached ${relation.node.outerHTML}. Will be replaced with preload with JS fallback.\nIf you feel this is wrong, open an issue at https://github.com/Munter/subfont/issues`
        );
        err.asset = relation.from;
        err.relation = relation;
        assetGraph.info(err);
      }
      relation.detach();
    }

    const unsubsettedFontUsagesToPreload = unsubsettedFontUsages.filter(
      (fontUsage) => fontUsage.preload
    );

    if (unsubsettedFontUsagesToPreload.length > 0) {
      // Insert <link rel="preload">
      for (const fontUsage of unsubsettedFontUsagesToPreload) {
        // Always preload unsubsetted font files, they might be any format, so can't be clever here
        const preloadRelation = htmlOrSvgAsset.addRelation(
          {
            type: 'HtmlPreloadLink',
            hrefType,
            to: fontUsage.fontUrl,
            as: 'font',
          },
          insertionPoint ? 'before' : 'firstInHead',
          insertionPoint
        );
        insertionPoint = insertionPoint || preloadRelation;
      }
    }

    if (subsetFontUsages.length === 0) {
      continue;
    }
    numFontUsagesWithSubset += subsetFontUsages.length;

    let subsetCssText = getFontUsageStylesheet(subsetFontUsages);
    const unusedVariantsCss = getUnusedVariantsStylesheet(
      fontUsages,
      accumulatedFontFaceDeclarations
    );
    if (!inlineCss && !omitFallbacks) {
      // This can go into the same stylesheet because we won't reload all __subset suffixed families in the JS preload fallback
      subsetCssText += unusedVariantsCss;
    }

    const cssAsset = await getOrCreateSubsetCssAsset({
      assetGraph,
      subsetCssText,
      subsetFontUsages,
      formats,
      subsetUrl,
      hrefType,
      inlineCss,
      fontUrlsUsedOnEveryPage,
      numPages: htmlOrSvgAssetTextsWithProps.length,
      subsetCssAssetCache,
    });

    insertionPoint = addSubsetFontPreloads({
      cssAsset,
      fontUsages,
      htmlOrSvgAsset,
      subsetUrl,
      hrefType,
      insertionPoint,
    });
    const cssRelation = htmlOrSvgAsset.addRelation(
      {
        type: `${htmlOrSvgAsset.type}Style`,
        hrefType:
          inlineCss || htmlOrSvgAsset.type === 'Svg' ? 'inline' : hrefType,
        to: cssAsset,
      },
      insertionPoint ? 'before' : 'firstInHead',
      insertionPoint
    );
    insertionPoint = insertionPoint || cssRelation;

    if (!omitFallbacks && inlineCss && unusedVariantsCss) {
      // The fallback CSS for unused variants needs to go into its own stylesheet after the crude version of the JS-based preload "polyfill"
      const cssAsset = htmlOrSvgAsset.addRelation(
        {
          type: 'HtmlStyle',
          to: {
            type: 'Css',
            text: unusedVariantsCss,
          },
        },
        'after',
        cssRelation
      ).to;
      for (const relation of cssAsset.outgoingRelations) {
        relation.hrefType = hrefType;
      }
    }
  }

  timings['insert subsets loop'] = Date.now() - phaseStart;
  if (debug && console)
    console.log(
      `[subfont timing] insert subsets loop: ${timings['insert subsets loop']}ms`
    );
  phaseStart = Date.now();

  if (numFontUsagesWithSubset === 0) {
    return { fontInfo: [], timings };
  }

  const relationsToRemove = new Set();

  // Lazy load the original @font-face declarations of self-hosted fonts (unless omitFallbacks)
  const originalRelations = new Set();
  const fallbackCssAssetCache = new Map();
  for (const htmlOrSvgAsset of htmlOrSvgAssets) {
    const accumulatedFontFaceDeclarations =
      fontFaceDeclarationsByHtmlOrSvgAsset.get(htmlOrSvgAsset);
    // TODO: Maybe group by media?
    const containedRelationsByFontFaceRule = new Map();
    for (const { relations } of accumulatedFontFaceDeclarations) {
      for (const relation of relations) {
        if (
          relation.from.hostname === 'fonts.googleapis.com' || // Google Web Fonts handled separately below
          containedRelationsByFontFaceRule.has(relation.node)
        ) {
          continue;
        }
        originalRelations.add(relation);
        containedRelationsByFontFaceRule.set(
          relation.node,
          relation.from.outgoingRelations.filter(
            (otherRelation) => otherRelation.node === relation.node
          )
        );
      }
    }

    if (
      containedRelationsByFontFaceRule.size === 0 ||
      omitFallbacks ||
      htmlOrSvgAsset.type !== 'Html'
    ) {
      continue;
    }

    const fallbackCssText = [...containedRelationsByFontFaceRule.keys()]
      .map((rule) =>
        getFontFaceDeclarationText(
          rule,
          containedRelationsByFontFaceRule.get(rule)
        )
      )
      .join('');

    let cssAsset = fallbackCssAssetCache.get(fallbackCssText);
    if (!cssAsset) {
      cssAsset = assetGraph.addAsset({
        type: 'Css',
        text: fallbackCssText,
      });
      for (const relation of cssAsset.outgoingRelations) {
        relation.hrefType = hrefType;
      }
      await cssAsset.minify();
      cssAsset.url = `${subsetUrl}fallback-${cssAsset.md5Hex.slice(0, 10)}.css`;
      fallbackCssAssetCache.set(fallbackCssText, cssAsset);
    }

    // Create a <link rel="stylesheet"> that asyncLoadStyleRelationWithFallback can convert to async with noscript fallback:
    const fallbackHtmlStyle = htmlOrSvgAsset.addRelation({
      type: 'HtmlStyle',
      to: cssAsset,
    });

    asyncLoadStyleRelationWithFallback(
      htmlOrSvgAsset,
      fallbackHtmlStyle,
      hrefType
    );
    relationsToRemove.add(fallbackHtmlStyle);
  }

  timings['lazy load fallback CSS'] = Date.now() - phaseStart;
  if (debug && console)
    console.log(
      `[subfont timing] lazy load fallback CSS: ${timings['lazy load fallback CSS']}ms`
    );
  phaseStart = Date.now();

  // Remove the original @font-face blocks, and don't leave behind empty stylesheets:
  const maybeEmptyCssAssets = new Set();
  for (const relation of originalRelations) {
    const cssAsset = relation.from;
    if (relation.node.parent) {
      relation.node.parent.removeChild(relation.node);
    }
    relation.remove();
    cssAsset.markDirty();
    maybeEmptyCssAssets.add(cssAsset);
  }

  for (const cssAsset of maybeEmptyCssAssets) {
    if (cssAssetIsEmpty(cssAsset)) {
      for (const incomingRelation of cssAsset.incomingRelations) {
        incomingRelation.detach();
      }
      assetGraph.removeAsset(cssAsset);
    }
  }

  timings['remove original @font-face'] = Date.now() - phaseStart;
  if (debug && console)
    console.log(
      `[subfont timing] remove original @font-face: ${timings['remove original @font-face']}ms`
    );
  phaseStart = Date.now();

  // Async load Google Web Fonts CSS
  const googleFontStylesheets = assetGraph.findAssets({
    type: 'Css',
    url: { $regex: googleFontsCssUrlRegex },
  });
  const selfHostedGoogleCssByUrl = new Map();
  for (const googleFontStylesheet of googleFontStylesheets) {
    const seenPages = new Set(); // Only do the work once for each font on each page
    for (const googleFontStylesheetRelation of googleFontStylesheet.incomingRelations) {
      let htmlParents;

      if (googleFontStylesheetRelation.type === 'CssImport') {
        // Gather Html parents. Relevant if we are dealing with CSS @import relations
        htmlParents = getParents(googleFontStylesheetRelation.to, {
          type: { $in: ['Html', 'Svg'] },
          isInline: false,
          isLoaded: true,
        });
      } else if (
        ['Html', 'Svg'].includes(googleFontStylesheetRelation.from.type)
      ) {
        htmlParents = [googleFontStylesheetRelation.from];
      } else {
        htmlParents = [];
      }
      for (const htmlParent of htmlParents) {
        if (seenPages.has(htmlParent)) continue;
        seenPages.add(htmlParent);
        relationsToRemove.add(googleFontStylesheetRelation);

        if (omitFallbacks) continue;

        let selfHostedGoogleFontsCssAsset = selfHostedGoogleCssByUrl.get(
          googleFontStylesheetRelation.to.url
        );
        if (!selfHostedGoogleFontsCssAsset) {
          selfHostedGoogleFontsCssAsset =
            await createSelfHostedGoogleFontsCssAsset(
              assetGraph,
              googleFontStylesheetRelation.to,
              formats,
              hrefType,
              subsetUrl
            );
          await selfHostedGoogleFontsCssAsset.minify();
          selfHostedGoogleCssByUrl.set(
            googleFontStylesheetRelation.to.url,
            selfHostedGoogleFontsCssAsset
          );
        }
        const selfHostedFallbackRelation = htmlParent.addRelation(
          {
            type: `${htmlParent.type}Style`,
            to: selfHostedGoogleFontsCssAsset,
            hrefType,
          },
          'lastInBody'
        );
        relationsToRemove.add(selfHostedFallbackRelation);
        if (htmlParent.type === 'Html') {
          asyncLoadStyleRelationWithFallback(
            htmlParent,
            selfHostedFallbackRelation,
            hrefType
          );
        }
      }
    }
    googleFontStylesheet.unload();
  }

  // Clean up, making sure not to detach the same relation twice, eg. when multiple pages use the same stylesheet that imports a font
  for (const relation of relationsToRemove) {
    relation.detach();
  }

  timings['Google Fonts + cleanup'] = Date.now() - phaseStart;
  if (debug && console)
    console.log(
      `[subfont timing] Google Fonts + cleanup: ${timings['Google Fonts + cleanup']}ms`
    );
  phaseStart = Date.now();

  // Use subsets in font-family:

  const webfontNameMap = {};

  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const { subsets, fontFamilies, props } of fontUsages) {
      if (subsets) {
        for (const fontFamily of fontFamilies) {
          webfontNameMap[fontFamily.toLowerCase()] =
            `${props['font-family']}__subset`;
        }
      }
    }
  }

  let customPropertyDefinitions; // Avoid computing this unless necessary
  // Inject subset font name before original webfont in SVG font-family attributes
  const svgAssets = assetGraph.findAssets({ type: 'Svg' });
  for (const svgAsset of svgAssets) {
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
            maybeCssQuote(subsetFontFamily)
          );
          i += 1;
          element.setAttribute('font-family', fontFamilies.join(', '));
          changesMade = true;
        }
      }
    }
    if (changesMade) {
      svgAsset.markDirty();
    }
  }

  // Inject subset font name before original webfont in CSS
  const cssAssets = assetGraph.findAssets({
    type: 'Css',
    isLoaded: true,
  });
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
          customPropertyDefinitions = findCustomPropertyDefinitions(cssAssets);
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
              omitFallbacks // replaceOriginal
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
              maybeCssQuote(subsetFontFamily)
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
        if (!fontFamilies) return;

        const subsetFontFamily = webfontNameMap[fontFamilies[0].toLowerCase()];
        if (!subsetFontFamily || fontFamilies.includes(subsetFontFamily))
          return;

        // Rebuild the font shorthand with the subset family prepended
        if (omitFallbacks) {
          fontFamilies.shift();
        }
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
        }${lineHeightSuffix} ${fontFamilies.map(maybeCssQuote).join(', ')}`;
        changesMade = true;
      }
    });
    if (changesMade) {
      cssAsset.markDirty();
    }
  }

  // This is a bit crude, could be more efficient if we tracked the containing asset in findCustomPropertyDefinitions
  if (changesMadeToCustomPropertyDefinitions) {
    for (const cssAsset of cssAssets) {
      cssAsset.markDirty();
    }
  }

  timings['inject subset font-family'] = Date.now() - phaseStart;
  if (debug && console)
    console.log(
      `[subfont timing] inject subset font-family into CSS/SVG: ${timings['inject subset font-family']}ms`
    );
  phaseStart = Date.now();

  if (sourceMaps) {
    await assetGraph.serializeSourceMaps(undefined, {
      type: 'Css',
      outgoingRelations: {
        $where: (relations) =>
          relations.some((relation) => relation.type === 'CssSourceMappingUrl'),
      },
    });
    for (const relation of assetGraph.findRelations({
      type: 'SourceMapSource',
    })) {
      relation.hrefType = hrefType;
    }
    for (const relation of assetGraph.findRelations({
      type: 'CssSourceMappingUrl',
      hrefType: { $in: ['relative', 'inline'] },
    })) {
      relation.hrefType = hrefType;
    }
  }

  for (const asset of potentiallyOrphanedAssets) {
    if (asset.incomingRelations.length === 0) {
      assetGraph.removeAsset(asset);
    }
  }

  timings['source maps + orphan cleanup'] = Date.now() - phaseStart;
  if (debug && console)
    console.log(
      `[subfont timing] source maps + orphan cleanup: ${timings['source maps + orphan cleanup']}ms`
    );

  // Hand out some useful info about the detected subsets:
  return {
    fontInfo: htmlOrSvgAssetTextsWithProps.map(
      ({ fontUsages, htmlOrSvgAsset }) => ({
        assetFileName: htmlOrSvgAsset.nonInlineAncestor.urlOrDescription,
        fontUsages: fontUsages.map((fontUsage) =>
          (({ subsets, hasFontFeatureSettings, ...rest }) => rest)(fontUsage)
        ),
      })
    ),
    timings,
  };
}

module.exports = subsetFonts;
// Exported for testing
module.exports._escapeJsStringLiteral = escapeJsStringLiteral;
