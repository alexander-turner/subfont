const fs = require('fs/promises');
const pathModule = require('path');
const crypto = require('crypto');
const { getVariationAxisBounds } = require('./variationAxes');
const collectFeatureGlyphIds = require('./collectFeatureGlyphIds');
const subsetFontWithGlyphs = require('./subsetFontWithGlyphs');

// Bump when subsetting behaviour changes to invalidate stale disk-cache
// entries (e.g. after adding hinting removal or table stripping).
const SUBSET_CACHE_VERSION = '3';

// Cache the SHA-256 hash state after feeding SUBSET_CACHE_VERSION + fontBuffer.
// For a font with 2 target formats this halves the hashing work on large buffers.
// Uses WeakMap so entries are garbage-collected when the buffer is released.
const fontBufferHashPrefixes = new WeakMap();
function getFontBufferHashPrefix(fontBuffer) {
  if (!fontBufferHashPrefixes.has(fontBuffer)) {
    const hash = crypto.createHash('sha256');
    hash.update(SUBSET_CACHE_VERSION);
    hash.update(fontBuffer);
    fontBufferHashPrefixes.set(fontBuffer, hash);
  }
  return fontBufferHashPrefixes.get(fontBuffer);
}

function subsetCacheKey(
  fontBuffer,
  text,
  targetFormat,
  variationAxes,
  featureGlyphIds
) {
  // Clone the pre-computed prefix (version + font buffer) and append
  // the remaining fields. hash.copy() is O(1) — just copies the
  // internal digest state, avoiding re-hashing the entire font buffer.
  const hash = getFontBufferHashPrefix(fontBuffer).copy();
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
      // If the directory was removed after init, retry once
      if (err.code === 'ENOENT') {
        try {
          await fs.mkdir(this._cacheDir, { recursive: true });
          await fs.writeFile(filePath, buffer);
          return;
        } catch {
          // Fall through to warning below
        }
      }
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

  // Process fonts concurrently — each font's feature glyph collection
  // and subset queuing run in parallel, so fonts without feature settings
  // don't wait behind fonts that need collectFeatureGlyphIds.
  await Promise.all(
    [...canonicalFontUsageByUrl].map(async ([fontUrl, fontUsage]) => {
      const fontBuffer = originalFontBuffers.get(fontUrl);
      if (!fontBuffer) return;
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
        featureGlyphIds = await collectFeatureGlyphIds(
          fontBuffer,
          text,
          fontUsage.fontFeatureTags
        );
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
            const subsetCall = subsetFontWithGlyphs(fontBuffer, text, {
              targetFormat,
              glyphIds: featureGlyphIds,
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
    })
  );

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
