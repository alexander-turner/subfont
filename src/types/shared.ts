import type { Asset, Relation } from 'assetgraph';

export type VariationAxes =
  | Record<string, number | { min: number; max: number; default?: number }>
  | undefined;

export type AssetGraphError = Error & { asset?: Asset; relation?: Relation };
