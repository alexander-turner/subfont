const _ = require('lodash');
const memoizeSync = require('memoizesync');
const urltools = require('urltools');
const os = require('os');
const pathModule = require('path');
const { Worker } = require('worker_threads');

const fontTracer = require('font-tracer');
const fontSnapper = require('font-snapper');
const fontverter = require('fontverter');
const subsetFont = require('subset-font');

const compileQuery = require('assetgraph/lib/compileQuery');

const HeadlessBrowser = require('./HeadlessBrowser');
const gatherStylesheetsWithPredicates = require('./gatherStylesheetsWithPredicates');
const findCustomPropertyDefinitions = require('./findCustomPropertyDefinitions');
const extractReferencedCustomPropertyNames = require('./extractReferencedCustomPropertyNames');
const parseFontVariationSettings = require('./parseFontVariationSettings');
const parseAnimationShorthand = require('@hookun/parse-animation-shorthand');
const stripLocalTokens = require('./stripLocalTokens');
const injectSubsetDefinitions = require('./injectSubsetDefinitions');
const cssFontParser = require('css-font-parser');
const cssListHelpers = require('css-list-helpers');
const LinesAndColumns = require('lines-and-columns').default;
const crypto = require('crypto');

const unquote = require('./unquote');
const normalizeFontPropertyValue = require('./normalizeFontPropertyValue');
const getCssRulesByProperty = require('./getCssRulesByProperty');
const unicodeRange = require('./unicodeRange');
const getFontInfo = require('./getFontInfo');

const googleFontsCssUrlRegex = /^(?:https?:)?\/\/fonts\.googleapis\.com\/css/;

// Relation types followed when traversing from HTML to CSS for @font-face gathering
const fontFaceTraversalTypes = new Set(['HtmlStyle', 'SvgStyle', 'CssImport']);

const initialValueByProp = _.pick(require('./initialValueByProp'), [
  'font-style',
  'font-weight',
  'font-stretch',
]);

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

function uniqueChars(text) {
  const charSet = new Set();
  for (const char of text) {
    charSet.add(char);
  }
  return [...charSet].sort().join('');
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

function isOutOfBoundsAnimationTimingFunction(animationTimingFunctionStr) {
  if (typeof animationTimingFunctionStr !== 'string') {
    return false;
  }
  const { timingFunction } = parseAnimationShorthand.parseSingle(
    `${animationTimingFunctionStr} ignored-name`
  ).value;

  if (timingFunction.type === 'cubic-bezier') {
    const [, y1, , y2] = timingFunction.value;
    return y1 > 1 || y1 < 0 || y2 > 1 || y2 < 0;
  }
  return false;
}

// Hack to extract '@font-face { ... }' with all absolute urls
function getFontFaceDeclarationText(node, relations) {
  const originalHrefTypeByRelation = new Map();
  for (const relation of relations) {
    originalHrefTypeByRelation.set(relation.hrefType);
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

function getParents(asset, assetQuery) {
  const assetMatcher = compileQuery(assetQuery);
  const seenAssets = new Set();
  const parents = [];
  (function visit(asset) {
    if (seenAssets.has(asset)) {
      return;
    }
    seenAssets.add(asset);

    for (const incomingRelation of asset.incomingRelations) {
      if (assetMatcher(incomingRelation.from)) {
        parents.push(incomingRelation.from);
      } else {
        visit(incomingRelation.from);
      }
    }
  })(asset);

  return parents;
}

function asyncLoadStyleRelationWithFallback(
  htmlOrSvgAsset,
  originalRelation,
  hrefType
) {
  // Async load google font stylesheet
  // Insert async CSS loading <script>
  const asyncCssLoadingRelation = htmlOrSvgAsset.addRelation(
    {
      type: 'HtmlScript',
      hrefType: 'inline',
      to: {
        type: 'JavaScript',
        text: `
          (function () {
            var el = document.createElement('link');
            el.href = '${htmlOrSvgAsset.assetGraph.buildHref(
              originalRelation.to.url,
              htmlOrSvgAsset.url,
              { hrefType }
            )}'.toString('url');
            el.rel = 'stylesheet';
            ${
              originalRelation.media
                ? `el.media = '${originalRelation.media}';`
                : ''
            }
            document.body.appendChild(el);
          }())
        `,
      },
    },
    'lastInBody'
  );

  // Insert <noscript> fallback sync CSS loading
  const noScriptFallbackRelation = htmlOrSvgAsset.addRelation(
    {
      type: 'HtmlNoscript',
      to: {
        type: 'Html',
        text: '',
      },
    },
    'lastInBody'
  );

  noScriptFallbackRelation.to.addRelation(
    {
      type: 'HtmlStyle',
      media: originalRelation.media,
      to: originalRelation.to,
      hrefType,
    },
    'last'
  );

  noScriptFallbackRelation.inline();
  asyncCssLoadingRelation.to.minify();
  htmlOrSvgAsset.markDirty();
}

function getSubsetPromiseId(fontUsage, format, variationAxes = null) {
  return [
    fontUsage.text,
    fontUsage.fontUrl,
    format,
    JSON.stringify(variationAxes),
  ].join('\x1d');
}

async function getVariationAxisBounds(
  assetGraph,
  fontUrl,
  seenAxisValuesByFontUrlAndAxisName
) {
  const fontInfo = await getFontInfo(
    assetGraph.findAssets({ url: fontUrl })[0].rawSrc
  );

  const variationAxes = {};
  let fullyInstanced = true;
  let numAxesPinned = 0;
  let numAxesReduced = 0;
  const fontVariationEntries = Object.entries(fontInfo.variationAxes);
  const seenAxisValuesByAxisName =
    seenAxisValuesByFontUrlAndAxisName.get(fontUrl);
  if (fontVariationEntries.length > 0 && seenAxisValuesByAxisName) {
    for (const [
      axisName,
      { min, max, default: defaultValue },
    ] of fontVariationEntries) {
      let seenAxisValues = seenAxisValuesByAxisName.get(axisName);
      if (!seenAxisValues && !ignoredVariationAxes.has(axisName)) {
        seenAxisValues = new Set([defaultValue]);
      }
      if (seenAxisValues && seenAxisValues.size === 1) {
        variationAxes[axisName] = _.clamp([...seenAxisValues][0], min, max);
        numAxesPinned += 1;
      } else if (seenAxisValues) {
        const minSeenValue = Math.min(...seenAxisValues);
        const maxSeenValue = Math.max(...seenAxisValues);
        variationAxes[axisName] = {
          min: Math.min(minSeenValue, min),
          max: Math.min(maxSeenValue, max),
        };
        fullyInstanced = false;
        if (minSeenValue > min || maxSeenValue < max) {
          numAxesReduced += 1;
        }
      }
    }
  }
  return {
    fullyInstanced,
    numAxesReduced,
    numAxesPinned,
    variationAxes,
  };
}

async function getSubsetsForFontUsage(
  assetGraph,
  htmlOrSvgAssetTextsWithProps,
  formats,
  seenAxisValuesByFontUrlAndAxisName,
  instance = false
) {
  const allFontsSet = new Set();
  const allFonts = [];

  // Collect all unique fontUrls and compute the global text union per fontUrl.
  // Since fontUsage.text is already the uniqueChars union of all pages'
  // text for that font, all pages will have the same text for the same fontUrl.
  // We collect unique fontUsages to avoid iterating 385 pages × N fonts.
  const canonicalFontUsageByUrl = new Map();

  for (const item of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of item.fontUsages) {
      if (!fontUsage.fontUrl) {
        continue;
      }

      if (!allFontsSet.has(fontUsage.fontUrl)) {
        allFontsSet.add(fontUsage.fontUrl);
        allFonts.push(fontUsage.fontUrl);
        canonicalFontUsageByUrl.set(fontUsage.fontUrl, fontUsage);
      }
    }
  }

  await assetGraph.populate({
    followRelations: {
      to: { url: { $or: allFonts } },
    },
  });

  const originalFontBuffers = allFonts.reduce((result, fontUrl) => {
    const fontAsset = assetGraph.findAssets({
      url: fontUrl,
      isLoaded: true,
    })[0];

    if (fontAsset) {
      result[fontUrl] = fontAsset.rawSrc;
    }

    return result;
  }, {});

  const subsetPromiseMap = {};

  // Cache getVariationAxisBounds by font URL to avoid redundant font
  // parsing when the same font is used across many pages.
  const variationAxisBoundsCache = new Map();

  // Subset once per unique fontUrl rather than iterating all pages.
  // Each fontUrl's text is the global union of all pages' characters,
  // so the subset result is the same regardless of which page we process.
  const subsetResultsByFontUrl = new Map();

  for (const [fontUrl, fontUsage] of canonicalFontUsageByUrl) {
    const fontBuffer = originalFontBuffers[fontUrl];
    const text = fontUsage.text;
    let variationAxes;
    let fullyInstanced = false;
    let numAxesReduced = 0;
    let numAxesPinned = 0;
    if (instance) {
      let res = variationAxisBoundsCache.get(fontUrl);
      if (!res) {
        res = await getVariationAxisBounds(
          assetGraph,
          fontUrl,
          seenAxisValuesByFontUrlAndAxisName
        );
        variationAxisBoundsCache.set(fontUrl, res);
      }
      variationAxes = res.variationAxes;
      fullyInstanced = res.fullyInstanced;
      numAxesReduced = res.numAxesReduced;
      numAxesPinned = res.numAxesPinned;
    }

    const subsetInfo = { variationAxes, fullyInstanced, numAxesPinned, numAxesReduced };
    subsetResultsByFontUrl.set(fontUrl, subsetInfo);

    for (const targetFormat of formats) {
      const promiseId = getSubsetPromiseId(
        fontUsage,
        targetFormat,
        variationAxes
      );

      if (!subsetPromiseMap[promiseId]) {
        subsetPromiseMap[promiseId] = subsetFont(fontBuffer, text, {
          targetFormat,
          variationAxes,
        }).catch((err) => {
          const error = new Error(err.message);
          error.asset = assetGraph.findAssets({
            url: fontUrl,
          })[0];

          assetGraph.warn(error);
        });
      }

      subsetPromiseMap[promiseId].then((subsetBuffer) => {
        if (subsetBuffer) {
          if (!fontUsage.subsets) {
            fontUsage.subsets = {};
          }
          fontUsage.subsets[targetFormat] = subsetBuffer;
          const size = subsetBuffer.length;
          if (
            !fontUsage.smallestSubsetSize ||
            size < fontUsage.smallestSubsetSize
          ) {
            fontUsage.smallestSubsetSize = size;
            fontUsage.smallestSubsetFormat = targetFormat;
            fontUsage.variationAxes = variationAxes;
            fontUsage.fullyInstanced = fullyInstanced;
            fontUsage.numAxesPinned = numAxesPinned;
            fontUsage.numAxesReduced = numAxesReduced;
          }
        }
      });
    }
  }

  await Promise.all(Object.values(subsetPromiseMap));

  // Propagate subset results from canonical fontUsages to all pages' fontUsages.
  // This avoids re-subsetting — each page just gets a reference to the same buffer.
  for (const item of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of item.fontUsages) {
      if (!fontUsage.fontUrl) continue;
      const canonical = canonicalFontUsageByUrl.get(fontUsage.fontUrl);
      if (canonical && canonical !== fontUsage && canonical.subsets) {
        fontUsage.subsets = canonical.subsets;
        fontUsage.smallestSubsetSize = canonical.smallestSubsetSize;
        fontUsage.smallestSubsetFormat = canonical.smallestSubsetFormat;
        const info = subsetResultsByFontUrl.get(fontUsage.fontUrl);
        if (info) {
          fontUsage.variationAxes = info.variationAxes;
          fontUsage.fullyInstanced = info.fullyInstanced;
          fontUsage.numAxesPinned = info.numAxesPinned;
          fontUsage.numAxesReduced = info.numAxesReduced;
        }
      }
    }
  }
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

const extensionByFormat = {
  truetype: '.ttf',
  woff: '.woff',
  woff2: '.woff2',
};

function md5HexPrefix(stringOrBuffer) {
  return crypto
    .createHash('md5')
    .update(stringOrBuffer)
    .digest('hex')
    .slice(0, 10);
}

async function createSelfHostedGoogleFontsCssAsset(
  assetGraph,
  googleFontsCssAsset,
  formats,
  hrefType,
  subsetUrl
) {
  const lines = [];
  for (const cssFontFaceSrc of assetGraph.findRelations({
    from: googleFontsCssAsset,
    type: 'CssFontFaceSrc',
  })) {
    lines.push(`@font-face {`);
    const fontFaceDeclaration = cssFontFaceSrc.node;
    fontFaceDeclaration.walkDecls((declaration) => {
      const propName = declaration.prop.toLowerCase();
      if (propName !== 'src') {
        lines.push(`  ${propName}: ${declaration.value};`);
      }
    });
    const srcFragments = [];
    for (const format of formats) {
      const rawSrc = await fontverter.convert(cssFontFaceSrc.to.rawSrc, format);
      const url = assetGraph.resolveUrl(
        subsetUrl,
        `${cssFontFaceSrc.to.baseName}-${md5HexPrefix(rawSrc)}${
          extensionByFormat[format]
        }`
      );
      const fontAsset =
        assetGraph.findAssets({ url })[0] ||
        (await assetGraph.addAsset({
          url,
          rawSrc,
        }));
      srcFragments.push(
        `url(${assetGraph.buildHref(fontAsset.url, subsetUrl, {
          hrefType,
        })}) format('${format}')`
      );
    }
    lines.push(`  src: ${srcFragments.join(', ')};`);
    lines.push(
      `  unicode-range: ${unicodeRange(
        (await getFontInfo(cssFontFaceSrc.to.rawSrc)).characterSet
      )};`
    );
    lines.push('}');
  }
  const text = lines.join('\n');
  const fallbackAsset = assetGraph.addAsset({
    type: 'Css',
    url: assetGraph.resolveUrl(subsetUrl, `fallback-${md5HexPrefix(text)}.css`),
    text,
  });
  return fallbackAsset;
}

const validFontDisplayValues = [
  'auto',
  'block',
  'swap',
  'fallback',
  'optional',
];

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

async function warnAboutMissingGlyphs(
  htmlOrSvgAssetTextsWithProps,
  assetGraph
) {
  const missingGlyphsErrors = [];

  // Cache getFontInfo results by subset buffer identity to avoid
  // re-parsing the same font buffer for every page (subsets are shared).
  const subsetCharSetCache = new Map();

  for (const {
    htmlOrSvgAsset,
    fontUsages,
    accumulatedFontFaceDeclarations,
  } of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of fontUsages) {
      if (fontUsage.subsets) {
        const subsetBuffer = Object.values(fontUsage.subsets)[0];
        let cached = subsetCharSetCache.get(subsetBuffer);
        if (!cached) {
          const characterSet = (await getFontInfo(subsetBuffer)).characterSet;
          cached = new Set(characterSet);
          subsetCharSetCache.set(subsetBuffer, cached);
        }
        const characterSetLookup = cached;

        let missedAny = false;
        for (const char of fontUsage.pageText) {
          // Turns out that browsers don't mind that these are missing:
          if (char === '\t' || char === '\n') {
            continue;
          }

          const codePoint = char.codePointAt(0);

          const isMissing = !characterSetLookup.has(codePoint);

          if (isMissing) {
            let location;
            const charIdx = htmlOrSvgAsset.text.indexOf(char);

            if (charIdx === -1) {
              location = `${htmlOrSvgAsset.urlOrDescription} (generated content)`;
            } else {
              const position = new LinesAndColumns(
                htmlOrSvgAsset.text
              ).locationForIndex(charIdx);
              location = `${htmlOrSvgAsset.urlOrDescription}:${
                position.line + 1
              }:${position.column + 1}`;
            }

            missingGlyphsErrors.push({
              codePoint,
              char,
              htmlOrSvgAsset,
              fontUsage,
              location,
            });
            missedAny = true;
          }
        }
        if (missedAny) {
          const fontFaces = accumulatedFontFaceDeclarations.filter((fontFace) =>
            fontUsage.fontFamilies.has(fontFace['font-family'])
          );
          for (const fontFace of fontFaces) {
            const cssFontFaceSrc = fontFace.relations[0];
            const fontFaceDeclaration = cssFontFaceSrc.node;
            if (
              !fontFaceDeclaration.some((node) => node.prop === 'unicode-range')
            ) {
              fontFaceDeclaration.append({
                prop: 'unicode-range',
                value: unicodeRange(fontUsage.codepoints.original),
              });
              cssFontFaceSrc.from.markDirty();
            }
          }
        }
      }
    }
  }

  if (missingGlyphsErrors.length) {
    const errorLog = missingGlyphsErrors.map(
      ({ char, fontUsage, location }) =>
        `- \\u{${char.codePointAt(0).toString(16)}} (${char}) in font-family '${
          fontUsage.props['font-family']
        }' (${fontUsage.props['font-weight']}/${
          fontUsage.props['font-style']
        }) at ${location}`
    );

    const message = `Missing glyph fallback detected.
When your primary webfont doesn't contain the glyphs you use, browsers that don't support unicode-range will load your fallback fonts, which will be a potential waste of bandwidth.
These glyphs are used on your site, but they don't exist in the font you applied to them:`;

    assetGraph.info(new Error(`${message}\n${errorLog.join('\n')}`));
  }
}

const standardVariationAxes = new Set(['wght', 'wdth', 'ital', 'slnt', 'opsz']);
// It would be very hard to trace statically which values of opsz (font-optical-sizing)
// are going to be used, so we ignore that one:
const ignoredVariationAxes = new Set(['opsz']);

function renderNumberRange(min, max) {
  if (min === max) {
    return String(min);
  } else {
    return `${min}-${max}`;
  }
}

function getVariationAxisUsage(htmlOrSvgAssetTextsWithProps) {
  const seenAxisValuesByFontUrlAndAxisName = new Map();
  const outOfBoundsAxesByFontUrl = new Map();

  function noteUsedValue(fontUrl, axisName, axisValue) {
    let seenAxes = seenAxisValuesByFontUrlAndAxisName.get(fontUrl);
    if (!seenAxes) {
      seenAxes = new Map();
      seenAxisValuesByFontUrlAndAxisName.set(fontUrl, seenAxes);
    }
    if (seenAxes.has(axisName)) {
      seenAxes.get(axisName).add(axisValue);
    } else {
      seenAxes.set(axisName, new Set([axisValue]));
    }
  }

  // Since fontUsages are built from shared templates, all pages produce
  // the same fontStyles/fontWeights/etc. for a given fontUrl. Process
  // each unique fontUrl only once to avoid 187× redundant iterations.
  const seenFontUrls = new Set();
  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const {
      fontUrl,
      fontStyles,
      fontWeights,
      fontStretches,
      fontVariationSettings,
      hasOutOfBoundsAnimationTimingFunction,
      props,
    } of fontUsages) {
      if (seenFontUrls.has(fontUrl)) continue;
      seenFontUrls.add(fontUrl);
      if (fontStyles.has('italic')) {
        noteUsedValue(fontUrl, 'ital', 1);
      }
      // If any font-style value except italic is seen (including normal or oblique)
      // we're also utilizing value 0:
      if (fontStyles.size > fontStyles.has('italic') ? 1 : 0) {
        noteUsedValue(fontUrl, 'ital', 0);
      }
      if (fontStyles.has('oblique')) {
        // https://www.w3.org/TR/css-fonts-4/#font-style-prop
        // oblique <angle>?
        //   [...] The lack of an <angle> represents 14deg.
        // And also:
        //   Note: the OpenType slnt axis is defined with a positive angle meaning a counter-clockwise slant, the opposite direction to CSS.
        // sThe CSS implementation will take this into account when using variations to produce oblique faces.
        noteUsedValue(fontUrl, 'slnt', -14);
      }
      // If any font-style value except oblique is seen (including normal or italic)
      // we're also utilizing value 0:
      if (fontStyles.size > fontStyles.has('oblique') ? 1 : 0) {
        noteUsedValue(fontUrl, 'slnt', 0);
      }

      const minMaxFontWeight = parseFontWeightRange(props['font-weight']);
      for (const fontWeight of fontWeights) {
        noteUsedValue(
          fontUrl,
          'wght',
          _.clamp(fontWeight, ...minMaxFontWeight)
        );
      }

      const minMaxFontStretch = parseFontStretchRange(props['font-stretch']);
      for (const fontStrech of fontStretches) {
        noteUsedValue(
          fontUrl,
          'wdth',
          _.clamp(fontStrech, ...minMaxFontStretch)
        );
      }

      for (const fontVariationSettingsValue of fontVariationSettings) {
        for (const [axisName, axisValue] of parseFontVariationSettings(
          fontVariationSettingsValue
        )) {
          noteUsedValue(fontUrl, axisName, axisValue);
          if (hasOutOfBoundsAnimationTimingFunction) {
            let outOfBoundsAxes = outOfBoundsAxesByFontUrl.get(fontUrl);
            if (!outOfBoundsAxes) {
              outOfBoundsAxes = new Set();
              outOfBoundsAxesByFontUrl.set(fontUrl, outOfBoundsAxes);
            }
            outOfBoundsAxes.add(axisName);
          }
        }
      }
    }
  }

  return { seenAxisValuesByFontUrlAndAxisName, outOfBoundsAxesByFontUrl };
}

async function warnAboutUnusedVariationAxes(
  assetGraph,
  seenAxisValuesByFontUrlAndAxisName,
  outOfBoundsAxesByFontUrl
) {
  const warnings = [];
  for (const [
    fontUrl,
    seenAxisValuesByAxisName,
  ] of seenAxisValuesByFontUrlAndAxisName.entries()) {
    const outOfBoundsAxes = outOfBoundsAxesByFontUrl.get(fontUrl) || new Set();
    let fontInfo;
    try {
      fontInfo = await getFontInfo(
        assetGraph.findAssets({ url: fontUrl })[0].rawSrc
      );
    } catch (err) {
      // Don't break if we encounter an invalid font
      continue;
    }

    const unusedAxes = [];
    const underutilizedAxes = [];
    for (const [name, { min, max, default: defaultValue }] of Object.entries(
      fontInfo.variationAxes
    )) {
      if (ignoredVariationAxes.has(name)) {
        continue;
      }
      let usedValues = [];
      if (seenAxisValuesByAxisName.has(name) && !outOfBoundsAxes.has(name)) {
        usedValues = [...seenAxisValuesByAxisName.get(name)].map((usedValue) =>
          _.clamp(usedValue, min, max)
        );
      }
      if (!usedValues.every((value) => value === defaultValue)) {
        if (!standardVariationAxes.has(name)) {
          usedValues.push(defaultValue);
        }
        const minUsed = Math.min(...usedValues);
        const maxUsed = Math.max(...usedValues);
        if (minUsed > min || maxUsed < max) {
          underutilizedAxes.push({
            name,
            minUsed,
            maxUsed,
            min,
            max,
          });
        }
      } else {
        unusedAxes.push(name);
      }
    }

    if (unusedAxes.length > 0 || underutilizedAxes.length > 0) {
      let message = `${fontUrl}:\n`;
      if (unusedAxes.length > 0) {
        message += `  Unused axes: ${unusedAxes.join(', ')}\n`;
      }
      if (underutilizedAxes.length > 0) {
        message += `  Underutilized axes:\n${underutilizedAxes
          .map(
            ({ name, min, max, minUsed, maxUsed }) =>
              `    ${name}: ${renderNumberRange(
                minUsed,
                maxUsed
              )} used (${min}-${max} available)`
          )
          .join('\n')}\n`;
      }
      warnings.push(message);
    }
  }

  if (warnings.length > 0) {
    assetGraph.info(
      new Error(`🪓 Unused variation axes detected in your variable fonts.
The below variable fonts contain custom axes that do not appear to be fully used on any of your pages.
This bloats your fonts and also the subset fonts that subfont creates.
Consider removing the unused axis ranges by specifying the --instance switch
${warnings.join('\n')}`)
    );
  }
}

/**
 * Worker pool for running fontTracer in parallel across pages.
 * Each worker re-parses HTML with jsdom and runs fontTracer independently.
 */
class FontTracerPool {
  constructor(numWorkers) {
    this._workerPath = pathModule.join(__dirname, 'fontTracerWorker.js');
    this._numWorkers = numWorkers;
    this._workers = [];
    this._idle = [];
    this._pendingTasks = [];
    this._taskCallbacks = new Map();
    this._taskByWorker = new Map(); // track which taskId each worker is processing
    this._nextTaskId = 0;
  }

  async init() {
    const initPromises = [];
    for (let i = 0; i < this._numWorkers; i++) {
      const worker = new Worker(this._workerPath);
      this._workers.push(worker);

      const initPromise = new Promise((resolve, reject) => {
        const onMessage = (msg) => {
          if (msg.type === 'ready') {
            worker.off('message', onMessage);
            worker.on('message', (msg) => this._onWorkerMessage(worker, msg));
            worker.on('exit', (code) => this._onWorkerExit(worker, code));
            this._idle.push(worker);
            resolve();
          }
        };
        worker.on('message', onMessage);
        worker.on('error', reject);
      });

      worker.postMessage({ type: 'init' });

      initPromises.push(initPromise);
    }
    await Promise.all(initPromises);
  }

  _onWorkerMessage(worker, msg) {
    this._taskByWorker.delete(worker);
    const cb = this._taskCallbacks.get(msg.taskId);
    if (cb) {
      this._taskCallbacks.delete(msg.taskId);
      if (msg.type === 'result') {
        cb.resolve(msg.textByProps);
      } else if (msg.type === 'error') {
        cb.reject(new Error(`Worker error: ${msg.error}\n${msg.stack}`));
      }
    }
    // Worker is now idle, check for pending tasks
    this._idle.push(worker);
    this._dispatchPending();
  }

  _onWorkerExit(worker, code) {
    if (code !== 0) {
      // Worker crashed — remove from idle pool so it's never reused,
      // and reject only the task that was in-flight on this worker.
      const idx = this._idle.indexOf(worker);
      if (idx !== -1) {
        this._idle.splice(idx, 1);
      }
      const taskId = this._taskByWorker.get(worker);
      this._taskByWorker.delete(worker);
      if (taskId !== undefined) {
        const cb = this._taskCallbacks.get(taskId);
        if (cb) {
          this._taskCallbacks.delete(taskId);
          cb.reject(new Error(`Worker exited with code ${code}`));
        }
      }
    }
  }

  _dispatchPending() {
    while (this._idle.length > 0 && this._pendingTasks.length > 0) {
      const worker = this._idle.pop();
      const task = this._pendingTasks.shift();
      this._taskByWorker.set(worker, task.message.taskId);
      worker.postMessage(task.message);
    }
  }

  /**
   * Run fontTracer on the given HTML text + stylesheets in a worker.
   * Returns a promise that resolves to textByProps.
   */
  trace(htmlText, stylesheetsWithPredicates) {
    const taskId = this._nextTaskId++;
    const message = {
      type: 'trace',
      taskId,
      htmlText,
      stylesheetsWithPredicates,
    };

    return new Promise((resolve, reject) => {
      this._taskCallbacks.set(taskId, { resolve, reject });
      this._pendingTasks.push({ message });
      this._dispatchPending();
    });
  }

  async destroy() {
    await Promise.all(this._workers.map((w) => w.terminate()));
    this._workers = [];
    this._idle = [];
  }
}

async function collectTextsByPage(
  assetGraph,
  htmlOrSvgAssets,
  { text, console, dynamic = false } = {}
) {
  const htmlOrSvgAssetTextsWithProps = [];

  const memoizedGetCssRulesByProperty = memoizeSync(getCssRulesByProperty);

  const fontFaceDeclarationsByHtmlOrSvgAsset = new Map();

  // Cache stylesheet-dependent results for pages with identical CSS
  // configurations. The cache key includes CSS asset IDs and relation
  // metadata (media queries, noscript, conditional comments) so pages
  // that link the same stylesheets with different media attributes get
  // separate cache entries.
  const stylesheetResultCache = new Map();

  // Pre-build an index of stylesheet-related relations by source asset
  // to avoid repeated assetGraph.findRelations scans (O(allRelations) each).
  const stylesheetRelTypes = [
    'HtmlStyle',
    'SvgStyle',
    'CssImport',
    'HtmlConditionalComment',
    'HtmlNoscript',
  ];
  const stylesheetRelsByFromAsset = new Map();
  for (const relation of assetGraph.findRelations({
    type: {
      $in: stylesheetRelTypes,
    },
  })) {
    let arr = stylesheetRelsByFromAsset.get(relation.from);
    if (!arr) {
      arr = [];
      stylesheetRelsByFromAsset.set(relation.from, arr);
    }
    arr.push(relation);
  }

  // Build a cache key by traversing stylesheet relations, capturing
  // both asset identity and relation context (media, conditionalComment,
  // noscript) that affect gatherStylesheetsWithPredicates output.
  function getStylesheetCacheKey(htmlOrSvgAsset) {
    const keyParts = [];
    const visited = new Set();
    (function traverse(asset, isNoscript) {
      if (visited.has(asset)) return;
      if (!asset.isLoaded) return;
      visited.add(asset);
      const rels = stylesheetRelsByFromAsset.get(asset) || [];
      for (const relation of rels) {
        if (relation.type === 'HtmlNoscript') {
          traverse(relation.to, true);
        } else if (relation.type === 'HtmlConditionalComment') {
          keyParts.push(`cc:${relation.condition}`);
          traverse(relation.to, isNoscript);
        } else {
          const media = relation.media || '';
          keyParts.push(`${relation.to.id}:${media}:${isNoscript ? 'ns' : ''}`);
          traverse(relation.to, isNoscript);
        }
      }
    })(htmlOrSvgAsset, false);
    return keyParts.join('\x1d');
  }

  function getOrComputeStylesheetResults(htmlOrSvgAsset) {
    const key = getStylesheetCacheKey(htmlOrSvgAsset);
    if (stylesheetResultCache.has(key)) {
      return stylesheetResultCache.get(key);
    }

    const stylesheetsWithPredicates = gatherStylesheetsWithPredicates(
      htmlOrSvgAsset.assetGraph,
      htmlOrSvgAsset,
      stylesheetRelsByFromAsset
    );

    // Compute accumulatedFontFaceDeclarations by traversing CSS relations
    // using the pre-built index instead of assetGraph.eachAssetPreOrder
    const accumulatedFontFaceDeclarations = [];
    {
      const visitedAssets = new Set();
      (function traverseForFontFace(asset) {
        if (visitedAssets.has(asset)) return;
        visitedAssets.add(asset);

        if (asset.type === 'Css' && asset.isLoaded) {
          const seenNodes = new Set();

          const fontRelations = asset.outgoingRelations.filter(
            (relation) => relation.type === 'CssFontFaceSrc'
          );

          for (const fontRelation of fontRelations) {
            const node = fontRelation.node;

            if (!seenNodes.has(node)) {
              seenNodes.add(node);

              const fontFaceDeclaration = {
                relations: fontRelations.filter((r) => r.node === node),
                ...initialValueByProp,
              };

              node.walkDecls((declaration) => {
                const propName = declaration.prop.toLowerCase();
                if (propName === 'font-family') {
                  fontFaceDeclaration[propName] =
                    cssFontParser.parseFontFamily(declaration.value)[0];
                } else {
                  fontFaceDeclaration[propName] = declaration.value;
                }
              });
              // Disregard incomplete @font-face declarations (must contain font-family and src per spec):
              if (
                fontFaceDeclaration['font-family'] &&
                fontFaceDeclaration.src
              ) {
                accumulatedFontFaceDeclarations.push(fontFaceDeclaration);
              }
            }
          }
        }

        // Traverse children using the pre-built index
        const rels = stylesheetRelsByFromAsset.get(asset) || [];
        for (const rel of rels) {
          if (fontFaceTraversalTypes.has(rel.type) || (rel.to && rel.to.type === 'Html' && rel.to.isInline)) {
            traverseForFontFace(rel.to);
          }
        }
      })(htmlOrSvgAsset);
    }

    // Validate font-face combos (once per unique stylesheet set)
    if (accumulatedFontFaceDeclarations.length > 0) {
      const seenFontFaceCombos = new Set();
      for (const fontFace of accumulatedFontFaceDeclarations) {
        const comboKey = `${fontFace['font-family']}/${fontFace['font-style']}/${fontFace['font-weight']}`;
        if (seenFontFaceCombos.has(comboKey)) {
          throw new Error(
            `Multiple @font-face with the same font-family/font-style/font-weight (maybe with different unicode-range?) is not supported yet: ${comboKey}`
          );
        }
        seenFontFaceCombos.add(comboKey);
      }
    }

    const result = { accumulatedFontFaceDeclarations, stylesheetsWithPredicates };
    stylesheetResultCache.set(key, result);
    return result;
  }

  const headlessBrowser = dynamic && new HeadlessBrowser({ console });
  const globalTextByProps = [];

  console.log('[subfont timing] collectTextsByPage started');
  const timingStart = Date.now();

  // Pre-compute stylesheet results for all pages
  const stylesheetPrecomputeStart = Date.now();
  const pageData = [];
  for (const htmlOrSvgAsset of htmlOrSvgAssets) {
    const { accumulatedFontFaceDeclarations, stylesheetsWithPredicates } =
      getOrComputeStylesheetResults(htmlOrSvgAsset);
    fontFaceDeclarationsByHtmlOrSvgAsset.set(
      htmlOrSvgAsset,
      accumulatedFontFaceDeclarations
    );

    if (accumulatedFontFaceDeclarations.length === 0) {
      continue;
    }

    pageData.push({
      htmlOrSvgAsset,
      accumulatedFontFaceDeclarations,
      stylesheetsWithPredicates,
    });
  }

  console.log(`[subfont timing] Stylesheet precompute: ${Date.now() - stylesheetPrecomputeStart}ms (${pageData.length} pages with fonts)`);

  // Template-aware tracing optimization:
  // Group pages by their @font-face declarations rather than exact
  // stylesheet identity. Pages sharing the same font declarations have
  // the same set of available fonts, so font-tracer produces entries
  // with the same `props` structure (same fonts → same CSS cascade for
  // font properties). Only the text content differs.
  //
  // We trace the first page in each declarations group with full
  // font-tracer, then extract text from remaining pages using fast
  // regex-based extraction and reuse the same props structure.
  //
  // This is critical for template-based sites where pages share the
  // same external CSS (and thus the same @font-face rules) but have
  // different inline <style> blocks. Without this, each page would
  // get a unique stylesheet key and need expensive full jsdom tracing.
  //
  // The approximation is safe: fast-extracted pages assign all their
  // visible text to every font props entry. This means each font's
  // character set is a superset of what's strictly needed, but since
  // we compute the global union across all pages anyway, the
  // difference is negligible.
  function getFontFaceGroupKey(declarations) {
    if (declarations.length === 0) return '';
    return declarations
      .map(
        (d) =>
          `${d['font-family']}/${d['font-style']}/${d['font-weight']}/${d['font-stretch']}/${d.src || ''}`
      )
      .join('\x1d');
  }

  const pagesByFontFaceGroup = new Map();
  const pagesNeedingFullTrace = [];
  const pagesForFastExtract = [];

  for (const pd of pageData) {
    const groupKey = getFontFaceGroupKey(pd.accumulatedFontFaceDeclarations);

    if (!pagesByFontFaceGroup.has(groupKey)) {
      // First page with these font declarations — needs full tracing
      pagesByFontFaceGroup.set(groupKey, pd);
      pagesNeedingFullTrace.push(pd);
    } else {
      // Same font declarations — use fast extraction
      pd.templatePage = pagesByFontFaceGroup.get(groupKey);
      pagesForFastExtract.push(pd);
    }
  }

  console.log(`[subfont timing] Pages needing full trace: ${pagesNeedingFullTrace.length}, fast extract: ${pagesForFastExtract.length}`);

  // Use worker pool for parallel fontTracer when there are enough pages
  // and we're not in dynamic (headless browser) mode
  const useWorkerPool = !headlessBrowser && pagesNeedingFullTrace.length >= 4;

  const tracingStart = Date.now();
  try {
    if (useWorkerPool) {
      // Cap at 8 workers to avoid excessive memory usage; each worker
      // loads jsdom + fontTracer which uses ~50-100MB.
      const numWorkers = Math.min(os.cpus().length, pagesNeedingFullTrace.length, 8);
      const pool = new FontTracerPool(numWorkers);
      await pool.init();

      try {
        // Dispatch template pages to the worker pool in parallel
        const tracePromises = pagesNeedingFullTrace.map(async (pd) => {
          try {
            pd.textByProps = await pool.trace(
              pd.htmlOrSvgAsset.text || '',
              pd.stylesheetsWithPredicates
            );
          } catch (err) {
            // Fallback: run on main thread if worker fails
            if (console) {
              console.warn(
                `Worker fontTracer failed for ${pd.htmlOrSvgAsset.url}, falling back to main thread: ${err.message}`
              );
            }
            pd.textByProps = fontTracer(pd.htmlOrSvgAsset.parseTree, {
              stylesheetsWithPredicates: pd.stylesheetsWithPredicates,
              getCssRulesByProperty: memoizedGetCssRulesByProperty,
              asset: pd.htmlOrSvgAsset,
            });
          }
        });
        await Promise.all(tracePromises);
        await pool.destroy();
      } catch (err) {
        await pool.destroy();
        throw err;
      }

    } else if (pagesNeedingFullTrace.length > 0) {
      // Sequential path: few template pages or dynamic mode
      for (const pd of pagesNeedingFullTrace) {
        pd.textByProps = fontTracer(pd.htmlOrSvgAsset.parseTree, {
          stylesheetsWithPredicates: pd.stylesheetsWithPredicates,
          getCssRulesByProperty: memoizedGetCssRulesByProperty,
          asset: pd.htmlOrSvgAsset,
        });
        if (headlessBrowser) {
          pd.textByProps.push(
            ...(await headlessBrowser.tracePage(pd.htmlOrSvgAsset))
          );
        }
      }
    }

    console.log(`[subfont timing] Full tracing (${pagesNeedingFullTrace.length} pages): ${Date.now() - tracingStart}ms`);

    const fastExtractStart = Date.now();
    // Fast text extraction for pages sharing CSS with an already-traced page.
    // Instead of running the full jsdom + font-tracer CSS cascade, we:
    // 1. Extract all visible text from the HTML using regex
    // 2. Create textByProps entries with the same props from the template page
    //    but with this page's text assigned to EACH entry
    //
    // This is correct because:
    // - The global text union per font includes all characters from all pages
    // - Having all text assigned to all font props just means each font's
    //   character set is a superset of what's strictly needed
    // - The difference is negligible since the global union across hundreds
    //   of pages already covers virtually all characters
    // - The template page (fully traced) captures CSS-generated content
    //   (pseudo-elements, counters, etc.) that is identical across pages
    for (const pd of pagesForFastExtract) {
      const templateTextByProps = pd.templatePage.textByProps;
      const pageText = extractVisibleText(pd.htmlOrSvgAsset.text || '');

      // Create textByProps entries reusing the template's props
      // but with this page's extracted text
      pd.textByProps = templateTextByProps.map((templateEntry) => ({
        text: pageText,
        props: { ...templateEntry.props },
      }));
    }

    console.log(`[subfont timing] Fast extraction (${pagesForFastExtract.length} pages): ${Date.now() - fastExtractStart}ms`);

    const assembleStart = Date.now();
    // Assemble results in original page order
    for (const pd of pageData) {
      for (const textByPropsEntry of pd.textByProps) {
        textByPropsEntry.htmlOrSvgAsset = pd.htmlOrSvgAsset;
      }
      globalTextByProps.push(...pd.textByProps);
      htmlOrSvgAssetTextsWithProps.push({
        htmlOrSvgAsset: pd.htmlOrSvgAsset,
        textByProps: pd.textByProps,
        accumulatedFontFaceDeclarations: pd.accumulatedFontFaceDeclarations,
      });
    }

    console.log(`[subfont timing] Result assembly: ${Date.now() - assembleStart}ms`);
    console.log(`[subfont timing] Total tracing+extraction+assembly: ${Date.now() - tracingStart}ms`);
  } finally {
    if (headlessBrowser) {
      await headlessBrowser.close();
    }
  }

  const postProcessStart = Date.now();
  // Pre-compute the expensive font snapping for globalTextByProps once per
  // unique set of font-face declarations, instead of once per page.
  // This eliminates O(pages × globalEntries) fontSnapper calls.
  const snappedEntriesCache = new Map();

  function getDeclarationsKey(declarations) {
    return declarations
      .map(
        (d) =>
          `${d['font-family']}/${d['font-style']}/${d['font-weight']}/${d['font-stretch']}`
      )
      .join('\x1d');
  }

  function computeSnappedGlobalEntries(declarations) {
    const entries = [];
    // Cache snapping results per unique props key within this declarations
    // set. Many globalTextByProps entries share the same font properties
    // (only text differs), so we avoid redundant fontSnapper + family
    // parsing calls.
    const snappingResultCache = new Map();

    for (const textAndProps of globalTextByProps) {
      const family = textAndProps.props['font-family'];
      if (family === undefined) {
        continue;
      }

      // Build a key from the props that affect snapping (not text)
      const propsKey = `${family}\x1d${textAndProps.props['font-weight'] || ''}\x1d${textAndProps.props['font-style'] || ''}\x1d${textAndProps.props['font-stretch'] || ''}`;

      let snappedResults = snappingResultCache.get(propsKey);
      if (!snappedResults) {
        snappedResults = [];
        const families = cssFontParser
          .parseFontFamily(family)
          .filter((fam) =>
            declarations.some(
              (fontFace) =>
                fontFace['font-family'].toLowerCase() === fam.toLowerCase()
            )
          );

        for (const fam of families) {
          const activeFontFaceDeclaration = fontSnapper(declarations, {
            ...textAndProps.props,
            'font-family': stringifyFontFamily(fam),
          });

          if (!activeFontFaceDeclaration) {
            continue;
          }

          const { relations, ...props } = activeFontFaceDeclaration;
          const fontUrl = getPreferredFontUrl(relations);
          if (!fontUrl) {
            continue;
          }

          let fontWeight = normalizeFontPropertyValue(
            'font-weight',
            textAndProps.props['font-weight']
          );
          if (fontWeight === 'normal') {
            fontWeight = 400;
          }

          snappedResults.push({
            fontUrl,
            props,
            fontRelations: relations,
            fontStyle: normalizeFontPropertyValue(
              'font-style',
              textAndProps.props['font-style']
            ),
            fontWeight,
            fontStretch: normalizeFontPropertyValue(
              'font-stretch',
              textAndProps.props['font-stretch']
            ),
          });
        }
        snappingResultCache.set(propsKey, snappedResults);
      }

      for (const snapped of snappedResults) {
        entries.push({
          textAndProps,
          ...snapped,
          fontVariationSettings:
            textAndProps.props['font-variation-settings'],
          animationTimingFunction:
            textAndProps.props['animation-timing-function'],
        });
      }
    }
    return entries;
  }

  // Precompute global fontUsage templates and per-page text indices once per
  // declarations key. This avoids the O(pages × globalEntries) bottleneck by
  // doing the expensive groupBy/join/uniqueChars work once, then cloning per page.
  const globalFontUsageCache = new Map(); // declKey -> fontUsage template array
  const pageTextIndexCache = new Map(); // declKey -> Map<htmlOrSvgAsset, Map<fontUrl, string[]>>
  const preloadEntriesCache = new Map(); // declKey -> Map<textAndProps, fontUrl>

  function getOrComputeGlobalFontUsages(declKey, accumulatedFontFaceDeclarations) {
    if (globalFontUsageCache.has(declKey)) {
      return;
    }

    const snappedGlobalEntries = snappedEntriesCache.get(declKey);

    // Build all indices in a single pass over snappedGlobalEntries:
    // - pageTextIndex: Map<htmlOrSvgAsset, Map<fontUrl, string[]>> for pageText
    // - entriesByFontUrl: Map<fontUrl, entry[]> for building templates
    // - textAndPropsToFontUrl: Map<textAndProps, fontUrl> for preload (inverted index)
    const pageTextIndex = new Map();
    const entriesByFontUrl = new Map();
    const textAndPropsToFontUrl = new Map();

    for (const entry of snappedGlobalEntries) {
      if (!entry.fontUrl) continue;

      // pageTextIndex: group texts by (asset, fontUrl)
      const asset = entry.textAndProps.htmlOrSvgAsset;
      let assetMap = pageTextIndex.get(asset);
      if (!assetMap) {
        assetMap = new Map();
        pageTextIndex.set(asset, assetMap);
      }
      let texts = assetMap.get(entry.fontUrl);
      if (!texts) {
        texts = [];
        assetMap.set(entry.fontUrl, texts);
      }
      texts.push(entry.textAndProps.text);

      // entriesByFontUrl: group entries by fontUrl
      let arr = entriesByFontUrl.get(entry.fontUrl);
      if (!arr) {
        arr = [];
        entriesByFontUrl.set(entry.fontUrl, arr);
      }
      arr.push(entry);

      // Inverted preload index: textAndProps -> fontUrl
      // In the per-page loop we iterate the page's small textByProps and
      // look up which fontUrls they map to, making preload O(|pageTextByProps|).
      textAndPropsToFontUrl.set(entry.textAndProps, entry.fontUrl);
    }

    // Also collect subfont-text / text param contributions per fontUrl
    // These are the same for every page sharing this declarations key
    const extraTextsByFontUrl = new Map();
    for (const fontFaceDeclaration of accumulatedFontFaceDeclarations) {
      const {
        relations,
        '-subfont-text': subfontText,
        ...props
      } = fontFaceDeclaration;
      const fontUrl = getPreferredFontUrl(relations);
      if (!fontUrl) continue;

      const extras = [];
      if (subfontText !== undefined) {
        extras.push(unquote(subfontText));
      }
      if (text !== undefined) {
        extras.push(text);
      }
      if (extras.length > 0) {
        let arr = extraTextsByFontUrl.get(fontUrl);
        if (!arr) {
          arr = { texts: [], props, fontRelations: relations };
          extraTextsByFontUrl.set(fontUrl, arr);
        }
        arr.texts.push(...extras);
      }
    }

    // Build the global fontUsage template for each fontUrl
    const fontUsageTemplates = [];
    const allFontUrls = new Set([...entriesByFontUrl.keys(), ...extraTextsByFontUrl.keys()]);

    for (const fontUrl of allFontUrls) {
      const entries = entriesByFontUrl.get(fontUrl) || [];
      const extra = extraTextsByFontUrl.get(fontUrl);

      // Collect all texts (global entries + extras)
      const allTexts = entries.map((e) => e.textAndProps.text);
      if (extra) {
        allTexts.push(...extra.texts);
      }

      const fontFamilies = new Set(entries.map((e) => e.props['font-family']));
      const fontStyles = new Set(entries.map((e) => e.fontStyle));
      const fontWeights = new Set(entries.map((e) => e.fontWeight));
      const fontStretches = new Set(entries.map((e) => e.fontStretch));
      const fontVariationSettings = new Set(
        entries
          .map((e) => e.fontVariationSettings)
          .filter((fvs) => fvs && fvs.toLowerCase() !== 'normal')
      );
      const hasOutOfBoundsAnimationTimingFunction = entries.some((e) =>
        isOutOfBoundsAnimationTimingFunction(e.animationTimingFunction)
      );

      // Use first entry's relations for size computation, or extra's if no entries
      const fontRelations = entries.length > 0 ? entries[0].fontRelations : extra.fontRelations;
      let smallestOriginalSize;
      let smallestOriginalFormat;
      for (const relation of fontRelations) {
        if (relation.to.isLoaded) {
          const size = relation.to.rawSrc.length;
          if (smallestOriginalSize === undefined || size < smallestOriginalSize) {
            smallestOriginalSize = size;
            smallestOriginalFormat = relation.to.type.toLowerCase();
          }
        }
      }

      const props = entries.length > 0 ? { ...entries[0].props } : { ...extra.props };
      // Pre-join the extra texts (subfont-text / text param) for pageText computation
      const extraTextsStr = extra ? extra.texts.join('') : '';

      fontUsageTemplates.push({
        smallestOriginalSize,
        smallestOriginalFormat,
        texts: allTexts,
        text: uniqueCharsFromArray(allTexts),
        extraTextsStr,
        props,
        fontUrl,
        fontFamilies,
        fontStyles,
        fontStretches,
        fontWeights,
        fontVariationSettings,
        hasOutOfBoundsAnimationTimingFunction,
      });
    }

    globalFontUsageCache.set(declKey, fontUsageTemplates);
    pageTextIndexCache.set(declKey, pageTextIndex);
    preloadEntriesCache.set(declKey, textAndPropsToFontUrl);
  }

  const perPageLoopStart = Date.now();
  let snappingTime = 0;
  let globalUsageTime = 0;
  let cloningTime = 0;

  for (const htmlOrSvgAssetTextsWithPropsEntry of htmlOrSvgAssetTextsWithProps) {
    const { htmlOrSvgAsset, textByProps, accumulatedFontFaceDeclarations } =
      htmlOrSvgAssetTextsWithPropsEntry;

    // Get or compute the snapped global entries for this declarations set
    const declKey = getDeclarationsKey(accumulatedFontFaceDeclarations);
    if (!snappedEntriesCache.has(declKey)) {
      const snapStart = Date.now();
      snappedEntriesCache.set(
        declKey,
        computeSnappedGlobalEntries(accumulatedFontFaceDeclarations)
      );
      snappingTime += Date.now() - snapStart;
    }

    // Precompute global font usage templates and indices once per declarations key
    const globalUsageStart = Date.now();
    getOrComputeGlobalFontUsages(declKey, accumulatedFontFaceDeclarations);
    globalUsageTime += Date.now() - globalUsageStart;

    const fontUsageTemplates = globalFontUsageCache.get(declKey);
    const pageTextIndex = pageTextIndexCache.get(declKey);
    const textAndPropsToFontUrl = preloadEntriesCache.get(declKey);

    // Compute preload per fontUrl using inverted index: iterate the page's
    // small textByProps array and look up each entry's fontUrl. O(|textByProps|)
    const preloadFontUrls = new Set();
    for (const entry of textByProps) {
      const fontUrl = textAndPropsToFontUrl.get(entry);
      if (fontUrl) {
        preloadFontUrls.add(fontUrl);
      }
    }

    // Build per-page fontUsages from precomputed templates.
    // Only pageText and preload differ per page; all other fields are
    // shared by reference from the template (they are never mutated
    // within collectTextsByPage).
    const cloneStart = Date.now();
    const assetTexts = pageTextIndex.get(htmlOrSvgAsset);
    htmlOrSvgAssetTextsWithPropsEntry.fontUsages = fontUsageTemplates.map(
      (template) => {
        // Compute pageText from the pre-built index: O(1) lookup per fontUrl
        const pageTexts = assetTexts ? assetTexts.get(template.fontUrl) : undefined;
        let pageTextStr = pageTexts ? pageTexts.join('') : '';
        if (template.extraTextsStr) {
          pageTextStr += template.extraTextsStr;
        }

        return {
          smallestOriginalSize: template.smallestOriginalSize,
          smallestOriginalFormat: template.smallestOriginalFormat,
          texts: template.texts,
          pageText: uniqueChars(pageTextStr),
          text: template.text,
          props: { ...template.props },
          fontUrl: template.fontUrl,
          fontFamilies: template.fontFamilies,
          fontStyles: template.fontStyles,
          fontStretches: template.fontStretches,
          fontWeights: template.fontWeights,
          fontVariationSettings: template.fontVariationSettings,
          hasOutOfBoundsAnimationTimingFunction:
            template.hasOutOfBoundsAnimationTimingFunction,
          preload: preloadFontUrls.has(template.fontUrl),
        };
      }
    );
    cloningTime += Date.now() - cloneStart;
  }

  console.log(`[subfont timing] Per-page loop: ${Date.now() - perPageLoopStart}ms (snapping: ${snappingTime}ms, globalUsage: ${globalUsageTime}ms, cloning: ${cloningTime}ms)`);
  console.log(`[subfont timing] Post-processing total: ${Date.now() - postProcessStart}ms`);
  console.log(`[subfont timing] collectTextsByPage total: ${Date.now() - timingStart}ms`);

  for (const fontFaceDeclarations of fontFaceDeclarationsByHtmlOrSvgAsset.values()) {
    for (const fontFaceDeclaration of fontFaceDeclarations) {
      const firstRelation = fontFaceDeclaration.relations[0];
      const subfontTextNode = firstRelation.node.nodes.find(
        (childNode) =>
          childNode.type === 'decl' &&
          childNode.prop.toLowerCase() === '-subfont-text'
      );

      if (subfontTextNode) {
        subfontTextNode.remove();
        firstRelation.from.markDirty();
      }
    }
  }
  return { htmlOrSvgAssetTextsWithProps, fontFaceDeclarationsByHtmlOrSvgAsset };
}

async function subsetFonts(
  assetGraph,
  {
    formats = ['woff2', 'woff'],
    subsetPath = 'subfont/',
    omitFallbacks = false,
    instance = false,
    inlineCss,
    fontDisplay,
    hrefType = 'rootRelative',
    onlyInfo,
    dynamic,
    console = global.console,
    text,
    skipSourceMapProcessing = false,
  } = {}
) {
  if (!validFontDisplayValues.includes(fontDisplay)) {
    fontDisplay = undefined;
  }

  const subsetUrl = urltools.ensureTrailingSlash(assetGraph.root + subsetPath);

  let phaseStart = Date.now();
  if (!skipSourceMapProcessing) {
    await assetGraph.applySourceMaps({ type: 'Css' });
  }
  console.log(`[subfont timing] applySourceMaps: ${Date.now() - phaseStart}ms`);

  phaseStart = Date.now();
  await assetGraph.populate({
    followRelations: {
      $or: [
        {
          to: {
            url: { $regex: googleFontsCssUrlRegex },
          },
        },
        {
          type: 'CssFontFaceSrc',
          from: {
            url: { $regex: googleFontsCssUrlRegex },
          },
        },
      ],
    },
  });
  console.log(`[subfont timing] populate (google fonts): ${Date.now() - phaseStart}ms`);

  const htmlOrSvgAssets = assetGraph.findAssets({
    $or: [
      {
        type: 'Html',
        isInline: false,
      },
      {
        type: 'Svg',
      },
    ],
  });

  // Collect texts by page

  console.log(`[subfont timing] Starting collectTextsByPage for ${htmlOrSvgAssets.length} pages`);
  const collectStart = Date.now();
  const { htmlOrSvgAssetTextsWithProps, fontFaceDeclarationsByHtmlOrSvgAsset } =
    await collectTextsByPage(assetGraph, htmlOrSvgAssets, {
      text,
      console,
      dynamic,
    });
  console.log(`[subfont timing] collectTextsByPage finished in ${Date.now() - collectStart}ms`);

  phaseStart = Date.now();

  const potentiallyOrphanedAssets = new Set();
  if (omitFallbacks) {
    for (const htmlOrSvgAsset of htmlOrSvgAssets) {
      const accumulatedFontFaceDeclarations =
        fontFaceDeclarationsByHtmlOrSvgAsset.get(htmlOrSvgAsset);
      // Remove the original @font-face rules:
      for (const { relations } of accumulatedFontFaceDeclarations) {
        for (const relation of relations) {
          potentiallyOrphanedAssets.add(relation.to);
          if (relation.node.parentNode) {
            relation.node.parentNode.removeChild(relation.node);
          }
          relation.remove();
        }
      }
      htmlOrSvgAsset.markDirty();
    }
  }

  console.log(`[subfont timing] omitFallbacks processing: ${Date.now() - phaseStart}ms`);
  phaseStart = Date.now();

  if (fontDisplay) {
    for (const htmlOrSvgAssetTextWithProps of htmlOrSvgAssetTextsWithProps) {
      for (const fontUsage of htmlOrSvgAssetTextWithProps.fontUsages) {
        fontUsage.props['font-display'] = fontDisplay;
      }
    }
  }

  // Generate codepoint sets for original font, the used subset and the unused subset.
  // Pre-compute the global codepoints (original, used, unused) once per fontUrl
  // since fontUsage.text is the same global union on every page.
  const fontAssetByUrl = new Map();
  const globalCodepointsByFontUrl = new Map();
  for (const htmlOrSvgAssetTextWithProps of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of htmlOrSvgAssetTextWithProps.fontUsages) {
      let cached = globalCodepointsByFontUrl.get(fontUsage.fontUrl);
      if (!cached) {
        let originalFont = fontAssetByUrl.get(fontUsage.fontUrl);
        if (!originalFont) {
          originalFont = assetGraph.findAssets({
            url: fontUsage.fontUrl,
          })[0];
          fontAssetByUrl.set(fontUsage.fontUrl, originalFont);
        }
        cached = { originalCodepoints: null };
        if (originalFont.isLoaded) {
          try {
            cached.originalCodepoints = (await getFontInfo(originalFont.rawSrc))
              .characterSet;
          } catch (err) {}
          if (cached.originalCodepoints) {
            cached.usedCodepoints = getCodepoints(fontUsage.text);
            const usedCodepointsSet = new Set(cached.usedCodepoints);
            cached.unusedCodepoints = cached.originalCodepoints.filter(
              (n) => !usedCodepointsSet.has(n)
            );
          }
        }
        globalCodepointsByFontUrl.set(fontUsage.fontUrl, cached);
      }

      if (cached.originalCodepoints) {
        fontUsage.codepoints = {
          original: cached.originalCodepoints,
          used: cached.usedCodepoints,
          unused: cached.unusedCodepoints,
          page: getCodepoints(fontUsage.pageText),
        };
      } else {
        fontUsage.codepoints = {
          original: [],
          used: [],
          unused: [],
          page: [],
        };
      }
    }
  }

  console.log(`[subfont timing] codepoint generation: ${Date.now() - phaseStart}ms`);
  phaseStart = Date.now();

  if (onlyInfo) {
    return {
      fontInfo: htmlOrSvgAssetTextsWithProps.map(
        ({ fontUsages, htmlOrSvgAsset }) => ({
          assetFileName: htmlOrSvgAsset.nonInlineAncestor.urlOrDescription,
          fontUsages: fontUsages,
        })
      ),
    };
  }

  const { seenAxisValuesByFontUrlAndAxisName, outOfBoundsAxesByFontUrl } =
    getVariationAxisUsage(htmlOrSvgAssetTextsWithProps);

  console.log(`[subfont timing] variation axis usage: ${Date.now() - phaseStart}ms`);
  phaseStart = Date.now();

  // Generate subsets:
  await getSubsetsForFontUsage(
    assetGraph,
    htmlOrSvgAssetTextsWithProps,
    formats,
    seenAxisValuesByFontUrlAndAxisName,
    instance
  );

  console.log(`[subfont timing] getSubsetsForFontUsage: ${Date.now() - phaseStart}ms`);
  phaseStart = Date.now();

  await warnAboutMissingGlyphs(htmlOrSvgAssetTextsWithProps, assetGraph);
  console.log(`[subfont timing] warnAboutMissingGlyphs: ${Date.now() - phaseStart}ms`);
  phaseStart = Date.now();

  if (!instance) {
    await warnAboutUnusedVariationAxes(
      assetGraph,
      seenAxisValuesByFontUrlAndAxisName,
      outOfBoundsAxesByFontUrl
    );
  }

  console.log(`[subfont timing] warnAboutUnusedVariationAxes: ${Date.now() - phaseStart}ms`);
  phaseStart = Date.now();

  // Insert subsets:

  // Pre-compute which fontUrls are used (with text) on every page,
  // so we can avoid O(pages × fontUsages) checks inside the font loop.
  const fontUrlsUsedOnEveryPage = new Set();
  if (htmlOrSvgAssetTextsWithProps.length > 0) {
    // Start with all fontUrls from the first page
    const firstPageFontUrls = new Set();
    for (const fu of htmlOrSvgAssetTextsWithProps[0].fontUsages) {
      if (fu.pageText) firstPageFontUrls.add(fu.fontUrl);
    }
    for (const fontUrl of firstPageFontUrls) {
      if (
        htmlOrSvgAssetTextsWithProps.every(({ fontUsages }) =>
          fontUsages.some(
            (fu) => fu.pageText && fu.fontUrl === fontUrl
          )
        )
      ) {
        fontUrlsUsedOnEveryPage.add(fontUrl);
      }
    }
  }

  // Cache subset CSS assets by their source text to avoid redundant
  // addAsset/minify/removeAsset cycles for pages sharing identical CSS.
  const subsetCssAssetCache = new Map();

  // Pre-index relations by source asset to avoid O(allRelations) scans
  // in the per-page injection loop below. Build indices once, then use
  // O(1) lookups per page instead of repeated assetGraph.findRelations.
  const styleRelsByAsset = new Map();
  const noscriptRelsByAsset = new Map();
  const preloadRelsByAsset = new Map();
  for (const relation of assetGraph.findRelations({
    type: { $in: ['HtmlStyle', 'SvgStyle', 'HtmlNoscript', 'HtmlPrefetchLink', 'HtmlPreloadLink'] },
  })) {
    const from = relation.from;
    if (relation.type === 'HtmlStyle' || relation.type === 'SvgStyle') {
      if (!styleRelsByAsset.has(from)) styleRelsByAsset.set(from, []);
      styleRelsByAsset.get(from).push(relation);
    } else if (relation.type === 'HtmlNoscript') {
      if (!noscriptRelsByAsset.has(from)) noscriptRelsByAsset.set(from, []);
      noscriptRelsByAsset.get(from).push(relation);
    } else {
      if (!preloadRelsByAsset.has(from)) preloadRelsByAsset.set(from, []);
      preloadRelsByAsset.get(from).push(relation);
    }
  }

  let numFontUsagesWithSubset = 0;
  for (const {
    htmlOrSvgAsset,
    fontUsages,
    accumulatedFontFaceDeclarations,
  } of htmlOrSvgAssetTextsWithProps) {
    const styleRels = styleRelsByAsset.get(htmlOrSvgAsset) || [];
    let insertionPoint = styleRels[0];

    // Hackingly deal with the original stylesheet being located inside <noscript>
    // https://github.com/assetgraph/assetgraph/issues/1251
    if (!insertionPoint && htmlOrSvgAsset.type === 'Html') {
      for (const htmlNoScript of (noscriptRelsByAsset.get(htmlOrSvgAsset) || [])) {
        const noscriptStyleRels = styleRelsByAsset.get(htmlNoScript.to) || [];
        if (noscriptStyleRels.length > 0) {
          insertionPoint = htmlNoScript;
          break;
        }
      }
    }
    const subsetFontUsages = fontUsages.filter(
      (fontUsage) => fontUsage.subsets
    );
    const subsetFontUsagesSet = new Set(subsetFontUsages);
    const unsubsettedFontUsages = fontUsages.filter(
      (fontUsage) => !subsetFontUsagesSet.has(fontUsage)
    );

    // Remove all existing preload hints to fonts that might have new subsets
    const fontUrls = new Set(fontUsages.map((fu) => fu.fontUrl));
    for (const relation of (preloadRelsByAsset.get(htmlOrSvgAsset) || [])) {
      if (relation.to && fontUrls.has(relation.to.url)) {
        if (relation.type === 'HtmlPrefetchLink') {
          const err = new Error(
            `Detached ${relation.node.outerHTML}. Will be replaced with preload with JS fallback.\nIf you feel this is wrong, open an issue at https://github.com/Munter/subfont/issues`
          );
          err.asset = relation.from;
          err.relation = relation;

          assetGraph.info(err);
        }

        relation.detach();
      }
    }

    const unsubsettedFontUsagesToPreload = unsubsettedFontUsages.filter(
      (fontUsage) => fontUsage.preload
    );

    if (unsubsettedFontUsagesToPreload.length > 0) {
      // Insert <link rel="preload">
      for (const fontUsage of unsubsettedFontUsagesToPreload) {
        // Always preload unsubsetted font files, they might be any format, so can't be clever here
        const preloadRelation = htmlOrSvgAsset.addRelation(
          {
            type: 'HtmlPreloadLink',
            hrefType,
            to: fontUsage.fontUrl,
            as: 'font',
          },
          insertionPoint ? 'before' : 'firstInHead',
          insertionPoint
        );
        insertionPoint = insertionPoint || preloadRelation;
      }
    }

    if (subsetFontUsages.length === 0) {
      continue;
    }
    numFontUsagesWithSubset += subsetFontUsages.length;

    let subsetCssText = getFontUsageStylesheet(subsetFontUsages);
    const unusedVariantsCss = getUnusedVariantsStylesheet(
      fontUsages,
      accumulatedFontFaceDeclarations
    );
    if (!inlineCss && !omitFallbacks) {
      // This can go into the same stylesheet because we won't reload all __subset suffixed families in the JS preload fallback
      subsetCssText += unusedVariantsCss;
    }

    let cssAsset = subsetCssAssetCache.get(subsetCssText);
    if (!cssAsset) {
      cssAsset = assetGraph.addAsset({
        type: 'Css',
        url: `${subsetUrl}subfontTemp.css`,
        text: subsetCssText,
      });

      await cssAsset.minify();

      for (const [i, fontRelation] of cssAsset.outgoingRelations.entries()) {
        const fontAsset = fontRelation.to;
        if (!fontAsset.isLoaded) {
          // An unused variant that does not exist, don't try to hash
          fontRelation.hrefType = hrefType;
          continue;
        }

        const fontUsage = subsetFontUsages[i];
        if (
          formats.length === 1 &&
          fontUsage &&
          (!inlineCss || htmlOrSvgAssetTextsWithProps.length === 1) &&
          fontUrlsUsedOnEveryPage.has(fontUsage.fontUrl)
        ) {
          // We're only outputting one font format, we're not inlining the subfont CSS (or there's only one page), and this font is used on every page -- keep it inline in the subfont CSS
          continue;
        }

        const extension = fontAsset.contentType.split('/').pop();

        const nameProps = ['font-family', 'font-weight', 'font-style']
          .map((prop) =>
            fontRelation.node.nodes.find((decl) => decl.prop === prop)
          )
          .map((decl) => decl.value);

        const fontWeightRangeStr = nameProps[1]
          .split(/\s+/)
          .map((token) => normalizeFontPropertyValue('font-weight', token))
          .join('_');
        const fileNamePrefix = `${unquote(
          cssFontParser.parseFontFamily(nameProps[0])[0]
        )
          .replace(/__subset$/, '')
          .replace(/[^a-z0-9_-]/gi, '_')}-${fontWeightRangeStr}${
          nameProps[2] === 'italic' ? 'i' : ''
        }`;

        const fontFileName = `${fileNamePrefix}-${fontAsset.md5Hex.slice(
          0,
          10
        )}.${extension}`;

        // If it's not inline, it's one of the unused variants that gets a mirrored declaration added
        // for the __subset @font-face. Do not move it to /subfont/
        if (fontAsset.isInline) {
          const fontAssetUrl = subsetUrl + fontFileName;
          const existingFontAsset = assetGraph.findAssets({
            url: fontAssetUrl,
          })[0];
          if (existingFontAsset && fontAsset.isInline) {
            fontRelation.to = existingFontAsset;
            assetGraph.removeAsset(fontAsset);
          } else {
            fontAsset.url = subsetUrl + fontFileName;
          }
        }

        fontRelation.hrefType = hrefType;
      }

      const cssAssetUrl = `${subsetUrl}fonts-${cssAsset.md5Hex.slice(0, 10)}.css`;
      const existingCssAsset = assetGraph.findAssets({ url: cssAssetUrl })[0];
      if (existingCssAsset) {
        assetGraph.removeAsset(cssAsset);
        cssAsset = existingCssAsset;
      } else {
        cssAsset.url = cssAssetUrl;
      }
      subsetCssAssetCache.set(subsetCssText, cssAsset);
    }

    for (const fontRelation of cssAsset.outgoingRelations) {
      if (fontRelation.hrefType === 'inline') {
        continue;
      }
      const fontAsset = fontRelation.to;

      if (
        fontAsset.contentType === 'font/woff2' &&
        fontRelation.to.url.startsWith(subsetUrl)
      ) {
        const fontFaceDeclaration = fontRelation.node;
        const originalFontFamily = unquote(
          fontFaceDeclaration.nodes.find((node) => node.prop === 'font-family')
            .value
        ).replace(/__subset$/, '');
        if (
          !fontUsages.some(
            (fontUsage) =>
              fontUsage.fontFamilies.has(originalFontFamily) &&
              fontUsage.preload
          )
        ) {
          continue;
        }

        // Only <link rel="preload"> for woff2 files
        // Preload support is a subset of woff2 support:
        // - https://caniuse.com/#search=woff2
        // - https://caniuse.com/#search=preload

        if (htmlOrSvgAsset.type === 'Html') {
          const htmlPreloadLink = htmlOrSvgAsset.addRelation(
            {
              type: 'HtmlPreloadLink',
              hrefType,
              to: fontAsset,
              as: 'font',
            },
            insertionPoint ? 'before' : 'firstInHead',
            insertionPoint
          );
          insertionPoint = insertionPoint || htmlPreloadLink;
        }
      }
    }
    const cssRelation = htmlOrSvgAsset.addRelation(
      {
        type: `${htmlOrSvgAsset.type}Style`,
        hrefType:
          inlineCss || htmlOrSvgAsset.type === 'Svg' ? 'inline' : hrefType,
        to: cssAsset,
      },
      insertionPoint ? 'before' : 'firstInHead',
      insertionPoint
    );
    insertionPoint = insertionPoint || cssRelation;

    if (!omitFallbacks && inlineCss && unusedVariantsCss) {
      // The fallback CSS for unused variants needs to go into its own stylesheet after the crude version of the JS-based preload "polyfill"
      const cssAsset = htmlOrSvgAsset.addRelation(
        {
          type: 'HtmlStyle',
          to: {
            type: 'Css',
            text: unusedVariantsCss,
          },
        },
        'after',
        cssRelation
      ).to;
      for (const relation of cssAsset.outgoingRelations) {
        relation.hrefType = hrefType;
      }
    }
  }

  console.log(`[subfont timing] insert subsets loop: ${Date.now() - phaseStart}ms`);
  phaseStart = Date.now();

  if (numFontUsagesWithSubset === 0) {
    return { fontInfo: [] };
  }

  const relationsToRemove = new Set();

  // Lazy load the original @font-face declarations of self-hosted fonts (unless omitFallbacks)
  const originalRelations = new Set();
  const fallbackCssAssetCache = new Map();
  for (const htmlOrSvgAsset of htmlOrSvgAssets) {
    const accumulatedFontFaceDeclarations =
      fontFaceDeclarationsByHtmlOrSvgAsset.get(htmlOrSvgAsset);
    // TODO: Maybe group by media?
    const containedRelationsByFontFaceRule = new Map();
    for (const { relations } of accumulatedFontFaceDeclarations) {
      for (const relation of relations) {
        if (
          relation.from.hostname === 'fonts.googleapis.com' || // Google Web Fonts handled separately below
          containedRelationsByFontFaceRule.has(relation.node)
        ) {
          continue;
        }
        originalRelations.add(relation);
        containedRelationsByFontFaceRule.set(
          relation.node,
          relation.from.outgoingRelations.filter(
            (otherRelation) => otherRelation.node === relation.node
          )
        );
      }
    }

    if (containedRelationsByFontFaceRule.size > 0 && !omitFallbacks) {
      const fallbackCssText = [...containedRelationsByFontFaceRule.keys()]
        .map((rule) =>
          getFontFaceDeclarationText(
            rule,
            containedRelationsByFontFaceRule.get(rule)
          )
        )
        .join('');

      let cssAsset = fallbackCssAssetCache.get(fallbackCssText);
      if (!cssAsset) {
        cssAsset = assetGraph.addAsset({
          type: 'Css',
          text: fallbackCssText,
        });
        for (const relation of cssAsset.outgoingRelations) {
          relation.hrefType = hrefType;
        }
        await cssAsset.minify();
        cssAsset.url = `${subsetUrl}fallback-${cssAsset.md5Hex.slice(
          0,
          10
        )}.css`;
        fallbackCssAssetCache.set(fallbackCssText, cssAsset);
      }

      if (htmlOrSvgAsset.type === 'Html') {
        // Create a <link rel="stylesheet"> that asyncLoadStyleRelationWithFallback can convert to async with noscript fallback:
        const fallbackHtmlStyle = htmlOrSvgAsset.addRelation({
          type: 'HtmlStyle',
          to: cssAsset,
        });

        asyncLoadStyleRelationWithFallback(
          htmlOrSvgAsset,
          fallbackHtmlStyle,
          hrefType
        );
        relationsToRemove.add(fallbackHtmlStyle);
      }
    }
  }

  console.log(`[subfont timing] lazy load fallback CSS: ${Date.now() - phaseStart}ms`);
  phaseStart = Date.now();

  // Remove the original @font-face blocks, and don't leave behind empty stylesheets:
  const maybeEmptyCssAssets = new Set();
  for (const relation of originalRelations) {
    const cssAsset = relation.from;
    if (relation.node.parent) {
      relation.node.parent.removeChild(relation.node);
    }
    relation.remove();
    cssAsset.markDirty();
    maybeEmptyCssAssets.add(cssAsset);
  }

  for (const cssAsset of maybeEmptyCssAssets) {
    if (cssAssetIsEmpty(cssAsset)) {
      for (const incomingRelation of cssAsset.incomingRelations) {
        incomingRelation.detach();
      }
      assetGraph.removeAsset(cssAsset);
    }
  }

  console.log(`[subfont timing] remove original @font-face: ${Date.now() - phaseStart}ms`);
  phaseStart = Date.now();

  // Async load Google Web Fonts CSS
  const googleFontStylesheets = assetGraph.findAssets({
    type: 'Css',
    url: { $regex: googleFontsCssUrlRegex },
  });
  const selfHostedGoogleCssByUrl = new Map();
  for (const googleFontStylesheet of googleFontStylesheets) {
    const seenPages = new Set(); // Only do the work once for each font on each page
    for (const googleFontStylesheetRelation of googleFontStylesheet.incomingRelations) {
      let htmlParents;

      if (googleFontStylesheetRelation.type === 'CssImport') {
        // Gather Html parents. Relevant if we are dealing with CSS @import relations
        htmlParents = getParents(googleFontStylesheetRelation.to, {
          type: { $in: ['Html', 'Svg'] },
          isInline: false,
          isLoaded: true,
        });
      } else if (
        ['Html', 'Svg'].includes(googleFontStylesheetRelation.from.type)
      ) {
        htmlParents = [googleFontStylesheetRelation.from];
      } else {
        htmlParents = [];
      }
      for (const htmlParent of htmlParents) {
        if (seenPages.has(htmlParent)) {
          continue;
        }
        seenPages.add(htmlParent);

        if (!omitFallbacks) {
          let selfHostedGoogleFontsCssAsset = selfHostedGoogleCssByUrl.get(
            googleFontStylesheetRelation.to.url
          );
          if (!selfHostedGoogleFontsCssAsset) {
            selfHostedGoogleFontsCssAsset =
              await createSelfHostedGoogleFontsCssAsset(
                assetGraph,
                googleFontStylesheetRelation.to,
                formats,
                hrefType,
                subsetUrl
              );
            await selfHostedGoogleFontsCssAsset.minify();
            selfHostedGoogleCssByUrl.set(
              googleFontStylesheetRelation.to.url,
              selfHostedGoogleFontsCssAsset
            );
          }
          const selfHostedFallbackRelation = htmlParent.addRelation(
            {
              type: `${htmlParent.type}Style`,
              to: selfHostedGoogleFontsCssAsset,
              hrefType,
            },
            'lastInBody'
          );
          relationsToRemove.add(selfHostedFallbackRelation);
          if (htmlParent.type === 'Html') {
            asyncLoadStyleRelationWithFallback(
              htmlParent,
              selfHostedFallbackRelation,
              hrefType
            );
          }
        }
        relationsToRemove.add(googleFontStylesheetRelation);
      }
    }
    googleFontStylesheet.unload();
  }

  // Clean up, making sure not to detach the same relation twice, eg. when multiple pages use the same stylesheet that imports a font
  for (const relation of relationsToRemove) {
    relation.detach();
  }

  console.log(`[subfont timing] Google Fonts + cleanup: ${Date.now() - phaseStart}ms`);
  phaseStart = Date.now();

  // Use subsets in font-family:

  const webfontNameMap = {};

  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const { subsets, fontFamilies, props } of fontUsages) {
      if (subsets) {
        for (const fontFamily of fontFamilies) {
          webfontNameMap[
            fontFamily.toLowerCase()
          ] = `${props['font-family']}__subset`;
        }
      }
    }
  }

  let customPropertyDefinitions; // Avoid computing this unless necessary
  // Inject subset font name before original webfont in SVG font-family attributes
  const svgAssets = assetGraph.findAssets({ type: 'Svg' });
  for (const svgAsset of svgAssets) {
    if (!svgAsset.isLoaded) continue;
    let changesMade = false;
    for (const element of Array.from(
      svgAsset.parseTree.querySelectorAll('[font-family]')
    )) {
      const fontFamilies = cssListHelpers.splitByCommas(
        element.getAttribute('font-family')
      );
      for (let i = 0; i < fontFamilies.length; i += 1) {
        const subsetFontFamily =
          webfontNameMap[
            cssFontParser.parseFontFamily(fontFamilies[i])[0].toLowerCase()
          ];
        if (subsetFontFamily && !fontFamilies.includes(subsetFontFamily)) {
          fontFamilies.splice(
            i,
            omitFallbacks ? 1 : 0,
            cssQuoteIfNecessary(subsetFontFamily)
          );
          i += 1;
          element.setAttribute('font-family', fontFamilies.join(', '));
          changesMade = true;
        }
      }
    }
    if (changesMade) {
      svgAsset.markDirty();
    }
  }

  // Inject subset font name before original webfont in CSS
  const cssAssets = assetGraph.findAssets({
    type: 'Css',
    isLoaded: true,
  });
  let changesMadeToCustomPropertyDefinitions = false;
  for (const cssAsset of cssAssets) {
    let changesMade = false;
    cssAsset.eachRuleInParseTree((cssRule) => {
      if (cssRule.parent.type === 'rule' && cssRule.type === 'decl') {
        const propName = cssRule.prop.toLowerCase();
        if (
          (propName === 'font' || propName === 'font-family') &&
          cssRule.value.includes('var(')
        ) {
          if (!customPropertyDefinitions) {
            customPropertyDefinitions =
              findCustomPropertyDefinitions(cssAssets);
          }
          for (const customPropertyName of extractReferencedCustomPropertyNames(
            cssRule.value
          )) {
            for (const relatedCssRule of [
              cssRule,
              ...(customPropertyDefinitions[customPropertyName] || []),
            ]) {
              const modifiedValue = injectSubsetDefinitions(
                relatedCssRule.value,
                webfontNameMap,
                omitFallbacks // replaceOriginal
              );
              if (modifiedValue !== relatedCssRule.value) {
                relatedCssRule.value = modifiedValue;
                changesMadeToCustomPropertyDefinitions = true;
              }
            }
          }
        } else if (propName === 'font-family') {
          const fontFamilies = cssListHelpers.splitByCommas(cssRule.value);
          for (let i = 0; i < fontFamilies.length; i += 1) {
            const subsetFontFamily =
              webfontNameMap[
                cssFontParser.parseFontFamily(fontFamilies[i])[0].toLowerCase()
              ];
            if (subsetFontFamily && !fontFamilies.includes(subsetFontFamily)) {
              fontFamilies.splice(
                i,
                omitFallbacks ? 1 : 0,
                cssQuoteIfNecessary(subsetFontFamily)
              );
              i += 1;
              cssRule.value = fontFamilies.join(', ');
              changesMade = true;
            }
          }
        } else if (propName === 'font') {
          const fontProperties = cssFontParser.parseFont(cssRule.value);
          const fontFamilies =
            fontProperties && fontProperties['font-family'].map(unquote);
          if (fontFamilies) {
            const subsetFontFamily =
              webfontNameMap[fontFamilies[0].toLowerCase()];
            if (subsetFontFamily && !fontFamilies.includes(subsetFontFamily)) {
              // FIXME: Clean up and move elsewhere
              if (omitFallbacks) {
                fontFamilies.shift();
              }
              fontFamilies.unshift(subsetFontFamily);
              const stylePrefix = fontProperties['font-style']
                ? `${fontProperties['font-style']} `
                : '';
              const weightPrefix = fontProperties['font-weight']
                ? `${fontProperties['font-weight']} `
                : '';
              const lineHeightSuffix = fontProperties['line-height']
                ? `/${fontProperties['line-height']}`
                : '';
              cssRule.value = `${stylePrefix}${weightPrefix}${
                fontProperties['font-size']
              }${lineHeightSuffix} ${fontFamilies
                .map(cssQuoteIfNecessary)
                .join(', ')}`;
              changesMade = true;
            }
          }
        }
      }
    });
    if (changesMade) {
      cssAsset.markDirty();
    }
  }

  // This is a bit crude, could be more efficient if we tracked the containing asset in findCustomPropertyDefinitions
  if (changesMadeToCustomPropertyDefinitions) {
    for (const cssAsset of cssAssets) {
      cssAsset.markDirty();
    }
  }

  console.log(`[subfont timing] inject subset font-family into CSS/SVG: ${Date.now() - phaseStart}ms`);
  phaseStart = Date.now();

  if (!skipSourceMapProcessing) {
    await assetGraph.serializeSourceMaps(undefined, {
      type: 'Css',
      outgoingRelations: {
        $where: (relations) =>
          relations.some(
            (relation) => relation.type === 'CssSourceMappingUrl'
          ),
      },
    });
    for (const relation of assetGraph.findRelations({
      type: 'SourceMapSource',
    })) {
      relation.hrefType = hrefType;
    }
    for (const relation of assetGraph.findRelations({
      type: 'CssSourceMappingUrl',
      hrefType: { $in: ['relative', 'inline'] },
    })) {
      relation.hrefType = hrefType;
    }
  }

  for (const asset of potentiallyOrphanedAssets) {
    if (asset.incomingRelations.length === 0) {
      assetGraph.removeAsset(asset);
    }
  }

  console.log(`[subfont timing] source maps + orphan cleanup: ${Date.now() - phaseStart}ms`);

  // Hand out some useful info about the detected subsets:
  return {
    fontInfo: htmlOrSvgAssetTextsWithProps.map(
      ({ fontUsages, htmlOrSvgAsset }) => ({
        assetFileName: htmlOrSvgAsset.nonInlineAncestor.urlOrDescription,
        fontUsages: fontUsages.map((fontUsage) => _.omit(fontUsage, 'subsets')),
      })
    ),
  };
}

module.exports = subsetFonts;
