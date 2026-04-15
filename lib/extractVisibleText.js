const parse5 = require('parse5');

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
const TEXT_ATTRIBUTES = new Set([
  'alt',
  'title',
  'placeholder',
  'value',
  'aria-label',
]);

/**
 * Fast extraction of visible text content from HTML source.
 * Used as a lightweight alternative to full font-tracer for pages
 * that share the same CSS configuration as an already-traced page.
 *
 * Walks the parse5 tree collecting text nodes and content attributes
 * (alt, title, placeholder, value, aria-label), skipping invisible
 * elements (script, style, svg, template).
 */
function extractVisibleText(html) {
  const document = parse5.parse(html);
  const parts = [];

  function walk(node) {
    if (node.nodeName && INVISIBLE_ELEMENTS.has(node.nodeName)) {
      return;
    }

    // Collect relevant attribute values
    if (node.attrs) {
      const isHiddenInput =
        node.nodeName === 'input' &&
        node.attrs.some(
          (a) => a.name === 'type' && a.value.toLowerCase() === 'hidden'
        );
      for (const attr of node.attrs) {
        if (TEXT_ATTRIBUTES.has(attr.name) && attr.value) {
          if (attr.name === 'value' && isHiddenInput) {
            continue;
          }
          parts.push(attr.value);
        }
      }
    }

    // Collect text content
    if (node.nodeName === '#text' && node.value) {
      parts.push(node.value);
    }

    // Recurse into child nodes
    if (node.childNodes) {
      for (const child of node.childNodes) {
        walk(child);
      }
    }
  }

  walk(document);
  return parts.join(' ');
}

module.exports = extractVisibleText;
