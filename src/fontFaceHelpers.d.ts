export function maybeCssQuote(value: string): string;
export function getFontFaceDeclarationText(
  rule: unknown,
  relations: unknown[]
): string;
export function getUnusedVariantsStylesheet(
  fontUsages: any[],
  accumulatedFontFaceDeclarations: any[]
): string;
export function getFontUsageStylesheet(fontUsages: any[]): string;
export function getCodepoints(text: string): number[];
export function cssAssetIsEmpty(cssAsset: any): boolean;
export function parseFontWeightRange(value: string): unknown;
export function parseFontStretchRange(value: string): unknown;
export function hashHexPrefix(value: Buffer | Uint8Array | string): string;
