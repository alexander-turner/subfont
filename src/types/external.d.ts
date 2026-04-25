// Ambient stubs for untyped npm dependencies. Each declaration covers
// only the methods and fields the converted source files actually touch —
// these are pragmatic shims, not exhaustive contracts.

declare module 'assetgraph' {
  export interface Asset {
    id: string | number;
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
    condition?: string;
    conditionalComments?: ReadonlyArray<unknown>;
    // For CssFontFaceSrc relations: the regex matching the original token
    // in the @font-face src value, so callers can rewrite it.
    tokenRegExp?: RegExp;
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
    // PostCSS Container methods exposed on at-rules. Only the slice we use:
    some(predicate: (node: PostCssNode) => boolean): boolean;
    append(decl: { prop: string; value: string }): void;
    remove?(): void;
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
    root(): AssetParseTree;
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

declare module 'jsdom' {
  export interface JSDOMWindow {
    document: any;
    close(): void;
  }
  export class JSDOM {
    constructor(html: string);
    window: JSDOMWindow;
  }
}

declare module 'fontverter' {
  export function convert(
    buffer: Buffer | Uint8Array,
    targetFormat: string,
    sourceFormat?: string
  ): Promise<Buffer>;
  export function detectFormat(buffer: Buffer | Uint8Array): string;
  const _default: {
    convert: typeof convert;
    detectFormat: typeof detectFormat;
  };
  export default _default;
}

declare module 'urltools' {
  export function urlOrFsPathToUrl(input: string, isDirectory: boolean): string;
  export function fileUrlToFsPath(url: string): string;
  export function findCommonUrlPrefix(urls: string[]): string;
  export function ensureTrailingSlash(url: string): string;
  export function resolveUrl(base: string, rel: string): string;
  export function buildRelativeUrl(base: string, target: string): string;
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

declare module 'postcss-value-parser' {
  export interface Node {
    type: string;
    value: string;
    before?: string;
    after?: string;
    quote?: string;
    nodes?: Node[];
  }
  export interface Root {
    nodes: Node[];
  }
  interface ParserFn {
    (value: string): Root;
    stringify(node: Node | Node[] | Root): string;
  }
  const parser: ParserFn;
  export = parser;
}

declare module 'memoizesync' {
  function memoizeSync<F extends (...args: any[]) => any>(fn: F): F;
  export = memoizeSync;
}

declare module 'lines-and-columns' {
  export class LinesAndColumns {
    constructor(source: string);
    locationForIndex(index: number): { line: number; column: number };
  }
  // Older default-export form used elsewhere in the codebase.
  const _default: { default: typeof LinesAndColumns };
  export default _default;
}

declare module 'font-snapper' {
  function fontSnapper(
    declarations: any[],
    props: Record<string, unknown>
  ): any | undefined;
  export = fontSnapper;
}

declare module 'font-snapper/lib/normalizeFontStretch' {
  function normalizeFontStretch(value: string): string;
  export = normalizeFontStretch;
}

declare module 'font-tracer' {
  function fontTracer(
    documentOrTree: any,
    options?: {
      stylesheetsWithPredicates?: any[];
      getCssRulesByProperty?: (...args: any[]) => any;
      asset?: any;
    }
  ): Array<{ text: string; props: Record<string, string> }>;
  export = fontTracer;
}

declare module 'css-font-weight-names' {
  const map: Record<string, string>;
  export = map;
}

declare module '@hookun/parse-animation-shorthand' {
  export interface ParsedAnimation {
    name: string;
    timingFunction: unknown;
    [key: string]: unknown;
  }
  export function parseSingle(value: string): { value: ParsedAnimation };
  export function serialize(value: Partial<ParsedAnimation>): string;
}

declare module 'specificity' {
  export interface SpecificityResult {
    selector: string;
    specificityArray: [number, number, number, number];
  }
  export function calculate(selector: string): SpecificityResult[];
}

declare module 'harfbuzzjs' {
  // harfbuzzjs is loaded via dynamic await require(); the module itself
  // resolves to a thenable. The exposed surface exercised by subfont is
  // captured in this shim.
  interface HBBlob {
    destroy(): void;
  }
  interface HBFace {
    collectUnicodes(): Iterable<number>;
    getAxisInfos(): Record<
      string,
      { min: number; max: number; default: number }
    >;
    getTableFeatureTags(table: string): Iterable<string>;
    destroy(): void;
  }
  interface HBFont {
    destroy(): void;
  }
  interface HBBuffer {
    addText(text: string): void;
    guessSegmentProperties(): void;
    json(font: HBFont): Array<{ g: number }>;
    destroy(): void;
  }
  export interface Harfbuzz {
    createBlob(buffer: ArrayBuffer | Uint8Array | Buffer): HBBlob;
    createFace(blob: HBBlob, index: number): HBFace;
    createFont(face: HBFace): HBFont;
    createBuffer(): HBBuffer;
    shapeWithTrace(
      font: HBFont,
      buffer: HBBuffer,
      features: string,
      a: number,
      b: number
    ): void;
  }
  const _default: Harfbuzz;
  export = _default;
}
