import * as fs from 'fs/promises';
import pathModule = require('path');
import * as crypto from 'crypto';
import type { Asset, AssetGraph } from 'assetgraph';
import type { VariationAxes, AssetGraphError } from './types/shared';
import { getVariationAxisBounds } from './variationAxes';
import collectFeatureGlyphIds = require('./collectFeatureGlyphIds');
import subsetFontWithGlyphs = require('./subsetFontWithGlyphs');
import {
  pageNeedsMathTable,
  pageNeedsColorTables,
} from './codepointHeuristics';

// Bump when subsetting behaviour changes to invalidate stale disk-cache
// entries (e.g. after adding hinting removal or table stripping).
const SUBSET_CACHE_VERSION = '4';

type FontBuffer = Buffer | Uint8Array;

interface FontUsage {
  text: string;
  pageText?: string;
  fontUrl?: string;
  hasFontFeatureSettings?: boolean;
  fontFeatureTags?: Iterable<string>;
  subsets?: Record<string, Buffer>;
  smallestSubsetSize?: number;
  smallestSubsetFormat?: string;
  variationAxes?: VariationAxes;
  fullyInstanced?: boolean;
  numAxesPinned?: number;
  numAxesReduced?: number;
}

interface AssetTextWithProps {
  fontUsages: FontUsage[];
}

interface SubsetInfo {
  variationAxes: VariationAxes;
  fullyInstanced: boolean;
  numAxesPinned: number;
  numAxesReduced: number;
}

// Cache the SHA-256 hash state after feeding SUBSET_CACHE_VERSION + fontBuffer.
// For a font with 2 target formats this halves the hashing work on large buffers.
// Uses WeakMap so entries are garbage-collected when the buffer is released.
const fontBufferHashPrefixes = new WeakMap<FontBuffer, crypto.Hash>();
function getFontBufferHashPrefix(fontBuffer: FontBuffer): crypto.Hash {
  let cached = fontBufferHashPrefixes.get(fontBuffer);
  if (!cached) {
    cached = crypto.createHash('sha256');
    cached.update(SUBSET_CACHE_VERSION);
    cached.update(fontBuffer);
    fontBufferHashPrefixes.set(fontBuffer, cached);
  }
  return cached;
}

// Concrete enough for our use; widen if we plumb non-boolean knobs through.
type ExtraSubsetCacheOptions = Record<string, boolean>;

function subsetCacheKey(
  fontBuffer: FontBuffer,
  text: string,
  targetFormat: string,
  variationAxes: VariationAxes,
  featureGlyphIds: number[] | undefined,
  extraOptions: ExtraSubsetCacheOptions | undefined = undefined
): string {
  // Clone the pre-computed prefix (version + font buffer) and append
  // the remaining fields. hash.copy() is O(1) — just copies the
  // internal digest state, avoiding re-hashing the entire font buffer.
  const hash = getFontBufferHashPrefix(fontBuffer).copy();
  hash.update(text);
  hash.update(targetFormat);
  if (variationAxes) hash.update(JSON.stringify(variationAxes));
  if (featureGlyphIds) hash.update(JSON.stringify(featureGlyphIds));
  if (extraOptions) hash.update(JSON.stringify(extraOptions));
  return hash.digest('hex');
}

class SubsetDiskCache {
  private _cacheDir: string;
  private _console: Console | null;
  private _ensured: boolean;
  private _warnedWrite: boolean;

  constructor(cacheDir: string, console: Console | null | undefined) {
    this._cacheDir = cacheDir;
    this._console = console ?? null;
    this._ensured = false;
    this._warnedWrite = false;
  }

  private async _ensureDir(): Promise<void> {
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
            `subfont: cache directory ${this._cacheDir} could not be created: ${(err as Error).message}`
          );
        }
      }
    }
  }

  async get(key: string): Promise<Buffer | undefined> {
    const filePath = pathModule.join(this._cacheDir, key);
    try {
      return await fs.readFile(filePath);
    } catch {
      return undefined;
    }
  }

  async set(key: string, buffer: Buffer): Promise<void> {
    await this._ensureDir();
    const filePath = pathModule.join(this._cacheDir, key);
    try {
      await fs.writeFile(filePath, buffer);
    } catch (err) {
      const errno = err as NodeJS.ErrnoException;
      // If the directory was removed after init, retry once
      if (errno.code === 'ENOENT') {
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
          `subfont: failed to write cache entry ${key}: ${errno.message}`
        );
      }
    }
  }
}

export function getSubsetPromiseId(
  fontUsage: FontUsage,
  format: string,
  variationAxes: VariationAxes | null = null
): string {
  return [
    fontUsage.text,
    fontUsage.fontUrl,
    format,
    JSON.stringify(variationAxes),
  ].join('\x1d');
}

export async function getSubsetsForFontUsage(
  assetGraph: AssetGraph,
  htmlOrSvgAssetTextsWithProps: AssetTextWithProps[],
  formats: string[],
  seenAxisValuesByFontUrlAndAxisName: Map<string, Map<string, Set<number>>>,
  cacheDir: string | null = null,
  console: Console | null = null,
  debug = false
): Promise<Map<string, Asset>> {
  const diskCache = cacheDir ? new SubsetDiskCache(cacheDir, console) : null;
  const cacheStats = diskCache ? { hits: 0, misses: 0 } : null;

  // Collect one canonical fontUsage per font URL
  const canonicalFontUsageByUrl = new Map<string, FontUsage>();
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

  const fontAssetsByUrl = new Map<string, Asset>();
  const originalFontBuffers = new Map<string, FontBuffer>();
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
  const variationAxisBoundsCache = new Map<
    string,
    Awaited<ReturnType<typeof getVariationAxisBounds>>
  >();
  for (let i = 0; i < fontUrlsWithAssets.length; i++) {
    variationAxisBoundsCache.set(fontUrlsWithAssets[i], boundsResults[i]);
  }

  const subsetPromiseMap = new Map<string, Promise<Buffer | null>>();
  const subsetInfoByFontUrl = new Map<string, SubsetInfo>();

  // Process fonts concurrently — each font's feature glyph collection
  // and subset queuing run in parallel, so fonts without feature settings
  // don't wait behind fonts that need collectFeatureGlyphIds.
  await Promise.all(
    [...canonicalFontUsageByUrl].map(async ([fontUrl, fontUsage]) => {
      const fontBuffer = originalFontBuffers.get(fontUrl);
      if (!fontBuffer) return;
      const text = fontUsage.text;

      const bounds = variationAxisBoundsCache.get(fontUrl);
      const subsetInfo: SubsetInfo = bounds
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

      let featureGlyphIds: number[] | undefined;
      if (fontUsage.hasFontFeatureSettings) {
        try {
          featureGlyphIds = await collectFeatureGlyphIds(
            fontBuffer,
            text,
            fontUsage.fontFeatureTags
          );
        } catch (rawErr) {
          // Feature glyph collection failed — continue without feature
          // glyphs rather than blocking all fonts (Promise.all would
          // reject entirely if this propagated).
          const err =
            rawErr instanceof Error
              ? (rawErr as AssetGraphError)
              : new Error(String(rawErr));
          (err as AssetGraphError).asset =
            (err as AssetGraphError).asset || fontAssetsByUrl.get(fontUrl);
          assetGraph.warn(err as AssetGraphError);
        }
      }

      // Drop optional metric tables when the page text doesn't reference
      // codepoints those tables exist to support. False positives (keeping
      // a table the page doesn't need) cost a few hundred bytes; false
      // negatives (dropping a needed table) break rendering, so the
      // heuristics err on the side of keeping.
      const dropMathTable = !pageNeedsMathTable(text);
      const dropColorTables = !pageNeedsColorTables(text);

      for (const targetFormat of formats) {
        const promiseId = getSubsetPromiseId(
          fontUsage,
          targetFormat,
          subsetInfo.variationAxes
        );

        if (!subsetPromiseMap.has(promiseId)) {
          const extraCacheOptions = { dropMathTable, dropColorTables };
          const cacheKey = diskCache
            ? subsetCacheKey(
                fontBuffer,
                text,
                targetFormat,
                subsetInfo.variationAxes,
                featureGlyphIds,
                extraCacheOptions
              )
            : null;
          const cachedResult =
            diskCache && cacheKey ? await diskCache.get(cacheKey) : null;

          if (cachedResult) {
            if (cacheStats) cacheStats.hits++;
            subsetPromiseMap.set(promiseId, Promise.resolve(cachedResult));
          } else {
            if (cacheStats) cacheStats.misses++;
            // Targeted feature retention when we can fully enumerate the
            // CSS-requested feature tags. If the page declares feature
            // settings but the tags couldn't be extracted (e.g. resolution
            // through CSS custom-property var() chains is incomplete),
            // fall back to retain-all so we don't drop features the page
            // actually uses.
            const featureTags =
              fontUsage.hasFontFeatureSettings && !fontUsage.fontFeatureTags
                ? undefined
                : fontUsage.fontFeatureTags
                  ? [...fontUsage.fontFeatureTags]
                  : [];
            const subsetCall = subsetFontWithGlyphs(fontBuffer, text, {
              targetFormat,
              glyphIds: featureGlyphIds,
              variationAxes: subsetInfo.variationAxes,
              featureTags,
              dropMathTable,
              dropColorTables,
            });

            subsetPromiseMap.set(
              promiseId,
              subsetCall
                .then(async (result) => {
                  if (diskCache && result && cacheKey) {
                    // Fire-and-forget: cache writes are best-effort.
                    // Errors are handled inside set(); the catch is a
                    // safety net against unhandled rejections.
                    diskCache.set(cacheKey, result).catch(() => {});
                  }
                  return result;
                })
                .catch((rawErr) => {
                  const err =
                    rawErr instanceof Error
                      ? (rawErr as AssetGraphError)
                      : new Error(String(rawErr));
                  (err as AssetGraphError).asset =
                    (err as AssetGraphError).asset ||
                    fontAssetsByUrl.get(fontUrl);
                  assetGraph.warn(err as AssetGraphError);
                  return null;
                })
            );
          }
        }
      }
    })
  );

  // Await all subset promises
  const resolvedSubsets = new Map<string, Buffer | null>(
    await Promise.all(
      [...subsetPromiseMap].map(
        async ([key, promise]) =>
          [key, await promise] as [string, Buffer | null]
      )
    )
  );

  if (cacheStats && debug && console) {
    const total = cacheStats.hits + cacheStats.misses;
    const pct = total > 0 ? Math.round((cacheStats.hits * 100) / total) : 0;
    console.log(
      `[subfont timing]   subset disk cache: ${cacheStats.hits} hit${cacheStats.hits === 1 ? '' : 's'}, ${cacheStats.misses} miss${cacheStats.misses === 1 ? '' : 'es'} (${pct}% hit rate)`
    );
  }

  // Assign subset results to canonical font usages
  for (const [, fontUsage] of canonicalFontUsageByUrl) {
    const info = subsetInfoByFontUrl.get(fontUsage.fontUrl as string);
    if (!info) continue;
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
        if (!info) continue;
        // Shallow-copy so per-page mutation of one fontUsage's subsets
        // doesn't leak into the canonical entry or other pages.
        fontUsage.subsets = { ...canonical.subsets };
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

// Exported for testing
export {
  subsetCacheKey as _subsetCacheKey,
  SubsetDiskCache as _SubsetDiskCache,
};
