const crypto = require('crypto');
const stripLocalTokens = require('./stripLocalTokens');
const unicodeRange = require('./unicodeRange');
const normalizeFontPropertyValue = require('./normalizeFontPropertyValue');

const contentTypeByFontFormat = {
  woff: 'font/woff', // https://tools.ietf.org/html/rfc8081#section-4.4.5
  woff2: 'font/woff2',
  truetype: 'font/ttf',
};

function stringifyFontFamily(name) {
  if (/[^a-z0-9_-]/i.test(name)) {
    return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  } else {
    return name;
  }
}

function maybeCssQuote(value) {
  // CSS identifiers must start with a letter or underscore (or hyphen
  // followed by a letter/underscore), not a digit or bare hyphen.
  if (/^[a-zA-Z_][a-zA-Z0-9_-]*$|^-[a-zA-Z_][a-zA-Z0-9_-]*$/.test(value)) {
    return value;
  } else {
    return `'${value.replace(/'/g, "\\'")}'`;
  }
}

function getPreferredFontUrl(cssFontFaceSrcRelations = []) {
  // Priority: woff2 > woff > truetype > opentype, preferring explicit
  // format() declarations over asset-type guesses.
  const formatPriority = { woff2: 0, woff: 1, truetype: 2, opentype: 3 };
  const typePriority = { Woff2: 4, Woff: 5, Ttf: 6, Otf: 7 };

  let bestUrl;
  let bestPriority = Infinity;

  for (const r of cssFontFaceSrcRelations) {
    let priority;
    if (r.format) {
      priority = formatPriority[r.format.toLowerCase()];
    }
    if (priority === undefined) {
      priority = typePriority[r.to.type];
    }
    if (priority !== undefined && priority < bestPriority) {
      bestPriority = priority;
      bestUrl = r.to.url;
    }
  }

  return bestUrl;
}

// Temporarily switch all relation hrefs to absolute so that
// node.toString() emits fully-qualified URLs in the @font-face src.
function getFontFaceDeclarationText(node, relations) {
  const originalHrefTypeByRelation = new Map();
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

function getFontFaceForFontUsage(fontUsage) {
  const subsets = fontOrder
    .filter((format) => fontUsage.subsets[format])
    .map((format) => ({
      format,
      url: `data:${contentTypeByFontFormat[format]};base64,${fontUsage.subsets[
        format
      ].toString('base64')}`,
    }));

  const resultString = ['@font-face {'];

  resultString.push(
    ...Object.keys(fontUsage.props)
      .sort()
      .map((prop) => {
        let value = fontUsage.props[prop];

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
  // This is essential for unicode-range-split fonts (e.g. CJK) where
  // the text may contain characters outside this font file's range.
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

function getUnusedVariantsStylesheet(
  fontUsages,
  accumulatedFontFaceDeclarations
) {
  // Find the available @font-face declarations where the font-family is used
  // (so there will be subsets created), but the specific variant isn't used.
  return accumulatedFontFaceDeclarations
    .filter(
      (decl) =>
        fontUsages.some((fontUsage) =>
          fontUsage.fontFamilies.has(decl['font-family'])
        ) &&
        !fontUsages.some(
          ({ props }) =>
            props['font-style'] === decl['font-style'] &&
            props['font-weight'] === decl['font-weight'] &&
            props['font-stretch'] === decl['font-stretch'] &&
            props['font-family'].toLowerCase() ===
              decl['font-family'].toLowerCase()
        )
    )
    .map((props) => {
      let src = stripLocalTokens(props.src);
      if (props.relations.length > 0) {
        const targets = props.relations.map((relation) => relation.to.url);
        src = src.replace(
          props.relations[0].tokenRegExp,
          () => `url('${targets.shift().replace(/'/g, "\\'")}')`
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
      ]) {
        if (props[descriptor]) {
          rule += `;${descriptor}:${props[descriptor]}`;
        }
      }
      rule += '}';
      return rule;
    })
    .join('');
}

function getFontUsageStylesheet(fontUsages) {
  return fontUsages
    .filter((fontUsage) => fontUsage.subsets)
    .map((fontUsage) => getFontFaceForFontUsage(fontUsage))
    .join('');
}

function getCodepoints(text) {
  const codepointSet = new Set();
  for (const char of text) {
    codepointSet.add(char.codePointAt(0));
  }

  // Make sure that space is always part of the subset fonts (and that it's announced in unicode-range).
  // Prevents Chrome from going off and downloading the fallback:
  // https://gitter.im/assetgraph/assetgraph?at=5f01f6e13a0d3931fad4021b
  codepointSet.add(32);

  return [...codepointSet];
}

function cssAssetIsEmpty(cssAsset) {
  return cssAsset.parseTree.nodes.every(
    (node) => node.type === 'comment' && !node.text.startsWith('!')
  );
}

function parseFontWeightRange(str) {
  if (typeof str === 'undefined' || str === 'auto') {
    return [-Infinity, Infinity];
  }
  let minFontWeight = 400;
  let maxFontWeight = 400;
  const fontWeightTokens = str.split(/\s+/).map((str) => parseFloat(str));
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

function parseFontStretchRange(str) {
  if (typeof str === 'undefined' || str.toLowerCase() === 'auto') {
    return [-Infinity, Infinity];
  }
  let minFontStretch = 100;
  let maxFontStretch = 100;
  const fontStretchTokens = str
    .split(/\s+/)
    .map((str) => parseFloat(normalizeFontPropertyValue('font-stretch', str)));
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

function uniqueChars(text) {
  return [...new Set(text)].sort().join('');
}

function uniqueCharsFromArray(texts) {
  const charSet = new Set();
  for (const text of texts) {
    for (const char of text) {
      charSet.add(char);
    }
  }
  return [...charSet].sort().join('');
}

function hashHexPrefix(stringOrBuffer) {
  return crypto
    .createHash('sha256')
    .update(stringOrBuffer)
    .digest('hex')
    .slice(0, 10);
}

module.exports = {
  stringifyFontFamily,
  maybeCssQuote,
  getPreferredFontUrl,
  getFontFaceDeclarationText,
  getFontFaceForFontUsage,
  getUnusedVariantsStylesheet,
  getFontUsageStylesheet,
  getCodepoints,
  cssAssetIsEmpty,
  parseFontWeightRange,
  parseFontStretchRange,
  uniqueChars,
  uniqueCharsFromArray,
  hashHexPrefix,
};
