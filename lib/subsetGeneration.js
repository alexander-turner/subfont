const subsetFont = require('subset-font');
const { getVariationAxisBounds } = require('./variationAxes');
const collectFeatureGlyphIds = require('./collectFeatureGlyphIds');
const subsetFontWithGlyphs = require('./subsetFontWithGlyphs');

function getSubsetPromiseId(fontUsage, format, variationAxes = null) {
  return [
    fontUsage.text,
    fontUsage.fontUrl,
    format,
    JSON.stringify(variationAxes),
  ].join('\x1d');
}

function collectCanonicalFontUsages(htmlOrSvgAssetTextsWithProps) {
  const canonicalFontUsageByUrl = new Map();

  for (const item of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of item.fontUsages) {
      if (!fontUsage.fontUrl) continue;
      if (!canonicalFontUsageByUrl.has(fontUsage.fontUrl)) {
        canonicalFontUsageByUrl.set(fontUsage.fontUrl, fontUsage);
      }
    }
  }

  return canonicalFontUsageByUrl;
}

async function loadFontAssets(assetGraph, allFonts) {
  await assetGraph.populate({
    followRelations: {
      to: { url: { $or: allFonts } },
    },
  });

  const fontAssetsByUrl = new Map();
  const originalFontBuffers = new Map();
  for (const fontUrl of allFonts) {
    const fontAsset = assetGraph.findAssets({
      url: fontUrl,
      isLoaded: true,
    })[0];
    if (fontAsset) {
      fontAssetsByUrl.set(fontUrl, fontAsset);
      originalFontBuffers.set(fontUrl, fontAsset.rawSrc);
    }
  }

  return { fontAssetsByUrl, originalFontBuffers };
}

async function computeVariationAxisBounds(
  canonicalFontUsageByUrl,
  fontAssetsByUrl,
  seenAxisValuesByFontUrlAndAxisName
) {
  const cache = new Map();
  const fontUrls = [...canonicalFontUsageByUrl.keys()].filter((url) =>
    fontAssetsByUrl.has(url)
  );
  const boundsResults = await Promise.all(
    fontUrls.map((fontUrl) =>
      getVariationAxisBounds(
        fontAssetsByUrl,
        fontUrl,
        seenAxisValuesByFontUrlAndAxisName
      )
    )
  );
  for (let i = 0; i < fontUrls.length; i++) {
    cache.set(fontUrls[i], boundsResults[i]);
  }
  return cache;
}

function getSubsetInfoForFont(fontUrl, instance, variationAxisBoundsCache) {
  let variationAxes;
  let fullyInstanced = false;
  let numAxesReduced = 0;
  let numAxesPinned = 0;
  if (instance) {
    const res = variationAxisBoundsCache.get(fontUrl);
    if (res) {
      variationAxes = res.variationAxes;
      fullyInstanced = res.fullyInstanced;
      numAxesReduced = res.numAxesReduced;
      numAxesPinned = res.numAxesPinned;
    }
  }
  return { variationAxes, fullyInstanced, numAxesPinned, numAxesReduced };
}

function applySubsetInfo(fontUsage, info) {
  fontUsage.variationAxes = info.variationAxes;
  fontUsage.fullyInstanced = info.fullyInstanced;
  fontUsage.numAxesPinned = info.numAxesPinned;
  fontUsage.numAxesReduced = info.numAxesReduced;
}

function assignSubsetResults(
  canonicalFontUsageByUrl,
  subsetResultsByFontUrl,
  resolvedSubsets,
  formats
) {
  for (const [, fontUsage] of canonicalFontUsageByUrl) {
    const info = subsetResultsByFontUrl.get(fontUsage.fontUrl);
    for (const targetFormat of formats) {
      const promiseId = getSubsetPromiseId(
        fontUsage,
        targetFormat,
        info.variationAxes
      );
      const subsetBuffer = resolvedSubsets.get(promiseId);
      if (subsetBuffer) {
        if (!fontUsage.subsets) {
          fontUsage.subsets = {};
        }
        fontUsage.subsets[targetFormat] = subsetBuffer;
        const size = subsetBuffer.length;
        if (
          !fontUsage.smallestSubsetSize ||
          size < fontUsage.smallestSubsetSize
        ) {
          fontUsage.smallestSubsetSize = size;
          fontUsage.smallestSubsetFormat = targetFormat;
          applySubsetInfo(fontUsage, info);
        }
      }
    }
  }
}

function propagateSubsets(
  htmlOrSvgAssetTextsWithProps,
  canonicalFontUsageByUrl,
  subsetResultsByFontUrl
) {
  for (const item of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of item.fontUsages) {
      if (!fontUsage.fontUrl) continue;
      const canonical = canonicalFontUsageByUrl.get(fontUsage.fontUrl);
      if (canonical && canonical !== fontUsage && canonical.subsets) {
        fontUsage.subsets = canonical.subsets;
        fontUsage.smallestSubsetSize = canonical.smallestSubsetSize;
        fontUsage.smallestSubsetFormat = canonical.smallestSubsetFormat;
        applySubsetInfo(
          fontUsage,
          subsetResultsByFontUrl.get(fontUsage.fontUrl)
        );
      }
    }
  }
}

async function getSubsetsForFontUsage(
  assetGraph,
  htmlOrSvgAssetTextsWithProps,
  formats,
  seenAxisValuesByFontUrlAndAxisName,
  instance = true
) {
  const canonicalFontUsageByUrl = collectCanonicalFontUsages(
    htmlOrSvgAssetTextsWithProps
  );
  const allFontUrls = [...canonicalFontUsageByUrl.keys()];

  const { fontAssetsByUrl, originalFontBuffers } = await loadFontAssets(
    assetGraph,
    allFontUrls
  );

  const subsetPromiseMap = new Map();
  const subsetResultsByFontUrl = new Map();

  const variationAxisBoundsCache = instance
    ? await computeVariationAxisBounds(
        canonicalFontUsageByUrl,
        fontAssetsByUrl,
        seenAxisValuesByFontUrlAndAxisName
      )
    : new Map();

  for (const [fontUrl, fontUsage] of canonicalFontUsageByUrl) {
    const fontBuffer = originalFontBuffers.get(fontUrl);
    const text = fontUsage.text;
    const subsetInfo = getSubsetInfoForFont(
      fontUrl,
      instance,
      variationAxisBoundsCache
    );
    subsetResultsByFontUrl.set(fontUrl, subsetInfo);

    // When font-feature-settings or font-variant-* CSS properties are used,
    // collect the alternate glyph IDs that GSUB features produce for the
    // page text. These are passed directly to HarfBuzz's subset glyph set,
    // preserving the alternate glyphs without including all codepoints.
    let featureGlyphIds;
    if (fontUsage.hasFontFeatureSettings && fontBuffer) {
      featureGlyphIds = await collectFeatureGlyphIds(fontBuffer, text);
    }

    for (const targetFormat of formats) {
      const promiseId = getSubsetPromiseId(
        fontUsage,
        targetFormat,
        subsetInfo.variationAxes
      );

      if (!subsetPromiseMap.has(promiseId)) {
        const subsetCall =
          featureGlyphIds && featureGlyphIds.length > 0
            ? subsetFontWithGlyphs(fontBuffer, text, {
                targetFormat,
                glyphIds: featureGlyphIds,
                variationAxes: subsetInfo.variationAxes,
              })
            : subsetFont(fontBuffer, text, {
                targetFormat,
                variationAxes: subsetInfo.variationAxes,
              });

        subsetPromiseMap.set(
          promiseId,
          subsetCall.catch((err) => {
            const error = new Error(err.message);
            error.asset = fontAssetsByUrl.get(fontUrl);
            assetGraph.warn(error);
          })
        );
      }
    }
  }

  // Await all subset promises, then assign results synchronously to avoid
  // race conditions when multiple formats resolve concurrently.
  const promiseKeys = [...subsetPromiseMap.keys()];
  const promiseResults = await Promise.all(subsetPromiseMap.values());
  const resolvedSubsets = new Map();
  for (let i = 0; i < promiseKeys.length; i++) {
    resolvedSubsets.set(promiseKeys[i], promiseResults[i]);
  }

  assignSubsetResults(
    canonicalFontUsageByUrl,
    subsetResultsByFontUrl,
    resolvedSubsets,
    formats
  );

  propagateSubsets(
    htmlOrSvgAssetTextsWithProps,
    canonicalFontUsageByUrl,
    subsetResultsByFontUrl
  );

  return fontAssetsByUrl;
}

module.exports = {
  getSubsetPromiseId,
  getSubsetsForFontUsage,
};
