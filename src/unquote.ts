function unescapeCssString(str: string): string {
  return str.replace(
    /\\([0-9a-f]{1,6})(\s?)/gi,
    ($0, hexChars: string, followingWhitespace: string) => {
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

function unquote(str: string): string {
  if (typeof str !== 'string') {
    return str;
  }

  return str.replace(
    /^'([^']*)'$|^"([^"]*)"$/,
    ($0, singleQuoted: string | undefined, doubleQuoted: string | undefined) =>
      typeof singleQuoted === 'string'
        ? unescapeCssString(singleQuoted.replace(/\\'/g, "'"))
        : unescapeCssString((doubleQuoted as string).replace(/\\"/g, '"'))
  );
}

export = unquote;
