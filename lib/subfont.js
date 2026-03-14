const AssetGraph = require('assetgraph');
const prettyBytes = require('pretty-bytes');
const browsersList = require('browserslist');
const _ = require('lodash');
const urlTools = require('urltools');
const util = require('util');
const subsetFonts = require('./subsetFonts');

module.exports = async function subfont(
  {
    root,
    canonicalRoot,
    output,
    debug = false,
    dryRun = false,
    silent = false,
    inlineCss = false,
    fontDisplay = 'swap',
    formats,
    inPlace = false,
    inputFiles = [],
    recursive = false,
    relativeUrls = false,
    fallbacks = true,
    dynamic = false,
    instance = false,
    browsers,
    text,
    skipSourceMapProcessing = false,
  },
  console
) {
  function logToConsole(severity, ...args) {
    if (!silent && console) {
      console[severity](...args);
    }
  }
  function log(...args) {
    logToConsole('log', ...args);
  }
  function warn(...args) {
    logToConsole('warn', ...args);
  }

  let selectedBrowsers;
  if (browsers) {
    selectedBrowsers = browsersList(browsers);
  } else {
    // Will either pick up the browserslist config or use the defaults query
    selectedBrowsers = browsersList();
  }

  if (!formats) {
    formats = ['woff2'];
    if (
      _.intersection(
        browsersList('supports woff, not supports woff2'),
        selectedBrowsers
      ).length > 0
    ) {
      formats.push('woff');
    }
    if (
      _.intersection(
        browsersList('supports ttf, not supports woff'),
        selectedBrowsers
      ).length > 0
    ) {
      formats.push('truetype');
    }
  }

  let rootUrl = root && urlTools.urlOrFsPathToUrl(root, true);
  const outRoot = output && urlTools.urlOrFsPathToUrl(output, true);
  let inputUrls;
  if (inputFiles.length > 0) {
    inputUrls = inputFiles.map((urlOrFsPath) =>
      urlTools.urlOrFsPathToUrl(String(urlOrFsPath), false)
    );
    if (!rootUrl) {
      rootUrl = urlTools.findCommonUrlPrefix(inputUrls);

      if (rootUrl) {
        if (rootUrl.startsWith('file:')) {
          warn(`Guessing --root from input files: ${rootUrl}`);
        } else {
          rootUrl = urlTools.ensureTrailingSlash(rootUrl);
        }
      }
    }
  } else if (rootUrl && rootUrl.startsWith('file:')) {
    inputUrls = [`${rootUrl}**/*.html`];
    warn(`No input files specified, defaulting to ${inputUrls[0]}`);
  } else {
    throw new SyntaxError(
      "No input files and no --root specified (or it isn't file:), cannot proceed.\n"
    );
  }

  if (!inputUrls[0].startsWith('file:') && !outRoot && !dryRun) {
    throw new SyntaxError(
      '--output has to be specified when using non-file input urls'
    );
  }

  if (!inPlace && !outRoot && !dryRun) {
    throw new SyntaxError(
      'Either --output, --in-place, or --dry-run has to be specified'
    );
  }

  const assetGraphConfig = {
    root: rootUrl,
    canonicalRoot,
  };

  if (!rootUrl.startsWith('file:')) {
    assetGraphConfig.canonicalRoot = rootUrl.replace(/\/?$/, '/'); // Ensure trailing slash
  }

  // Subfont only needs to follow CSS-related relations during populate.
  // Using an allowlist instead of a blocklist avoids loading JavaScript,
  // images, and other assets that subfont never uses, significantly
  // reducing populate time for sites with many pages.
  const cssRelatedTypes = [
    'HtmlStyle',
    'SvgStyle',
    'CssImport',
    'HtmlConditionalComment',
    'HtmlNoscript',
  ];

  let followRelationsQuery;
  if (recursive) {
    followRelationsQuery = {
      $or: [
        {
          type: { $in: cssRelatedTypes },
        },
        {
          type: { $in: [...cssRelatedTypes, 'HtmlAnchor', 'SvgAnchor'] },
          crossorigin: false,
        },
      ],
    };
  } else {
    followRelationsQuery = {
      type: { $in: cssRelatedTypes },
    };
  }
  const assetGraph = new AssetGraph(assetGraphConfig);

  if (silent) {
    // Avoid failing on assetGraph.warn
    assetGraph.on('warn', () => {});
  } else {
    await assetGraph.logEvents({ console });
  }

  let phaseStart = Date.now();
  await assetGraph.loadAssets(inputUrls);
  log(`[subfont timing] loadAssets: ${Date.now() - phaseStart}ms`);

  phaseStart = Date.now();
  await assetGraph.populate({
    followRelations: followRelationsQuery,
  });
  log(`[subfont timing] populate (initial): ${Date.now() - phaseStart}ms`);

  const entrypointAssets = assetGraph.findAssets({ isInitial: true });
  const redirectOrigins = new Set();
  for (const relation of assetGraph
    .findRelations({ type: 'HttpRedirect' })
    .sort((a, b) => a.id - b.id)) {
    if (relation.from.isInitial) {
      assetGraph.info(
        new Error(`${relation.from.url} redirected to ${relation.to.url}`)
      );
      relation.to.isInitial = true;
      relation.from.isInitial = false;

      redirectOrigins.add(relation.to.origin);
    }
  }
  if (
    entrypointAssets.length === redirectOrigins.size &&
    redirectOrigins.size === 1
  ) {
    const newRoot = `${[...redirectOrigins][0]}/`;
    if (newRoot !== assetGraph.root) {
      assetGraph.info(
        new Error(
          `All entrypoints redirected, changing root from ${assetGraph.root} to ${newRoot}`
        )
      );
      assetGraph.root = newRoot;
    }
  }

  let sumSizesBefore = 0;
  for (const asset of assetGraph.findAssets({
    isInline: false,
    isLoaded: true,
    type: {
      $in: ['Html', 'Svg', 'Css', 'JavaScript'],
    },
  })) {
    sumSizesBefore += asset.rawSrc.length;
  }

  phaseStart = Date.now();
  const { fontInfo } = await subsetFonts(assetGraph, {
    inlineCss,
    fontDisplay,
    formats,
    omitFallbacks: !fallbacks,
    hrefType: relativeUrls ? 'relative' : 'rootRelative',
    text,
    dynamic,
    instance,
    console,
    skipSourceMapProcessing,
  });

  log(`[subfont timing] subsetFonts total: ${Date.now() - phaseStart}ms`);

  phaseStart = Date.now();
  let sumSizesAfter = 0;
  for (const asset of assetGraph.findAssets({
    isInline: false,
    isLoaded: true,
    type: {
      $in: ['Html', 'Svg', 'Css', 'JavaScript'],
    },
  })) {
    sumSizesAfter += asset.rawSrc.length;
  }

  // Omit function calls:
  for (const relation of assetGraph.findRelations({
    type: 'JavaScriptStaticUrl',
    to: { isLoaded: true },
  })) {
    relation.omitFunctionCall();
  }

  for (const asset of assetGraph.findAssets({
    isDirty: true,
    isInline: false,
    isLoaded: true,
    type: 'Css',
  })) {
    if (!asset.url.startsWith(assetGraph.root)) {
      assetGraph.info(
        new Error(`Pulling down modified stylesheet ${asset.url}`)
      );
      asset.url = `${assetGraph.root}subfont/${
        asset.baseName || 'index'
      }-${asset.md5Hex.slice(0, 10)}${
        asset.extension || asset.defaultExtension
      }`;
    }
  }

  if (!rootUrl.startsWith('file:')) {
    // Root-relative relations:

    for (const relation of assetGraph.findRelations()) {
      if (
        relation.hrefType === 'protocolRelative' ||
        relation.hrefType === 'absolute'
      ) {
        relation.hrefType = 'rootRelative';
      }
    }

    await assetGraph.moveAssets(
      {
        type: 'Html',
        isLoaded: true,
        isInline: false,
        fileName: { $or: ['', undefined] },
      },
      (asset, assetGraph) =>
        `${asset.url.replace(/\/?$/, '/')}index${asset.defaultExtension}`
    );
  }

  log(`[subfont timing] post-subsetFonts processing: ${Date.now() - phaseStart}ms`);

  phaseStart = Date.now();
  if (!dryRun) {
    await assetGraph.writeAssetsToDisc(
      {
        isLoaded: true,
        isRedirect: { $ne: true },
        url: (url) => url.startsWith(assetGraph.root),
      },
      outRoot,
      assetGraph.root
    );
  }

  log(`[subfont timing] writeAssetsToDisc: ${Date.now() - phaseStart}ms`);

  phaseStart = Date.now();
  if (debug) {
    log(util.inspect(fontInfo, false, 99));
  }

  let totalSavings = sumSizesBefore - sumSizesAfter;
  for (const { assetFileName, fontUsages } of fontInfo) {
    let sumSmallestSubsetSize = 0;
    let sumSmallestOriginalSize = 0;
    let maxUsedCodePoints = 0;
    let maxOriginalCodePoints = 0;
    for (const fontUsage of fontUsages) {
      sumSmallestSubsetSize += fontUsage.smallestSubsetSize || 0;
      sumSmallestOriginalSize += fontUsage.smallestOriginalSize;
      maxUsedCodePoints = Math.max(
        fontUsage.codepoints.used.length,
        maxUsedCodePoints
      );
      maxOriginalCodePoints = Math.max(
        fontUsage.codepoints.original.length,
        maxOriginalCodePoints
      );
    }
    const fontUsagesByFontFamily = _.groupBy(
      fontUsages,
      (fontUsage) => fontUsage.props['font-family']
    );
    const numFonts = Object.keys(fontUsagesByFontFamily).length;
    log(
      `${assetFileName}: ${numFonts} font${numFonts === 1 ? '' : 's'} (${
        fontUsages.length
      } variant${fontUsages.length === 1 ? '' : 's'}) in use, ${prettyBytes(
        sumSmallestOriginalSize
      )} total. Created subsets: ${prettyBytes(sumSmallestSubsetSize)} total`
    );
    for (const fontFamily of Object.keys(fontUsagesByFontFamily).sort()) {
      log(`  ${fontFamily}:`);
      for (const fontUsage of fontUsagesByFontFamily[fontFamily]) {
        const variantShortName = `${fontUsage.props['font-weight']}${
          fontUsage.props['font-style'] === 'italic' ? 'i' : ' '
        }`;
        let status = `    ${variantShortName}: ${String(
          fontUsage.codepoints.used.length
        ).padStart(String(maxUsedCodePoints).length)}/${String(
          fontUsage.codepoints.original.length
        ).padStart(String(maxOriginalCodePoints).length)} codepoints used`;
        if (
          fontUsage.codepoints.page.length !== fontUsage.codepoints.used.length
        ) {
          status += ` (${fontUsage.codepoints.page.length} on this page)`;
        }
        if (
          fontUsage.smallestOriginalSize !== undefined &&
          fontUsage.smallestSubsetSize !== undefined
        ) {
          if (fontUsage.fullyInstanced) {
            status += ', fully instanced';
          } else if (fontUsage.numAxesReduced > 0 || fontUsage.numAxesPinned) {
            const instancingInfos = [];
            if (fontUsage.numAxesPinned > 0) {
              instancingInfos.push(
                `${fontUsage.numAxesPinned} ${
                  fontUsage.numAxesPinned === 1 ? 'axis' : 'axes'
                } pinned`
              );
            }
            if (fontUsage.numAxesReduced) {
              instancingInfos.push(
                `${fontUsage.numAxesReduced}${
                  fontUsage.numAxesPinned > 0
                    ? ''
                    : fontUsage.numAxesReduced === 1
                    ? ' axis'
                    : ' axes'
                } reduced`
              );
            }

            status += `, partially instanced (${instancingInfos.join(', ')})`;
          }
          status += `, ${prettyBytes(fontUsage.smallestOriginalSize)} (${
            fontUsage.smallestOriginalFormat
          }) => ${prettyBytes(fontUsage.smallestSubsetSize)} (${
            fontUsage.smallestSubsetFormat
          })`;
          totalSavings +=
            fontUsage.smallestOriginalSize - fontUsage.smallestSubsetSize;
        } else {
          status += ', no subset font created';
        }
        log(status);
      }
    }
  }
  log(
    `HTML/SVG/JS/CSS size increase: ${prettyBytes(
      sumSizesAfter - sumSizesBefore
    )}`
  );
  log(`Total savings: ${prettyBytes(totalSavings)}`);
  log(`[subfont timing] output reporting: ${Date.now() - phaseStart}ms`);

  if (!dryRun) {
    log('Output written to', outRoot || assetGraph.root);
  }
  return assetGraph;
};
