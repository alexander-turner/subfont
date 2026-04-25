// Ambient stubs for untyped npm dependencies used by the six converted
// source files. The assetgraph surface is typed minimally — only the
// methods and fields the converted code actually touches — so our .ts
// sources can avoid bare `any` annotations.

declare module 'assetgraph' {
  export interface Asset {
    url: string;
    type?: string;
    rawSrc: Buffer;
    text: string;
    isLoaded?: boolean;
    isInline?: boolean;
    isInitial?: boolean;
    isDirty?: boolean;
    contentType?: string;
    baseName?: string;
    extension?: string;
    defaultExtension?: string;
    fileName?: string;
    md5Hex: string;
    nonInlineAncestor: Asset;
    urlOrDescription: string;
    incomingRelations: Relation[];
    outgoingRelations: Relation[];
    assetGraph: AssetGraph;
    parseTree: AssetParseTree;
    addRelation(
      spec: Record<string, unknown>,
      position?: string,
      ref?: Relation
    ): Relation;
    markDirty(): void;
    minify(): Promise<void> | void;
    inline(): void;
    unload(): void;
    eachRuleInParseTree(visit: (rule: CssRule) => void): void;
  }

  export interface Relation {
    type: string;
    from: Asset;
    to: Asset;
    hrefType?: string;
    media?: string;
    crossorigin?: boolean;
    node: PostCssNode;
    detach(): void;
    remove(): void;
    inline(): void;
    omitFunctionCall(): void;
  }

  // Loose stand-ins for the postcss / DOM trees AssetGraph exposes —
  // each one is consumed by walk-callbacks where the runtime shape
  // is enforced by the upstream library.
  export interface PostCssNode {
    type?: string;
    prop?: string;
    value?: string;
    parent?: PostCssNode;
    parentNode?: { removeChild(node: PostCssNode): void };
    nodes?: PostCssNode[];
    name?: string;
    params?: string;
    outerHTML?: string;
    walkDecls(cb: (decl: PostCssDecl) => void): void;
    removeChild(child: PostCssNode): void;
  }

  export interface PostCssDecl {
    prop: string;
    value: string;
  }

  export interface CssRule {
    type: string;
    prop: string;
    value: string;
    parent: { type: string };
    root(): unknown;
  }

  export interface AssetParseTree {
    querySelectorAll(selector: string): ArrayLike<SvgElement>;
  }

  export interface SvgElement {
    getAttribute(name: string): string;
    setAttribute(name: string, value: string): void;
  }

  export interface AssetQuery {
    [key: string]: unknown;
  }

  export interface RelationQuery {
    [key: string]: unknown;
  }

  export interface PopulateOptions {
    followRelations?: Record<string, unknown>;
    [key: string]: unknown;
  }

  export interface AssetGraphConfig {
    root?: string;
    canonicalRoot?: string;
  }

  export class AssetGraph {
    constructor(config: AssetGraphConfig);
    root: string;
    findAssets(query?: AssetQuery): Asset[];
    findRelations(query?: RelationQuery): Relation[];
    populate(opts: PopulateOptions): Promise<void>;
    loadAssets(urls: string[]): Promise<void>;
    addAsset(opts: Record<string, unknown>): Asset;
    removeAsset(asset: Asset): void;
    moveAssets(
      query: AssetQuery,
      fn: (asset: Asset, graph: AssetGraph) => string
    ): Promise<void>;
    writeAssetsToDisc(
      query: AssetQuery,
      outRoot?: string,
      fromRoot?: string
    ): Promise<void>;
    serializeSourceMaps(
      arg: undefined,
      query: Record<string, unknown>
    ): Promise<void>;
    applySourceMaps(query: Record<string, unknown>): Promise<void>;
    resolveUrl(base: string, rel: string): string;
    buildHref(
      target: string,
      base: string,
      opts?: { hrefType?: string }
    ): string;
    info(err: Error): void;
    warn(err: Error): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
    emit(event: string, ...args: unknown[]): boolean;
    logEvents(opts: {
      console?: Console;
      stopOnWarning?: boolean;
    }): Promise<void>;
  }

  export = AssetGraph;
}

declare module 'assetgraph/lib/compileQuery' {
  const compileQuery: (query: unknown) => (input: unknown) => boolean;
  export = compileQuery;
}

declare module 'fontverter' {
  export function convert(
    buffer: Buffer | Uint8Array,
    targetFormat: string,
    sourceFormat?: string
  ): Promise<Buffer>;
  const _default: { convert: typeof convert };
  export default _default;
}

declare module 'urltools' {
  export function urlOrFsPathToUrl(input: string, isDirectory: boolean): string;
  export function fileUrlToFsPath(url: string): string;
  export function findCommonUrlPrefix(urls: string[]): string;
  export function ensureTrailingSlash(url: string): string;
}

declare module 'sanitize-filename' {
  function sanitize(input: string, options?: { replacement?: string }): string;
  export = sanitize;
}

declare module '@gustavnikolaj/async-main-wrap' {
  type AnyAsyncFn = (...args: any[]) => Promise<unknown>;
  const asyncMainWrap: <F extends AnyAsyncFn>(
    fn: F,
    options?: { processError?: (err: Error) => unknown }
  ) => (...args: Parameters<F>) => void;
  export = asyncMainWrap;
}

declare module 'css-font-parser' {
  export function parseFontFamily(value: string): string[];
  export interface ParsedFont {
    'font-family': string[];
    'font-style'?: string;
    'font-weight'?: string;
    'font-stretch'?: string;
    'font-size': string;
    'line-height'?: string;
  }
  export function parseFont(value: string): ParsedFont | null;
}

declare module 'css-list-helpers' {
  export function splitByCommas(value: string): string[];
}
