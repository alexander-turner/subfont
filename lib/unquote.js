function unescapeCssString(str) {
  return str.replace(
    /\\([0-9a-f]{1,6})(\s?)/gi,
    ($0, hexChars, followingWhitespace) => {
      try {
        return `${String.fromCodePoint(parseInt(hexChars, 16))}${
          hexChars.length === 6 ? followingWhitespace : ''
        }`;
      } catch {
        return $0;
      }
    }
  );
}

module.exports = function unquote(str) {
  if (typeof str !== 'string') {
    return str;
  }

  return str.replace(
    /^'([^']*)'$|^"([^"]*)"$/,
    ($0, singleQuoted, doubleQuoted) =>
      typeof singleQuoted === 'string'
        ? unescapeCssString(singleQuoted.replace(/\\'/g, "'"))
        : unescapeCssString(doubleQuoted.replace(/\\"/g, '"'))
  );
};
