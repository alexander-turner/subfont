export function getVariationAxisBounds(
  fontAssetsByUrl: Map<string, any>,
  fontUrl: string,
  seenAxisValuesByFontUrlAndAxisName: Map<string, Map<string, Set<number>>>
): Promise<{
  variationAxes:
    | Record<string, number | { min: number; max: number; default?: number }>
    | undefined;
  fullyInstanced: boolean;
  numAxesPinned: number;
  numAxesReduced: number;
} | null>;

export function getVariationAxisUsage(
  htmlOrSvgAssetTextsWithProps: any[],
  parseFontWeightRange: (value: string) => unknown,
  parseFontStretchRange: (value: string) => unknown
): {
  seenAxisValuesByFontUrlAndAxisName: Map<string, Map<string, Set<number>>>;
};
