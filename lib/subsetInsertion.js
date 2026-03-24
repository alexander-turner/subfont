const cssFontParser = require('css-font-parser');

const unquote = require('./unquote');
const normalizeFontPropertyValue = require('./normalizeFontPropertyValue');
const {
  getFontFaceDeclarationText,
  getUnusedVariantsStylesheet,
  getFontUsageStylesheet,
} = require('./fontFaceHelpers');
const {
  googleFontsCssUrlRegex,
  getParents,
  asyncLoadStyleRelationWithFallback,
  createSelfHostedGoogleFontsCssAsset,
} = require('./googleFonts');

function buildRelationIndices(assetGraph) {
  const styleRelsByAsset = new Map();
  const noscriptRelsByAsset = new Map();
  const preloadRelsByAsset = new Map();
  for (const relation of assetGraph.findRelations({
    type: {
      $in: [
        'HtmlStyle',
        'SvgStyle',
        'HtmlNoscript',
        'HtmlPrefetchLink',
        'HtmlPreloadLink',
      ],
    },
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
  return { styleRelsByAsset, noscriptRelsByAsset, preloadRelsByAsset };
}

function findInsertionPoint(
  htmlOrSvgAsset,
  styleRelsByAsset,
  noscriptRelsByAsset
) {
  const styleRels = styleRelsByAsset.get(htmlOrSvgAsset) || [];
  let insertionPoint = styleRels[0];

  if (!insertionPoint && htmlOrSvgAsset.type === 'Html') {
    for (const htmlNoScript of noscriptRelsByAsset.get(htmlOrSvgAsset) || []) {
      const noscriptStyleRels = styleRelsByAsset.get(htmlNoScript.to) || [];
      if (noscriptStyleRels.length > 0) {
        insertionPoint = htmlNoScript;
        break;
      }
    }
  }
  return insertionPoint;
}

function computeFontUrlsUsedOnEveryPage(htmlOrSvgAssetTextsWithProps) {
  const fontUrlsUsedOnEveryPage = new Set();
  if (htmlOrSvgAssetTextsWithProps.length > 0) {
    const firstPageFontUrls = new Set();
    for (const fu of htmlOrSvgAssetTextsWithProps[0].fontUsages) {
      if (fu.pageText) firstPageFontUrls.add(fu.fontUrl);
    }
    for (const fontUrl of firstPageFontUrls) {
      if (
        htmlOrSvgAssetTextsWithProps.every(({ fontUsages }) =>
          fontUsages.some((fu) => fu.pageText && fu.fontUrl === fontUrl)
        )
      ) {
        fontUrlsUsedOnEveryPage.add(fontUrl);
      }
    }
  }
  return fontUrlsUsedOnEveryPage;
}

// Insert subset CSS, preload links, and font assets into the asset graph.
// Returns the count of font usages that have subsets.
async function insertSubsets(
  assetGraph,
  htmlOrSvgAssetTextsWithProps,
  { formats, subsetUrl, omitFallbacks, inlineCss, hrefType }
) {
  const { styleRelsByAsset, noscriptRelsByAsset, preloadRelsByAsset } =
    buildRelationIndices(assetGraph);
  const fontUrlsUsedOnEveryPage = computeFontUrlsUsedOnEveryPage(
    htmlOrSvgAssetTextsWithProps
  );
  const subsetCssAssetCache = new Map();
  let numFontUsagesWithSubset = 0;

  for (const {
    htmlOrSvgAsset,
    fontUsages,
    accumulatedFontFaceDeclarations,
  } of htmlOrSvgAssetTextsWithProps) {
    let insertionPoint = findInsertionPoint(
      htmlOrSvgAsset,
      styleRelsByAsset,
      noscriptRelsByAsset
    );

    const subsetFontUsages = fontUsages.filter(
      (fontUsage) => fontUsage.subsets
    );
    const subsetFontUsagesSet = new Set(subsetFontUsages);
    const unsubsettedFontUsages = fontUsages.filter(
      (fontUsage) => !subsetFontUsagesSet.has(fontUsage)
    );

    // Remove existing preload hints for fonts that will get new subsets
    const fontUrls = new Set(fontUsages.map((fu) => fu.fontUrl));
    for (const relation of preloadRelsByAsset.get(htmlOrSvgAsset) || []) {
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

    // Preload unsubsetted fonts
    const unsubsettedFontUsagesToPreload = unsubsettedFontUsages.filter(
      (fontUsage) => fontUsage.preload
    );
    for (const fontUsage of unsubsettedFontUsagesToPreload) {
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

    if (subsetFontUsages.length === 0) continue;
    numFontUsagesWithSubset += subsetFontUsages.length;

    let subsetCssText = getFontUsageStylesheet(subsetFontUsages);
    const unusedVariantsCss = getUnusedVariantsStylesheet(
      fontUsages,
      accumulatedFontFaceDeclarations
    );
    if (!inlineCss && !omitFallbacks) {
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

        if (fontAsset.isInline) {
          const fontAssetUrl = subsetUrl + fontFileName;
          const existingFontAsset = assetGraph.findAssets({
            url: fontAssetUrl,
          })[0];
          if (existingFontAsset) {
            fontRelation.to = existingFontAsset;
            assetGraph.removeAsset(fontAsset);
          } else {
            fontAsset.url = subsetUrl + fontFileName;
          }
        }

        fontRelation.hrefType = hrefType;
      }

      const cssAssetUrl = `${subsetUrl}fonts-${cssAsset.md5Hex.slice(
        0,
        10
      )}.css`;
      const existingCssAsset = assetGraph.findAssets({ url: cssAssetUrl })[0];
      if (existingCssAsset) {
        assetGraph.removeAsset(cssAsset);
        cssAsset = existingCssAsset;
      } else {
        cssAsset.url = cssAssetUrl;
      }
      subsetCssAssetCache.set(subsetCssText, cssAsset);
    }

    // Add preload links for woff2 subset fonts
    for (const fontRelation of cssAsset.outgoingRelations) {
      if (fontRelation.hrefType === 'inline') continue;
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
      const inlineCssAsset = htmlOrSvgAsset.addRelation(
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
      for (const relation of inlineCssAsset.outgoingRelations) {
        relation.hrefType = hrefType;
      }
    }
  }

  return numFontUsagesWithSubset;
}

// Lazy-load original @font-face declarations and handle Google Fonts
async function insertFallbacks(
  assetGraph,
  htmlOrSvgAssets,
  htmlOrSvgAssetTextsWithProps,
  fontFaceDeclarationsByHtmlOrSvgAsset,
  { formats, subsetUrl, omitFallbacks, hrefType }
) {
  const relationsToRemove = new Set();
  const originalRelations = new Set();
  const fallbackCssAssetCache = new Map();

  for (const htmlOrSvgAsset of htmlOrSvgAssets) {
    const accumulatedFontFaceDeclarations =
      fontFaceDeclarationsByHtmlOrSvgAsset.get(htmlOrSvgAsset);
    const containedRelationsByFontFaceRule = new Map();
    for (const { relations } of accumulatedFontFaceDeclarations) {
      for (const relation of relations) {
        if (
          relation.from.hostname === 'fonts.googleapis.com' ||
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

  // Remove original @font-face blocks and clean up empty stylesheets
  const maybeEmptyCssAssets = new Set();
  const { cssAssetIsEmpty } = require('./fontFaceHelpers');
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

  // Async-load Google Web Fonts CSS
  const googleFontStylesheets = assetGraph.findAssets({
    type: 'Css',
    url: { $regex: googleFontsCssUrlRegex },
  });
  const selfHostedGoogleCssByUrl = new Map();
  for (const googleFontStylesheet of googleFontStylesheets) {
    const seenPages = new Set();
    for (const googleFontStylesheetRelation of googleFontStylesheet.incomingRelations) {
      let htmlParents;

      if (googleFontStylesheetRelation.type === 'CssImport') {
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
        if (seenPages.has(htmlParent)) continue;
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

  for (const relation of relationsToRemove) {
    relation.detach();
  }
}

module.exports = { insertSubsets, insertFallbacks };
