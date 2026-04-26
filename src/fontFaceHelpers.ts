import * as crypto from 'crypto';
import stripLocalTokens = require('./stripLocalTokens');
import unicodeRange = require('./unicodeRange');
import normalizeFontPropertyValue = require('./normalizeFontPropertyValue');

const contentTypeByFontFormat: Record<string, string> = {
  woff: 'font/woff', // https://tools.ietf.org/html/rfc8081#section-4.4.5
  woff2: 'font/woff2',
  truetype: 'font/ttf',
};

export function stringifyFontFamily(name: string): string {
  if (/[^a-z0-9_-]/i.test(name)) {
    return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  } else {
    return name;
  }
}

export function maybeCssQuote(value: string): string {
  // CSS identifiers must start with a letter or underscore (or hyphen
  // followed by a letter/underscore), not a digit or bare hyphen.
  if (/^[a-zA-Z_][a-zA-Z0-9_-]*$|^-[a-zA-Z_][a-zA-Z0-9_-]*$/.test(value)) {
    return value;
  } else {
    return `'${value.replace(/'/g, "\\'")}'`;
  }
}

interface CssFontFaceRelation {
  format?: string;
  to: { type?: string; url: string };
}

export function getPreferredFontUrl(
  cssFontFaceSrcRelations: CssFontFaceRelation[] = []
): string | undefined {
  // Priority: woff2 > woff > truetype > opentype, preferring explicit
  // format() declarations over asset-type guesses.
  const formatPriority: Record<string, number> = {
    woff2: 0,
    woff: 1,
    truetype: 2,
    opentype: 3,
  };
  const typePriority: Record<string, number> = {
    Woff2: 4,
    Woff: 5,
    Ttf: 6,
    Otf: 7,
  };

  let bestUrl: string | undefined;
  let bestPriority = Infinity;

  for (const r of cssFontFaceSrcRelations) {
    let priority: number | undefined;
    if (r.format) {
      priority = formatPriority[r.format.toLowerCase()];
    }
    if (priority === undefined && r.to.type) {
      priority = typePriority[r.to.type];
    }
    if (priority !== undefined && priority < bestPriority) {
      bestPriority = priority;
      bestUrl = r.to.url;
    }
  }

  return bestUrl;
}

interface RelationWithHrefType {
  hrefType?: string;
}

interface PostCssToString {
  toString(): string;
}

// Temporarily switch all relation hrefs to absolute so that
// node.toString() emits fully-qualified URLs in the @font-face src.
export function getFontFaceDeclarationText(
  node: PostCssToString,
  relations: RelationWithHrefType[]
): string {
  const originalHrefTypeByRelation = new Map<
    RelationWithHrefType,
    string | undefined
  >();
  for (const relation of relations) {
    originalHrefTypeByRelation.set(relation, relation.hrefType);
    relation.hrefType = 'absolute';
  }

  const text = node.toString();
  // Put the hrefTypes that were set to absolute back to their original state:
  for (const [
    relation,
    originalHrefType,
  ] of originalHrefTypeByRelation.entries()) {
    relation.hrefType = originalHrefType;
  }
  return text;
}

const fontOrder = ['woff2', 'woff', 'truetype'];

// Cache base64-encoded data URIs keyed by the underlying Buffer. Subset
// buffers are shared across pages (propagated from the canonical fontUsage),
// so without this every page re-encodes the same multi-hundred-KB buffer.
const subsetDataUrlCache = new WeakMap<
  object,
  Array<{ format: string; url: string }>
>();
function getSubsetDataUrls(
  subsetsObj: Record<string, Buffer>
): Array<{ format: string; url: string }> {
  const cached = subsetDataUrlCache.get(subsetsObj);
  if (cached) return cached;
  const result = fontOrder
    .filter((format) => subsetsObj[format])
    .map((format) => ({
      format,
      url: `data:${contentTypeByFontFormat[format]};base64,${subsetsObj[
        format
      ].toString('base64')}`,
    }));
  subsetDataUrlCache.set(subsetsObj, result);
  return result;
}

interface FontUsageLike {
  subsets?: Record<string, Buffer>;
  props: Record<string, string | number>;
  codepoints: { used: number[]; original: number[] };
  fontFamilies: Set<string>;
}

export function getFontFaceForFontUsage(fontUsage: FontUsageLike): string {
  const subsets = getSubsetDataUrls(
    fontUsage.subsets as Record<string, Buffer>
  );

  const resultString: string[] = ['@font-face {'];

  resultString.push(
    ...Object.keys(fontUsage.props)
      .sort()
      .map((prop) => {
        let value: string | number = fontUsage.props[prop];

        if (prop === 'font-family') {
          value = maybeCssQuote(`${value}__subset`);
        }

        if (prop === 'src') {
          value = subsets
            .map((subset) => `url(${subset.url}) format('${subset.format}')`)
            .join(', ');
        }

        return `${prop}: ${value};`;
      })
      .map((str) => `  ${str}`)
  );

  // Intersect used codepoints with original (font's character set) so
  // the unicode-range only advertises characters actually in the subset.
  let effectiveUsedCodepoints = fontUsage.codepoints.used;
  if (
    fontUsage.codepoints.original &&
    fontUsage.codepoints.original.length > 0
  ) {
    const originalSet = new Set(fontUsage.codepoints.original);
    const filtered = fontUsage.codepoints.used.filter((cp) =>
      originalSet.has(cp)
    );
    if (filtered.length > 0) {
      effectiveUsedCodepoints = filtered;
    }
  }
  resultString.push(
    `  unicode-range: ${unicodeRange(effectiveUsedCodepoints)};`
  );

  resultString.push('}');

  return resultString.join('\n');
}

interface UnusedDeclaration {
  // collectFontFaceDeclarations only emits rows with both, but the upstream
  // shape (FontFaceDeclaration) keeps these optional — runtime invariant is
  // that they're populated by the time we reach this stylesheet generator.
  src?: string;
  relations: Array<{
    to: { url: string };
    tokenRegExp?: RegExp;
  }>;
  'font-family'?: string;
  'font-style'?: string;
  'font-weight'?: string;
  'font-stretch'?: string;
  'unicode-range'?: string;
  'size-adjust'?: string;
  'ascent-override'?: string;
  'descent-override'?: string;
  'line-gap-override'?: string;
  // assetgraph forwards every CSS @font-face descriptor through this map;
  // values surface as strings or numeric defaults from initialValueByProp.
  // eslint-disable-next-line no-restricted-syntax
  [key: string]: unknown;
}

export function getUnusedVariantsStylesheet(
  fontUsages: FontUsageLike[],
  accumulatedFontFaceDeclarations: UnusedDeclaration[]
): string {
  // Find the available @font-face declarations where the font-family is used
  // (so there will be subsets created), but the specific variant isn't used.
  return accumulatedFontFaceDeclarations
    .filter(
      (decl) =>
        decl['font-family'] &&
        fontUsages.some((fontUsage) =>
          fontUsage.fontFamilies.has(decl['font-family'] as string)
        ) &&
        !fontUsages.some(
          ({ props }) =>
            props['font-style'] === decl['font-style'] &&
            props['font-weight'] === decl['font-weight'] &&
            props['font-stretch'] === decl['font-stretch'] &&
            (props['font-family'] as string).toLowerCase() ===
              (decl['font-family'] as string).toLowerCase()
        )
    )
    .map((props) => {
      let src = stripLocalTokens(props.src ?? '');
      const tokenRe = props.relations[0]?.tokenRegExp;
      if (props.relations.length > 0 && tokenRe) {
        const targets = props.relations.map((relation) => relation.to.url);
        src = src.replace(
          tokenRe,
          () => `url('${(targets.shift() as string).replace(/'/g, "\\'")}')`
        );
      }
      let rule = `@font-face{font-family:${maybeCssQuote(`${props['font-family']}__subset`)};font-stretch:${props['font-stretch']};font-style:${props['font-style']};font-weight:${props['font-weight']};src:${src}`;
      if (props['unicode-range']) {
        rule += `;unicode-range:${props['unicode-range']}`;
      }
      // Preserve @font-face metric descriptors used for CLS optimization
      for (const descriptor of [
        'size-adjust',
        'ascent-override',
        'descent-override',
        'line-gap-override',
      ] as const) {
        if (props[descriptor]) {
          rule += `;${descriptor}:${props[descriptor]}`;
        }
      }
      rule += '}';
      return rule;
    })
    .join('');
}

export function getFontUsageStylesheet(fontUsages: FontUsageLike[]): string {
  return fontUsages
    .filter((fontUsage) => fontUsage.subsets)
    .map((fontUsage) => getFontFaceForFontUsage(fontUsage))
    .join('');
}

export function getCodepoints(text: string): number[] {
  const codepointSet = new Set<number>();
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp !== undefined) codepointSet.add(cp);
  }

  // Make sure that space is always part of the subset fonts (and that it's announced in unicode-range).
  // Prevents Chrome from going off and downloading the fallback:
  // https://gitter.im/assetgraph/assetgraph?at=5f01f6e13a0d3931fad4021b
  codepointSet.add(32);

  return [...codepointSet];
}

export function cssAssetIsEmpty(cssAsset: {
  parseTree: { nodes?: Array<{ type: string; text?: string }> };
}): boolean {
  const nodes = cssAsset.parseTree.nodes;
  if (!nodes) return true;
  return nodes.every(
    (node) => node.type === 'comment' && !(node.text ?? '').startsWith('!')
  );
}

export function parseFontWeightRange(
  str: string | undefined
): [number, number] {
  if (typeof str === 'undefined' || str === 'auto') {
    return [-Infinity, Infinity];
  }
  let minFontWeight = 400;
  let maxFontWeight = 400;
  const fontWeightTokens = str.split(/\s+/).map((s) => parseFloat(s));
  if (
    [1, 2].includes(fontWeightTokens.length) &&
    !fontWeightTokens.some(isNaN)
  ) {
    minFontWeight = maxFontWeight = fontWeightTokens[0];
    if (fontWeightTokens.length === 2) {
      maxFontWeight = fontWeightTokens[1];
    }
  }
  return [minFontWeight, maxFontWeight];
}

export function parseFontStretchRange(
  str: string | undefined
): [number, number] {
  if (typeof str === 'undefined' || str.toLowerCase() === 'auto') {
    return [-Infinity, Infinity];
  }
  let minFontStretch = 100;
  let maxFontStretch = 100;
  const fontStretchTokens = str.split(/\s+/).map((s) => {
    const normalized = normalizeFontPropertyValue('font-stretch', s);
    return parseFloat(String(normalized));
  });
  if (
    [1, 2].includes(fontStretchTokens.length) &&
    !fontStretchTokens.some(isNaN)
  ) {
    minFontStretch = maxFontStretch = fontStretchTokens[0];
    if (fontStretchTokens.length === 2) {
      maxFontStretch = fontStretchTokens[1];
    }
  }
  return [minFontStretch, maxFontStretch];
}

export function uniqueChars(text: string): string {
  return [...new Set(text)].sort().join('');
}

export function uniqueCharsFromArray(texts: string[]): string {
  const charSet = new Set<string>();
  for (const text of texts) {
    for (const char of text) {
      charSet.add(char);
    }
  }
  return [...charSet].sort().join('');
}

export function hashHexPrefix(
  stringOrBuffer: string | Buffer | Uint8Array
): string {
  return crypto
    .createHash('sha256')
    .update(stringOrBuffer)
    .digest('hex')
    .slice(0, 10);
}
