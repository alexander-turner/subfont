const INVISIBLE_ELEMENTS = new Set<string>([
  'script',
  'style',
  'svg',
  'template',
  'head',
  'noscript',
  'iframe',
  'object',
  'embed',
  'datalist',
]);
// Build a regex that strips invisible element blocks (greedy, case-insensitive).
// For void elements like <embed> there is no closing tag — just the opening
// tag is stripped (which the tag-stripping regex below handles).
const invisibleBlockTags = [...INVISIBLE_ELEMENTS].filter((t) => t !== 'embed');
const invisibleBlockRe = new RegExp(
  `<(${invisibleBlockTags.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
  'gi'
);
const commentRe = /<!--[\s\S]*?-->/g;

// Match text-bearing attributes: alt="...", title='...', placeholder=..., etc.
// Captures the attribute name (group 1) and the value (groups 2, 3, or 4 for
// double-quoted, single-quoted, and unquoted respectively).
// Negative lookbehind prevents matching data- prefixed attributes (e.g. data-alt).
const attrRe =
  /(?<![-\w])(alt|title|placeholder|value|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi;
// Match <input ... type="hidden" ...> or <input ... type=hidden ...>
// \b only after the unquoted alternative — quotes already delimit the value.
const hiddenInputRe =
  /<input\b[^>]*?\btype\s*=\s*(?:"hidden"|'hidden'|hidden\b)[^>]*/gi;
const tagRe = /<[^>]+>/g;

// Named and numeric HTML entity decoder.  Covers the XML built-ins plus
// typographic entities commonly found in blog/article content.  Rare
// entities are left as-is (their literal characters still enter the
// subset, so glyphs are never lost — just slightly overcounted).
const namedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  // Typographic quotes & dashes
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  // Common symbols
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  minus: '−',
  plusmn: '±',
  deg: '°',
  micro: 'µ',
  para: '¶',
  sect: '§',
  // Currency
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  // Arrows
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
};
const entityRe = /&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g;
function decodeEntities(str: string): string {
  return str.replace(entityRe, (match, hex, dec, name) => {
    try {
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      if (dec) return String.fromCodePoint(parseInt(dec, 10));
    } catch {
      return match;
    }
    if (name && namedEntities[name.toLowerCase()] !== undefined) {
      return namedEntities[name.toLowerCase()];
    }
    return match;
  });
}

/**
 * Fast extraction of visible text content from HTML source.
 * Used as a lightweight alternative to full font-tracer for pages
 * that share the same CSS configuration as an already-traced page.
 */
function extractVisibleText(html: string): string {
  if (!html) return '';

  // Reset lastIndex on global regexes — a prior call that threw
  // mid-function would leave them in an indeterminate state.
  hiddenInputRe.lastIndex = 0;
  attrRe.lastIndex = 0;

  const parts: string[] = [];

  // Collect hidden-input value attrs that should be excluded.
  const hiddenInputValues = new Set<string>();
  let hiddenMatch: RegExpExecArray | null;
  while ((hiddenMatch = hiddenInputRe.exec(html)) !== null) {
    const fragment = hiddenMatch[0];
    let m: RegExpExecArray | null;
    const localAttrRe = /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi;
    while ((m = localAttrRe.exec(fragment)) !== null) {
      const val = m[1] ?? m[2] ?? m[3];
      if (val) hiddenInputValues.add(val);
    }
  }

  // Extract text attributes before stripping tags.
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRe.exec(html)) !== null) {
    const attrName = attrMatch[1].toLowerCase();
    const val = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];
    if (!val) continue;
    if (attrName === 'value' && hiddenInputValues.has(val)) continue;
    parts.push(decodeEntities(val));
  }

  // Strip invisible blocks, comments, and tags to get text content.
  let text = html;
  text = text.replace(invisibleBlockRe, ' ');
  text = text.replace(commentRe, ' ');
  text = text.replace(tagRe, ' ');
  text = decodeEntities(text);
  parts.push(text);

  return parts.join(' ');
}

interface ExtractVisibleText {
  (html: string): string;
  INVISIBLE_ELEMENTS: Set<string>;
}

(extractVisibleText as ExtractVisibleText).INVISIBLE_ELEMENTS =
  INVISIBLE_ELEMENTS;

export = extractVisibleText as ExtractVisibleText;
