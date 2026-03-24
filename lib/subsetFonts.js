const urltools = require('urltools');

const collectTextsByPage = require('./collectTextsByPage');
const warnAboutMissingGlyphs = require('./warnAboutMissingGlyphs');
const { googleFontsCssUrlRegex } = require('./googleFonts');
const { insertSubsets, insertFallbacks } = require('./subsetInsertion');
const rewriteFontFamilyReferences = require('./fontFamilyRewriter');

const getFontInfo = require('./getFontInfo');
const {
  getCodepoints,
  parseFontWeightRange,
  parseFontStretchRange,
} = require('./fontFaceHelpers');
const {
  getVariationAxisUsage,
  warnAboutUnusedVariationAxes,
} = require('./variationAxes');
const { getSubsetsForFontUsage } = require('./subsetGeneration');

const validFontDisplayValues = [
  'auto',
  'block',
  'swap',
  'fallback',
  'optional',
];

function debugLog(console, debug, ...args) {
  if (debug && console) {
    console.log(...args);
  }
}

function computeCodepoints(htmlOrSvgAssetTextsWithProps, fontInfoResults) {
  const globalCodepointsByFontUrl = new Map();
  const codepointsCache = new Map();

  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of fontUsages) {
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
}

async function parseFontInfoConcurrently(
  assetGraph,
  htmlOrSvgAssetTextsWithProps
) {
  const codepointFontAssetByUrl = new Map();
  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of fontUsages) {
      if (
        fontUsage.fontUrl &&
        !codepointFontAssetByUrl.has(fontUsage.fontUrl)
      ) {
        const originalFont = assetGraph.findAssets({
          url: fontUsage.fontUrl,
        })[0];
        if (originalFont) {
          codepointFontAssetByUrl.set(fontUsage.fontUrl, originalFont);
        }
      }
    }
  }

  const fontInfoPromises = new Map();
  for (const [fontUrl, fontAsset] of codepointFontAssetByUrl) {
    if (fontAsset.isLoaded) {
      fontInfoPromises.set(
        fontUrl,
        getFontInfo(fontAsset.rawSrc).catch(() => null)
      );
    }
  }
  const fontInfoResults = new Map();
  await Promise.all(
    [...fontInfoPromises.entries()].map(async ([fontUrl, promise]) => {
      fontInfoResults.set(fontUrl, await promise);
    })
  );
  return fontInfoResults;
}

function formatFontInfo(htmlOrSvgAssetTextsWithProps) {
  return htmlOrSvgAssetTextsWithProps.map(({ fontUsages, htmlOrSvgAsset }) => ({
    assetFileName: htmlOrSvgAsset.nonInlineAncestor.urlOrDescription,
    fontUsages: fontUsages.map((fontUsage) =>
      (({ subsets, hasFontFeatureSettings, ...rest }) => rest)(fontUsage)
    ),
  }));
}

async function subsetFonts(
  assetGraph,
  {
    formats = ['woff2', 'woff'],
    subsetPath = 'subfont/',
    omitFallbacks = false,
    instance = false,
    inlineCss,
    fontDisplay,
    hrefType = 'rootRelative',
    onlyInfo,
    dynamic,
    console = global.console,
    text,
    skipSourceMapProcessing = false,
    debug = false,
  } = {}
) {
  if (!validFontDisplayValues.includes(fontDisplay)) {
    fontDisplay = undefined;
  }

  const subsetUrl = urltools.ensureTrailingSlash(assetGraph.root + subsetPath);

  let phaseStart = Date.now();
  if (!skipSourceMapProcessing) {
    await assetGraph.applySourceMaps({ type: 'Css' });
  }
  debugLog(
    console,
    debug,
    `[subfont timing] applySourceMaps: ${Date.now() - phaseStart}ms`
  );

  phaseStart = Date.now();
  await assetGraph.populate({
    followRelations: {
      $or: [
        { to: { url: { $regex: googleFontsCssUrlRegex } } },
        {
          type: 'CssFontFaceSrc',
          from: { url: { $regex: googleFontsCssUrlRegex } },
        },
      ],
    },
  });
  debugLog(
    console,
    debug,
    `[subfont timing] populate (google fonts): ${Date.now() - phaseStart}ms`
  );

  const htmlOrSvgAssets = assetGraph.findAssets({
    $or: [{ type: 'Html', isInline: false }, { type: 'Svg' }],
  });

  phaseStart = Date.now();
  const { htmlOrSvgAssetTextsWithProps, fontFaceDeclarationsByHtmlOrSvgAsset } =
    await collectTextsByPage(assetGraph, htmlOrSvgAssets, {
      text,
      console,
      dynamic,
      debug,
    });
  debugLog(
    console,
    debug,
    `[subfont timing] collectTextsByPage: ${Date.now() - phaseStart}ms`
  );

  // Remove original @font-face rules when omitting fallbacks
  phaseStart = Date.now();
  const potentiallyOrphanedAssets = new Set();
  if (omitFallbacks) {
    for (const htmlOrSvgAsset of htmlOrSvgAssets) {
      const decls = fontFaceDeclarationsByHtmlOrSvgAsset.get(htmlOrSvgAsset);
      for (const { relations } of decls) {
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

  if (fontDisplay) {
    for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
      for (const fontUsage of fontUsages) {
        fontUsage.props['font-display'] = fontDisplay;
      }
    }
  }

  // Generate codepoint sets
  phaseStart = Date.now();
  const fontInfoResults = await parseFontInfoConcurrently(
    assetGraph,
    htmlOrSvgAssetTextsWithProps
  );
  computeCodepoints(htmlOrSvgAssetTextsWithProps, fontInfoResults);
  debugLog(
    console,
    debug,
    `[subfont timing] codepoint generation: ${Date.now() - phaseStart}ms`
  );

  if (onlyInfo) {
    return { fontInfo: formatFontInfo(htmlOrSvgAssetTextsWithProps) };
  }

  // Variation axis analysis
  const { seenAxisValuesByFontUrlAndAxisName, outOfBoundsAxesByFontUrl } =
    getVariationAxisUsage(
      htmlOrSvgAssetTextsWithProps,
      parseFontWeightRange,
      parseFontStretchRange
    );

  // Generate subsets
  phaseStart = Date.now();
  const fontAssetsByUrl = await getSubsetsForFontUsage(
    assetGraph,
    htmlOrSvgAssetTextsWithProps,
    formats,
    seenAxisValuesByFontUrlAndAxisName,
    instance
  );
  debugLog(
    console,
    debug,
    `[subfont timing] getSubsetsForFontUsage: ${Date.now() - phaseStart}ms`
  );

  await warnAboutMissingGlyphs(htmlOrSvgAssetTextsWithProps, assetGraph);

  if (!instance) {
    await warnAboutUnusedVariationAxes(
      assetGraph,
      fontAssetsByUrl,
      seenAxisValuesByFontUrlAndAxisName,
      outOfBoundsAxesByFontUrl,
      assetGraph
    );
  }

  // Insert subset CSS and preload links
  phaseStart = Date.now();
  const numFontUsagesWithSubset = await insertSubsets(
    assetGraph,
    htmlOrSvgAssetTextsWithProps,
    { formats, subsetUrl, omitFallbacks, inlineCss, hrefType }
  );
  debugLog(
    console,
    debug,
    `[subfont timing] insert subsets: ${Date.now() - phaseStart}ms`
  );

  if (numFontUsagesWithSubset === 0) {
    return { fontInfo: [] };
  }

  // Insert fallback CSS and handle Google Fonts
  phaseStart = Date.now();
  await insertFallbacks(
    assetGraph,
    htmlOrSvgAssets,
    htmlOrSvgAssetTextsWithProps,
    fontFaceDeclarationsByHtmlOrSvgAsset,
    { formats, subsetUrl, omitFallbacks, hrefType }
  );
  debugLog(
    console,
    debug,
    `[subfont timing] fallbacks + Google Fonts: ${Date.now() - phaseStart}ms`
  );

  // Rewrite font-family references in CSS and SVG
  phaseStart = Date.now();
  rewriteFontFamilyReferences(
    assetGraph,
    htmlOrSvgAssetTextsWithProps,
    omitFallbacks
  );
  debugLog(
    console,
    debug,
    `[subfont timing] font-family rewrite: ${Date.now() - phaseStart}ms`
  );

  // Source maps
  if (!skipSourceMapProcessing) {
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

  return { fontInfo: formatFontInfo(htmlOrSvgAssetTextsWithProps) };
}

module.exports = subsetFonts;
