// Escape a value for safe inclusion in any JS string context (single-quoted,
// double-quoted, or template literal). Uses JSON.stringify for robust escaping
// of backslashes, quotes, newlines, U+2028, U+2029, etc.
// The < escape prevents </script> from closing an inline script tag.
function escapeJsStringLiteral(str) {
  return JSON.stringify(str)
    .slice(1, -1)
    .replace(/'/g, "\\'")
    .replace(/`/g, '\\x60')
    .replace(/</g, '\\x3c');
}

module.exports = escapeJsStringLiteral;
