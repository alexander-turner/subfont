/**
 * Fast extraction of visible text content from HTML source.
 * Used as a lightweight alternative to full font-tracer for pages
 * that share the same CSS configuration as an already-traced page.
 *
 * This captures text nodes, input values/placeholders, and common
 * content attributes. It strips script/style/svg/template element
 * contents and decodes HTML entities.
 */
function extractVisibleText(html) {
  // Remove script, style, SVG, and template elements with their contents
  let text = html.replace(/<(script|style|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  // Extract alt, title, placeholder, value, aria-label attributes
  const attrTexts = [];
  text.replace(
    /\b(?:alt|title|placeholder|value|aria-label)\s*=\s*"([^"]*)"/gi,
    (_, val) => { attrTexts.push(val); return ''; }
  );
  text.replace(
    /\b(?:alt|title|placeholder|value|aria-label)\s*=\s*'([^']*)'/gi,
    (_, val) => { attrTexts.push(val); return ''; }
  );
  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Add attribute texts
  text = text + ' ' + attrTexts.join(' ');
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, '\u00A0')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  return text;
}

module.exports = extractVisibleText;
