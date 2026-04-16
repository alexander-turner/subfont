const INVISIBLE_ELEMENTS = new Set([
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

// Named and numeric HTML entity decoder (covers the entities used in
// typical web content without pulling in a full entity table).
const namedEntities = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
};
const entityRe = /&(?:#x([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));/g;
function decodeEntities(str) {
  return str.replace(entityRe, (match, hex, dec, name) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
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
 *
 * Uses regex-based stripping instead of a full DOM parse for speed.
 * Collects text nodes and content attributes (alt, title, placeholder,
 * value, aria-label), skipping invisible elements.
 */
function extractVisibleText(html) {
  if (!html) return '';

  const parts = [];

  // Collect hidden-input value attrs that should be excluded.
  const hiddenInputValues = new Set();
  let hiddenMatch;
  while ((hiddenMatch = hiddenInputRe.exec(html)) !== null) {
    const fragment = hiddenMatch[0];
    let m;
    const localAttrRe = /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*))/gi;
    while ((m = localAttrRe.exec(fragment)) !== null) {
      const val = m[1] ?? m[2] ?? m[3];
      if (val) hiddenInputValues.add(val);
    }
  }

  // Extract text attributes before stripping tags.
  let attrMatch;
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

module.exports = extractVisibleText;
module.exports.INVISIBLE_ELEMENTS = INVISIBLE_ELEMENTS;
