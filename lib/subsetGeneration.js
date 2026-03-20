const subsetFont = require('subset-font');
const { getVariationAxisBounds } = require('./variationAxes');

function getSubsetPromiseId(fontUsage, format, variationAxes = null) {
  return [
    fontUsage.text,
    fontUsage.fontUrl,
    format,
    JSON.stringify(variationAxes),
  ].join('\x1d');
}

async function getSubsetsForFontUsage(
  assetGraph,
  htmlOrSvgAssetTextsWithProps,
  formats,
  seenAxisValuesByFontUrlAndAxisName,
  instance = false
) {
  const allFontsSet = new Set();
  const allFonts = [];

  // Collect all unique fontUrls and compute the global text union per fontUrl.
  // Since fontUsage.text is already the uniqueChars union of all pages'
  // text for that font, all pages will have the same text for the same fontUrl.
  // We collect unique fontUsages to avoid iterating 385 pages × N fonts.
  const canonicalFontUsageByUrl = new Map();

  for (const item of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of item.fontUsages) {
      if (!fontUsage.fontUrl) {
        continue;
      }

      if (!allFontsSet.has(fontUsage.fontUrl)) {
        allFontsSet.add(fontUsage.fontUrl);
        allFonts.push(fontUsage.fontUrl);
        canonicalFontUsageByUrl.set(fontUsage.fontUrl, fontUsage);
      }
    }
  }

  await assetGraph.populate({
    followRelations: {
      to: { url: { $or: allFonts } },
    },
  });

  // Build a url->asset map for all font assets once, avoiding repeated
  // assetGraph.findAssets scans (each is O(allAssets)) in downstream code.
  const fontAssetsByUrl = new Map();
  const originalFontBuffers = {};
  for (const fontUrl of allFonts) {
    const fontAsset = assetGraph.findAssets({
      url: fontUrl,
      isLoaded: true,
    })[0];
    if (fontAsset) {
      fontAssetsByUrl.set(fontUrl, fontAsset);
      originalFontBuffers[fontUrl] = fontAsset.rawSrc;
    }
  }

  const subsetPromiseMap = {};

  // Subset once per unique fontUrl rather than iterating all pages.
  // Each fontUrl's text is the global union of all pages' characters,
  // so the subset result is the same regardless of which page we process.
  const subsetResultsByFontUrl = new Map();

  // Pre-compute all variation axis bounds concurrently before the subset loop.
  // Each getVariationAxisBounds call uses getFontInfo (harfbuzzjs WASM) which
  // is serialized internally, so callers can safely use Promise.all.
  const variationAxisBoundsCache = new Map();
  if (instance) {
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
      variationAxisBoundsCache.set(fontUrls[i], boundsResults[i]);
    }
  }

  for (const [fontUrl, fontUsage] of canonicalFontUsageByUrl) {
    const fontBuffer = originalFontBuffers[fontUrl];
    const text = fontUsage.text;
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

    const subsetInfo = {
      variationAxes,
      fullyInstanced,
      numAxesPinned,
      numAxesReduced,
    };
    subsetResultsByFontUrl.set(fontUrl, subsetInfo);

    for (const targetFormat of formats) {
      const promiseId = getSubsetPromiseId(
        fontUsage,
        targetFormat,
        variationAxes
      );

      if (!subsetPromiseMap[promiseId]) {
        subsetPromiseMap[promiseId] = subsetFont(fontBuffer, text, {
          targetFormat,
          variationAxes,
        }).catch((err) => {
          const error = new Error(err.message);
          error.asset = fontAssetsByUrl.get(fontUrl);

          assetGraph.warn(error);
        });
      }

      subsetPromiseMap[promiseId].then((subsetBuffer) => {
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
            fontUsage.variationAxes = variationAxes;
            fontUsage.fullyInstanced = fullyInstanced;
            fontUsage.numAxesPinned = numAxesPinned;
            fontUsage.numAxesReduced = numAxesReduced;
          }
        }
      });
    }
  }

  await Promise.all(Object.values(subsetPromiseMap));

  // Propagate subset results from canonical fontUsages to all pages' fontUsages.
  // This avoids re-subsetting — each page just gets a reference to the same buffer.
  for (const item of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of item.fontUsages) {
      if (!fontUsage.fontUrl) continue;
      const canonical = canonicalFontUsageByUrl.get(fontUsage.fontUrl);
      if (canonical && canonical !== fontUsage && canonical.subsets) {
        fontUsage.subsets = canonical.subsets;
        fontUsage.smallestSubsetSize = canonical.smallestSubsetSize;
        fontUsage.smallestSubsetFormat = canonical.smallestSubsetFormat;
        const info = subsetResultsByFontUrl.get(fontUsage.fontUrl);
        if (info) {
          fontUsage.variationAxes = info.variationAxes;
          fontUsage.fullyInstanced = info.fullyInstanced;
          fontUsage.numAxesPinned = info.numAxesPinned;
          fontUsage.numAxesReduced = info.numAxesReduced;
        }
      }
    }
  }

  return fontAssetsByUrl;
}

module.exports = {
  getSubsetPromiseId,
  getSubsetsForFontUsage,
};
