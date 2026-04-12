const fs = require('fs/promises');
const pathModule = require('path');
const crypto = require('crypto');
const subsetFont = require('subset-font');
const { getVariationAxisBounds } = require('./variationAxes');
const collectFeatureGlyphIds = require('./collectFeatureGlyphIds');
const subsetFontWithGlyphs = require('./subsetFontWithGlyphs');

function subsetCacheKey(
  fontBuffer,
  text,
  targetFormat,
  variationAxes,
  featureGlyphIds
) {
  const hash = crypto.createHash('sha256');
  hash.update(fontBuffer);
  hash.update(text);
  hash.update(targetFormat);
  if (variationAxes) hash.update(JSON.stringify(variationAxes));
  if (featureGlyphIds) hash.update(JSON.stringify(featureGlyphIds));
  return hash.digest('hex');
}

class SubsetDiskCache {
  constructor(cacheDir, console) {
    this._cacheDir = cacheDir;
    this._console = console;
    this._ensured = false;
    this._warnedWrite = false;
  }

  async _ensureDir() {
    if (!this._ensured) {
      // Only attempt once — persistent failures (bad path, permissions)
      // are far more common than transient ones, and retrying just
      // produces repeated warnings.
      this._ensured = true;
      try {
        await fs.mkdir(this._cacheDir, { recursive: true });
      } catch (err) {
        if (this._console) {
          this._console.warn(
            `subfont: cache directory ${this._cacheDir} could not be created: ${err.message}`
          );
        }
      }
    }
  }

  async get(key) {
    const filePath = pathModule.join(this._cacheDir, key);
    try {
      return await fs.readFile(filePath);
    } catch {
      return undefined;
    }
  }

  async set(key, buffer) {
    await this._ensureDir();
    const filePath = pathModule.join(this._cacheDir, key);
    try {
      await fs.writeFile(filePath, buffer);
    } catch (err) {
      if (this._warnedWrite) return;
      this._warnedWrite = true;
      if (this._console) {
        this._console.warn(
          `subfont: failed to write cache entry ${key}: ${err.message}`
        );
      }
    }
  }
}

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
  cacheDir = null,
  console = null
) {
  const diskCache = cacheDir ? new SubsetDiskCache(cacheDir, console) : null;

  // Collect one canonical fontUsage per font URL
  const canonicalFontUsageByUrl = new Map();
  for (const item of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of item.fontUsages) {
      if (
        fontUsage.fontUrl &&
        !canonicalFontUsageByUrl.has(fontUsage.fontUrl)
      ) {
        canonicalFontUsageByUrl.set(fontUsage.fontUrl, fontUsage);
      }
    }
  }

  const allFontUrls = [...canonicalFontUsageByUrl.keys()];

  // Load font assets
  await assetGraph.populate({
    followRelations: {
      to: { url: { $or: allFontUrls } },
    },
  });

  const fontAssetsByUrl = new Map();
  const originalFontBuffers = new Map();
  for (const fontUrl of allFontUrls) {
    const fontAsset = assetGraph.findAssets({
      url: fontUrl,
      isLoaded: true,
    })[0];
    if (fontAsset) {
      fontAssetsByUrl.set(fontUrl, fontAsset);
      originalFontBuffers.set(fontUrl, fontAsset.rawSrc);
    }
  }

  // Compute variation axis bounds for all fonts in parallel
  const fontUrlsWithAssets = allFontUrls.filter((url) =>
    fontAssetsByUrl.has(url)
  );
  const boundsResults = await Promise.all(
    fontUrlsWithAssets.map((fontUrl) =>
      getVariationAxisBounds(
        fontAssetsByUrl,
        fontUrl,
        seenAxisValuesByFontUrlAndAxisName
      )
    )
  );
  const variationAxisBoundsCache = new Map();
  for (let i = 0; i < fontUrlsWithAssets.length; i++) {
    variationAxisBoundsCache.set(fontUrlsWithAssets[i], boundsResults[i]);
  }

  const subsetPromiseMap = new Map();
  const subsetInfoByFontUrl = new Map();

  for (const [fontUrl, fontUsage] of canonicalFontUsageByUrl) {
    const fontBuffer = originalFontBuffers.get(fontUrl);
    if (!fontBuffer) continue;
    const text = fontUsage.text;

    const bounds = variationAxisBoundsCache.get(fontUrl);
    const subsetInfo = bounds
      ? {
          variationAxes: bounds.variationAxes,
          fullyInstanced: bounds.fullyInstanced,
          numAxesPinned: bounds.numAxesPinned,
          numAxesReduced: bounds.numAxesReduced,
        }
      : {
          variationAxes: undefined,
          fullyInstanced: false,
          numAxesPinned: 0,
          numAxesReduced: 0,
        };
    subsetInfoByFontUrl.set(fontUrl, subsetInfo);

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
        const cacheKey = diskCache
          ? subsetCacheKey(
              fontBuffer,
              text,
              targetFormat,
              subsetInfo.variationAxes,
              featureGlyphIds
            )
          : null;
        const cachedResult = diskCache ? await diskCache.get(cacheKey) : null;

        if (cachedResult) {
          subsetPromiseMap.set(promiseId, Promise.resolve(cachedResult));
        } else {
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
            subsetCall
              .then(async (result) => {
                if (diskCache && result) {
                  // Fire-and-forget: cache writes are best-effort.
                  // Errors are handled inside set(); the catch is a
                  // safety net against unhandled rejections.
                  diskCache.set(cacheKey, result).catch(() => {});
                }
                return result;
              })
              .catch((err) => {
                err.asset = err.asset || fontAssetsByUrl.get(fontUrl);
                assetGraph.warn(err);
              })
          );
        }
      }
    }
  }

  // Await all subset promises
  const resolvedSubsets = new Map(
    await Promise.all(
      [...subsetPromiseMap].map(async ([key, promise]) => [key, await promise])
    )
  );

  // Assign subset results to canonical font usages
  for (const [, fontUsage] of canonicalFontUsageByUrl) {
    const info = subsetInfoByFontUrl.get(fontUsage.fontUrl);
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
          fontUsage.variationAxes = info.variationAxes;
          fontUsage.fullyInstanced = info.fullyInstanced;
          fontUsage.numAxesPinned = info.numAxesPinned;
          fontUsage.numAxesReduced = info.numAxesReduced;
        }
      }
    }
  }

  // Propagate subsets to non-canonical font usages
  for (const item of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of item.fontUsages) {
      if (!fontUsage.fontUrl) continue;
      const canonical = canonicalFontUsageByUrl.get(fontUsage.fontUrl);
      if (canonical && canonical !== fontUsage && canonical.subsets) {
        const info = subsetInfoByFontUrl.get(fontUsage.fontUrl);
        fontUsage.subsets = canonical.subsets;
        fontUsage.smallestSubsetSize = canonical.smallestSubsetSize;
        fontUsage.smallestSubsetFormat = canonical.smallestSubsetFormat;
        fontUsage.variationAxes = info.variationAxes;
        fontUsage.fullyInstanced = info.fullyInstanced;
        fontUsage.numAxesPinned = info.numAxesPinned;
        fontUsage.numAxesReduced = info.numAxesReduced;
      }
    }
  }

  return fontAssetsByUrl;
}

module.exports = {
  getSubsetPromiseId,
  getSubsetsForFontUsage,
  // Exported for testing
  _subsetCacheKey: subsetCacheKey,
  _SubsetDiskCache: SubsetDiskCache,
};
