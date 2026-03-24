const fontverter = require('fontverter');

const getFontInfo = require('./getFontInfo');
const unicodeRange = require('./unicodeRange');
const { md5HexPrefix } = require('./fontFaceHelpers');

const compileQuery = require('assetgraph/lib/compileQuery');

const googleFontsCssUrlRegex =
  /^(?:https?:)?\/\/fonts\.googleapis\.com\/css/;

const extensionByFormat = {
  truetype: '.ttf',
  woff: '.woff',
  woff2: '.woff2',
};

function getParents(asset, assetQuery) {
  const assetMatcher = compileQuery(assetQuery);
  const seenAssets = new Set();
  const parents = [];
  (function visit(asset) {
    if (seenAssets.has(asset)) return;
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
      const rawSrc = await fontverter.convert(
        cssFontFaceSrc.to.rawSrc,
        format
      );
      const url = assetGraph.resolveUrl(
        subsetUrl,
        `${cssFontFaceSrc.to.baseName}-${md5HexPrefix(rawSrc)}${
          extensionByFormat[format]
        }`
      );
      const fontAsset =
        assetGraph.findAssets({ url })[0] ||
        (await assetGraph.addAsset({ url, rawSrc }));
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
  return assetGraph.addAsset({
    type: 'Css',
    url: assetGraph.resolveUrl(subsetUrl, `fallback-${md5HexPrefix(text)}.css`),
    text,
  });
}

module.exports = {
  googleFontsCssUrlRegex,
  getParents,
  asyncLoadStyleRelationWithFallback,
  createSelfHostedGoogleFontsCssAsset,
};
