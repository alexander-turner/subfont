declare function collectFeatureGlyphIds(
  fontBuffer: Buffer | Uint8Array,
  text: string,
  fontFeatureTags: Iterable<string> | null | undefined
): Promise<number[]>;
export = collectFeatureGlyphIds;
