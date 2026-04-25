declare function collectTextsByPage(
  assetGraph: any,
  htmlOrSvgAssets: any[],
  options: {
    text?: string;
    console?: Console | null;
    dynamic?: boolean;
    debug?: boolean;
    concurrency?: number;
    chromeArgs?: string[];
  }
): Promise<{
  htmlOrSvgAssetTextsWithProps: any[];
  fontFaceDeclarationsByHtmlOrSvgAsset: Map<any, any[]>;
  subTimings: Record<string, number | undefined>;
}>;
export = collectTextsByPage;
