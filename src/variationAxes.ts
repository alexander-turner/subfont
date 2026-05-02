import getFontInfo = require('./getFontInfo');
import parseFontVariationSettings = require('./parseFontVariationSettings');

// CSS oblique without an explicit <angle> defaults to 14deg. The OpenType slnt
// axis uses the opposite sign convention (positive = counter-clockwise), so
// CSS maps oblique to slnt -14.
const DEFAULT_OBLIQUE_SLNT = -14;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function renderNumberRange(min: number, max: number): string {
  if (min === max) {
    return String(min);
  } else {
    return `${min}-${max}`;
  }
}

interface FontUsageLike {
  fontUrl: string;
  fontStyles: Set<string>;
  fontWeights: Set<number>;
  fontStretches: Set<number>;
  fontVariationSettings: Iterable<string>;
  props: Record<string, string | undefined>;
}

interface AssetTextEntry {
  fontUsages: FontUsageLike[];
}

export interface VariationAxisUsageResult {
  seenAxisValuesByFontUrlAndAxisName: Map<string, Map<string, Set<number>>>;
}

type RangeFn = (value: string | undefined) => [number, number];

export function getVariationAxisUsage(
  htmlOrSvgAssetTextsWithProps: AssetTextEntry[],
  parseFontWeightRange: RangeFn,
  parseFontStretchRange: RangeFn
): VariationAxisUsageResult {
  const seenAxisValuesByFontUrlAndAxisName = new Map<
    string,
    Map<string, Set<number>>
  >();

  function noteUsedValue(
    fontUrl: string,
    axisName: string,
    axisValue: number
  ): void {
    let seenAxes = seenAxisValuesByFontUrlAndAxisName.get(fontUrl);
    if (!seenAxes) {
      seenAxes = new Map();
      seenAxisValuesByFontUrlAndAxisName.set(fontUrl, seenAxes);
    }
    const existing = seenAxes.get(axisName);
    if (existing) {
      existing.add(axisValue);
    } else {
      seenAxes.set(axisName, new Set([axisValue]));
    }
  }

  // Since fontUsages are built from shared templates, all pages produce
  // the same fontStyles/fontWeights/etc. for a given fontUrl. Process
  // each unique fontUrl only once to avoid num_pages × redundant iterations.
  const seenFontUrls = new Set<string>();
  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const {
      fontUrl,
      fontStyles,
      fontWeights,
      fontStretches,
      fontVariationSettings,
      props,
    } of fontUsages) {
      if (seenFontUrls.has(fontUrl)) continue;
      seenFontUrls.add(fontUrl);
      if (fontStyles.has('italic')) {
        noteUsedValue(fontUrl, 'ital', 1);
      }
      // If any font-style value except italic is seen (including normal or oblique)
      // we're also utilizing value 0:
      if (fontStyles.size > (fontStyles.has('italic') ? 1 : 0)) {
        noteUsedValue(fontUrl, 'ital', 0);
      }
      if (fontStyles.has('oblique')) {
        noteUsedValue(fontUrl, 'slnt', DEFAULT_OBLIQUE_SLNT);
      }
      // If any font-style value except oblique is seen (including normal or italic)
      // we're also utilizing value 0:
      if (fontStyles.size > (fontStyles.has('oblique') ? 1 : 0)) {
        noteUsedValue(fontUrl, 'slnt', 0);
      }

      const minMaxFontWeight = parseFontWeightRange(props['font-weight']);
      for (const fontWeight of fontWeights) {
        noteUsedValue(fontUrl, 'wght', clamp(fontWeight, ...minMaxFontWeight));
      }

      const minMaxFontStretch = parseFontStretchRange(props['font-stretch']);
      for (const fontStretch of fontStretches) {
        noteUsedValue(
          fontUrl,
          'wdth',
          clamp(fontStretch, ...minMaxFontStretch)
        );
      }

      for (const fontVariationSettingsValue of fontVariationSettings) {
        for (const [axisName, axisValue] of parseFontVariationSettings(
          fontVariationSettingsValue
        )) {
          noteUsedValue(fontUrl, axisName, axisValue);
        }
      }
    }
  }

  return { seenAxisValuesByFontUrlAndAxisName };
}

interface FontAssetLike {
  rawSrc: Buffer | Uint8Array;
}

export interface VariationAxisBounds {
  fullyInstanced: boolean;
  numAxesPinned: number;
  numAxesReduced: number;
  variationAxes: Record<
    string,
    number | { min: number; max: number; default?: number }
  >;
}

export async function getVariationAxisBounds(
  fontAssetsByUrl: Map<string, FontAssetLike>,
  fontUrl: string,
  seenAxisValuesByFontUrlAndAxisName: Map<string, Map<string, Set<number>>>
): Promise<VariationAxisBounds> {
  let fontInfo;
  try {
    const asset = fontAssetsByUrl.get(fontUrl);
    if (!asset) {
      return {
        fullyInstanced: false,
        numAxesPinned: 0,
        numAxesReduced: 0,
        variationAxes: {},
      };
    }
    fontInfo = await getFontInfo(asset.rawSrc);
  } catch {
    // Invalid font -- skip instancing, return safe defaults
    return {
      fullyInstanced: false,
      numAxesPinned: 0,
      numAxesReduced: 0,
      variationAxes: {},
    };
  }

  const variationAxes: Record<
    string,
    number | { min: number; max: number; default?: number }
  > = {};
  let fullyInstanced = true;
  let numAxesPinned = 0;
  let numAxesReduced = 0;
  const fontVariationEntries = Object.entries(fontInfo.variationAxes);
  const seenAxisValuesByAxisName =
    seenAxisValuesByFontUrlAndAxisName.get(fontUrl);
  if (fontVariationEntries.length > 0 && seenAxisValuesByAxisName) {
    for (const [
      axisName,
      { min, max, default: defaultValue },
    ] of fontVariationEntries) {
      let seenAxisValues = seenAxisValuesByAxisName.get(axisName);
      if (!seenAxisValues) {
        seenAxisValues = new Set([defaultValue]);
      }
      if (seenAxisValues.size === 1) {
        const [only] = seenAxisValues;
        variationAxes[axisName] = clamp(only, min, max);
        numAxesPinned += 1;
      } else {
        let minSeenValue = Infinity;
        let maxSeenValue = -Infinity;
        for (const v of seenAxisValues) {
          if (v < minSeenValue) minSeenValue = v;
          if (v > maxSeenValue) maxSeenValue = v;
        }
        variationAxes[axisName] = {
          min: Math.max(minSeenValue, min),
          max: Math.min(maxSeenValue, max),
        };
        fullyInstanced = false;
        if (minSeenValue > min || maxSeenValue < max) {
          numAxesReduced += 1;
        }
      }
    }
  }
  return { fullyInstanced, numAxesPinned, numAxesReduced, variationAxes };
}
