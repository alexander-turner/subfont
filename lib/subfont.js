const fs = require('fs');
const pathModule = require('path');
const AssetGraph = require('assetgraph');
const prettyBytes = require('pretty-bytes');
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
    inPlace = false,
    inputFiles = [],
    recursive = false,
    relativeUrls = false,
    dynamic = false,
    fallbacks = true,
    text,
    sourceMaps = false,
    concurrency,
    chromeFlags = [],
    cache = false,
  },
  console
) {
  const formats = ['woff2'];

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

  let rootUrl = root && urlTools.urlOrFsPathToUrl(root, true);
  // Validate --root path exists early to give a clear error message
  if (root && rootUrl && rootUrl.startsWith('file:')) {
    const rootPath = urlTools.fileUrlToFsPath(rootUrl);
    if (!fs.existsSync(rootPath)) {
      throw new SyntaxError(`The --root path does not exist: ${rootPath}`);
    }
  }
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
  const cssRelatedTypes = [
    'HtmlStyle',
    'SvgStyle',
    'CssImport',
    'CssFontFaceSrc',
    'HttpRedirect',
    'HtmlMetaRefresh',
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

  function isExtensionlessEnoent(err) {
    return (
      err &&
      err.code === 'ENOENT' &&
      typeof err.path === 'string' &&
      !/\.[^/]+$/.test(err.path)
    );
  }

  if (silent) {
    assetGraph.on('warn', () => {});
  } else {
    const origEmit = assetGraph.emit;
    assetGraph.emit = function (event, err, ...rest) {
      if (event === 'warn' && isExtensionlessEnoent(err)) {
        return false;
      }
      return origEmit.call(this, event, err, ...rest);
    };
    await assetGraph.logEvents({ console });
  }

  const outerTimings = {};

  let phaseStart = Date.now();
  await assetGraph.loadAssets(inputUrls);
  outerTimings.loadAssets = Date.now() - phaseStart;
  if (debug) log(`[subfont timing] loadAssets: ${outerTimings.loadAssets}ms`);

  phaseStart = Date.now();
  await assetGraph.populate({
    followRelations: followRelationsQuery,
  });
  outerTimings['populate (initial)'] = Date.now() - phaseStart;
  if (debug)
    log(
      `[subfont timing] populate (initial): ${outerTimings['populate (initial)']}ms`
    );

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

  if (!sourceMaps) {
    log(
      'Skipping CSS source map processing for faster execution. Use --source-maps to preserve them.'
    );
  }

  phaseStart = Date.now();
  const { fontInfo, timings: subsetTimings } = await subsetFonts(assetGraph, {
    inlineCss,
    fontDisplay,
    formats,
    omitFallbacks: !fallbacks,
    hrefType: relativeUrls ? 'relative' : 'rootRelative',
    text,
    dynamic,
    console,
    sourceMaps,
    debug,
    concurrency,
    chromeArgs: chromeFlags,
    cacheDir: (() => {
      if (cache && typeof cache === 'string' && cache.length > 0) return cache;
      if (cache && rootUrl && rootUrl.startsWith('file:'))
        return pathModule.join(
          urlTools.fileUrlToFsPath(rootUrl),
          '.subfont-cache'
        );
      if (cache)
        warn(
          '--cache ignored: caching requires a local --root or an explicit cache path'
        );
      return null;
    })(),
  });

  const subsetFontsTotal = Date.now() - phaseStart;
  if (debug) log(`[subfont timing] subsetFonts total: ${subsetFontsTotal}ms`);

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

  outerTimings['post-subsetFonts processing'] = Date.now() - phaseStart;
  if (debug)
    log(
      `[subfont timing] post-subsetFonts processing: ${outerTimings['post-subsetFonts processing']}ms`
    );

  phaseStart = Date.now();
  if (!dryRun) {
    await assetGraph.writeAssetsToDisc(
      {
        isLoaded: true,
        isRedirect: { $ne: true },
        url: (url) => url && url.startsWith(assetGraph.root),
      },
      outRoot,
      assetGraph.root
    );
  }

  outerTimings.writeAssetsToDisc = Date.now() - phaseStart;
  if (debug)
    log(
      `[subfont timing] writeAssetsToDisc: ${outerTimings.writeAssetsToDisc}ms`
    );

  phaseStart = Date.now();
  if (debug) {
    const compactFontInfo = fontInfo.map(({ fontUsages, ...rest }) => ({
      ...rest,
      fontUsages: fontUsages.map(({ codepoints, texts, ...fu }) => ({
        ...fu,
        codepoints: codepoints
          ? {
              original: `[${codepoints.original.length} codepoints]`,
              used: `[${codepoints.used.length} codepoints]`,
              unused: `[${codepoints.unused.length} codepoints]`,
              page: `[${codepoints.page.length} codepoints]`,
            }
          : undefined,
        texts: texts ? `[${texts.length} entries]` : undefined,
      })),
    }));
    log(util.inspect(compactFontInfo, false, 99));
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
    const fontUsagesByFontFamily = {};
    for (const fontUsage of fontUsages) {
      const key = fontUsage.props['font-family'];
      if (!fontUsagesByFontFamily[key]) fontUsagesByFontFamily[key] = [];
      fontUsagesByFontFamily[key].push(fontUsage);
    }
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
  outerTimings['output reporting'] = Date.now() - phaseStart;
  if (debug)
    log(
      `[subfont timing] output reporting: ${outerTimings['output reporting']}ms`
    );

  const st = subsetTimings || {};
  const details = st.collectTextsByPageDetails || {};
  const totalElapsed =
    (outerTimings.loadAssets || 0) +
    (outerTimings['populate (initial)'] || 0) +
    subsetFontsTotal +
    (outerTimings['post-subsetFonts processing'] || 0) +
    (outerTimings.writeAssetsToDisc || 0) +
    (outerTimings['output reporting'] || 0);

  const rows = [
    ['loadAssets', outerTimings.loadAssets, 0],
    ['populate (initial)', outerTimings['populate (initial)'], 0],
    ['subsetFonts total', subsetFontsTotal, 0],
    ['collectTextsByPage', st.collectTextsByPage, 1],
    ['Stylesheet precompute', details['Stylesheet precompute'], 2],
    ['Full tracing', details['Full tracing'], 2],
    ['Fast-path extraction', details['Fast-path extraction'], 2],
    ['Per-page loop', details['Per-page loop'], 2],
    ['Post-processing', details['Post-processing total'], 2],
    ['codepoint generation', st['codepoint generation'], 1],
    ['getSubsetsForFontUsage', st.getSubsetsForFontUsage, 1],
    ['insert subsets loop', st['insert subsets loop'], 1],
    ['inject font-family', st['inject subset font-family'], 1],
    ['post-subsetFonts', outerTimings['post-subsetFonts processing'], 0],
    ['writeAssetsToDisc', outerTimings.writeAssetsToDisc, 0],
    ['output reporting', outerTimings['output reporting'], 0],
  ];

  log('\n═══ Subfont Timing Summary ═══');
  for (const [label, ms, indent] of rows) {
    if (ms === undefined) continue;
    const prefix = '  '.repeat(indent + 1);
    const padded = (ms || 0).toLocaleString().padStart(8);
    log(`${prefix}${label}: ${padded}ms`);
  }
  log('  ─────────────────────────────────');
  log(`  Total: ${totalElapsed.toLocaleString().padStart(8)}ms`);
  log('═══════════════════════════════\n');

  if (dryRun) {
    log('\n═══ Dry Run Preview ═══');
    const assetsToWrite = assetGraph.findAssets({
      isLoaded: true,
      isRedirect: { $ne: true },
      url: (url) => url && url.startsWith(assetGraph.root),
    });
    const byType = {};
    let totalOutputSize = 0;
    for (const asset of assetsToWrite) {
      const type = asset.type || 'Other';
      if (!byType[type]) byType[type] = { count: 0, size: 0, files: [] };
      const size = asset.rawSrc ? asset.rawSrc.length : 0;
      byType[type].count += 1;
      byType[type].size += size;
      totalOutputSize += size;

      if (asset.url && asset.url.includes('/subfont/')) {
        byType[type].files.push(
          `    ${asset.url.replace(assetGraph.root, '/')} (${prettyBytes(size)})`
        );
      }
    }
    for (const [type, info] of Object.entries(byType).sort(
      ([, a], [, b]) => b.size - a.size
    )) {
      log(
        `  ${type}: ${info.count} file${info.count === 1 ? '' : 's'}, ${prettyBytes(info.size)}`
      );
      for (const file of info.files) {
        log(file);
      }
    }
    log(`  ─────────────────────────────────`);
    log(`  Total output: ${prettyBytes(totalOutputSize)}`);

    const dirtyHtmlAssets = assetGraph.findAssets({
      isDirty: true,
      isLoaded: true,
      type: { $in: ['Html', 'Svg'] },
    });
    if (dirtyHtmlAssets.length > 0) {
      log(`\n  Modified HTML/SVG files (${dirtyHtmlAssets.length}):`);
      for (const asset of dirtyHtmlAssets) {
        log(`    ${asset.urlOrDescription}`);
      }
    }

    const subsetCssAssets = assetGraph.findAssets({
      type: 'Css',
      isLoaded: true,
      url: (url) => url && url.includes('/subfont/'),
    });
    if (subsetCssAssets.length > 0) {
      log(
        `\n  Subset CSS files that would be created (${subsetCssAssets.length}):`
      );
      for (const css of subsetCssAssets) {
        const fontFaceCount = (css.text.match(/@font-face/g) || []).length;
        log(
          `    ${css.url.replace(assetGraph.root, '/')} (${prettyBytes(css.rawSrc.length)}, ${fontFaceCount} @font-face rule${fontFaceCount === 1 ? '' : 's'})`
        );
      }
    }

    log('═══════════════════════════════\n');
    log('Dry run complete — no files were written.');
  } else {
    log('Output written to', outRoot || assetGraph.root);
  }
  return assetGraph;
};
