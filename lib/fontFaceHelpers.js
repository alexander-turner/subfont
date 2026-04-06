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
    return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  } else {
    return name;
  }
}

function cssQuoteIfNecessary(value) {
  if (/^\w+$/.test(value)) {
    return value;
  } else {
    return `'${value.replace(/'/g, "\\'")}'`;
  }
}

function getPreferredFontUrl(cssFontFaceSrcRelations = []) {
  const formatOrder = ['woff2', 'woff', 'truetype', 'opentype'];

  const typeOrder = ['Woff2', 'Woff', 'Ttf', 'Otf'];

  for (const format of formatOrder) {
    const relation = cssFontFaceSrcRelations.find(
      (r) => r.format && r.format.toLowerCase() === format
    );

    if (relation) {
      return relation.to.url;
    }
  }

  for (const assetType of typeOrder) {
    const relation = cssFontFaceSrcRelations.find(
      (r) => r.to.type === assetType
    );

    if (relation) {
      return relation.to.url;
    }
  }
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
          value = cssQuoteIfNecessary(`${value}__subset`);
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

  resultString.push(
    `  unicode-range: ${unicodeRange(fontUsage.codepoints.used)};`
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
      return `@font-face{font-family:${props['font-family']}__subset;font-stretch:${props['font-stretch']};font-style:${props['font-style']};font-weight:${props['font-weight']};src:${src}}`;
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
  const codepoints = [];
  let hasSpace = false;
  for (const char of text) {
    const cp = char.codePointAt(0);
    codepoints.push(cp);
    if (cp === 32) hasSpace = true;
  }

  if (!hasSpace) {
    // Make sure that space is always part of the subset fonts (and that it's announced in unicode-range).
    // Prevents Chrome from going off and downloading the fallback:
    // https://gitter.im/assetgraph/assetgraph?at=5f01f6e13a0d3931fad4021b
    codepoints.push(32);
  }
  return codepoints;
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
    .map((str) => normalizeFontPropertyValue('font-stretch', str));
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

function md5HexPrefix(stringOrBuffer) {
  return crypto
    .createHash('md5')
    .update(stringOrBuffer)
    .digest('hex')
    .slice(0, 10);
}

module.exports = {
  stringifyFontFamily,
  cssQuoteIfNecessary,
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
  md5HexPrefix,
};
