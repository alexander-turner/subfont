const fsPromises = require('fs/promises');
const os = require('os');
const pathModule = require('path');
const sanitizeFilename = require('sanitize-filename');
const { getMaxConcurrency } = require('./concurrencyLimit');
const AssetGraph = require('assetgraph');
const prettyBytes = require('pretty-bytes');
const urlTools = require('urltools');
const util = require('util');
const subsetFonts = require('./subsetFonts');
const { makePhaseTracker } = require('./progress');

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

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
    strict = false,
  },
  console
) {
  if (
    concurrency !== undefined &&
    (!Number.isInteger(concurrency) || concurrency < 1)
  ) {
    throw new UsageError('--concurrency must be a positive integer');
  }
  const maxConcurrency = getMaxConcurrency();
  if (concurrency !== undefined && concurrency > maxConcurrency) {
    throw new UsageError(
      `--concurrency must not exceed ${maxConcurrency} (each worker uses ~50 MB; ${Math.round(os.freemem() / (1024 * 1024 * 1024))} GB free, ${os.cpus().length} CPUs)`
    );
  }

  // Prevent postcss plugins (colormin, convert-values, etc.) invoked by
  // cssnano from walking the filesystem for a "browserslist" config.
  // Under pnpm, `node_modules/.bin/browserslist` is a shell shim that
  // browserslist mis-parses as browser queries, throwing
  // BrowserslistError and silently aborting CSS minification.
  // Setting BROWSERSLIST short-circuits the walk entirely.
  if (!process.env.BROWSERSLIST && !process.env.BROWSERSLIST_CONFIG) {
    process.env.BROWSERSLIST = 'defaults';
  }

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
    try {
      await fsPromises.access(rootPath);
    } catch {
      throw new UsageError(`The --root path does not exist: ${rootPath}`);
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
    throw new UsageError(
      "No input files and no --root specified (or it isn't file:), cannot proceed.\n"
    );
  }

  if (!inputUrls[0].startsWith('file:') && !outRoot && !dryRun) {
    throw new UsageError(
      '--output has to be specified when using non-file input urls'
    );
  }

  if (!inPlace && !outRoot && !dryRun) {
    throw new UsageError(
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

  let sawWarning = false;
  const origEmit = assetGraph.emit;
  assetGraph.emit = function (event, err, ...rest) {
    if (event === 'warn') {
      if (isExtensionlessEnoent(err)) return false;
      sawWarning = true;
    }
    return origEmit.call(this, event, err, ...rest);
  };
  if (silent) {
    assetGraph.on('warn', () => {});
  } else {
    await assetGraph.logEvents({ console, stopOnWarning: strict });
  }

  const outerTimings = {};
  // The tracker writes with console.log (duck-typed). Route it through
  // the silent-aware log wrapper so --silent suppresses phase markers
  // the same way it suppresses other subfont output.
  const trackPhase = makePhaseTracker({ log }, debug);

  const loadAssetsPhase = trackPhase('loadAssets');
  await assetGraph.loadAssets(inputUrls);
  outerTimings.loadAssets = loadAssetsPhase.end();

  const populatePhase = trackPhase('populate (initial)');
  await assetGraph.populate({
    followRelations: followRelationsQuery,
  });
  outerTimings['populate (initial)'] = populatePhase.end();

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

  const sizeableAssetQuery = {
    isInline: false,
    isLoaded: true,
    type: {
      $in: ['Html', 'Svg', 'Css', 'JavaScript'],
    },
  };
  let sumSizesBefore = 0;
  for (const asset of assetGraph.findAssets(sizeableAssetQuery)) {
    sumSizesBefore += asset.rawSrc.length;
  }

  if (!sourceMaps) {
    log(
      'Skipping CSS source map processing for faster execution. Use --source-maps to preserve them.'
    );
  }

  let cacheDir = null;
  if (cache && typeof cache === 'string' && cache.length > 0) {
    cacheDir = cache;
  } else if (cache && rootUrl && rootUrl.startsWith('file:')) {
    cacheDir = pathModule.join(
      urlTools.fileUrlToFsPath(rootUrl),
      '.subfont-cache'
    );
  } else if (cache) {
    warn(
      '--cache ignored: caching requires a local --root or an explicit cache path'
    );
  }

  const subsetPhase = trackPhase('subsetFonts total');
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
    cacheDir,
  });
  const subsetFontsTotal = subsetPhase.end();

  const postProcessingPhase = trackPhase('post-subsetFonts processing');
  let sumSizesAfter = 0;
  for (const asset of assetGraph.findAssets(sizeableAssetQuery)) {
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
      const safeName =
        sanitizeFilename(asset.baseName || '', { replacement: '_' }) || 'index';
      asset.url = `${assetGraph.root}subfont/${safeName}-${asset.md5Hex.slice(
        0,
        10
      )}${asset.extension || asset.defaultExtension}`;
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

  outerTimings['post-subsetFonts processing'] = postProcessingPhase.end();

  if (strict && sawWarning) {
    // In non-silent mode, assetgraph's logEvents normally exits earlier via
    // stopOnWarning. This guard covers silent mode and warnings that slipped
    // past a transform boundary.
    throw new Error(
      'subfont: --strict was set and one or more warnings were emitted; refusing to write output.'
    );
  }

  const writePhase = trackPhase('writeAssetsToDisc');
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
  outerTimings.writeAssetsToDisc = writePhase.end();

  const reportingPhase = trackPhase('output reporting');
  if (debug) {
    // One entry per unique (fontUrl, props) variant. A variable-font URL can
    // back multiple variants, so fontUrl alone is too coarse. Codepoint unions
    // and subset sizes are per-font, so the remaining per-page variation
    // worth surfacing is just which pages reference the variant.
    const SAMPLE_PAGES = 5;
    const byVariant = new Map();
    for (const { assetFileName, fontUsages } of fontInfo) {
      for (const fu of fontUsages) {
        const p = fu.props || {};
        const key = [
          fu.fontUrl || '[inline]',
          p['font-family'],
          p['font-weight'],
          p['font-style'],
          p['font-stretch'],
        ].join('\0');
        let entry = byVariant.get(key);
        if (!entry) {
          entry = {
            fontUrl: fu.fontUrl,
            props: fu.props,
            preload: fu.preload,
            fullyInstanced: fu.fullyInstanced,
            numAxesPinned: fu.numAxesPinned,
            numAxesReduced: fu.numAxesReduced,
            smallestOriginalFormat: fu.smallestOriginalFormat,
            smallestSubsetFormat: fu.smallestSubsetFormat,
            smallestOriginalSize: fu.smallestOriginalSize,
            smallestSubsetSize: fu.smallestSubsetSize,
            codepoints: fu.codepoints
              ? {
                  original: fu.codepoints.original.length,
                  used: fu.codepoints.used.length,
                  unused: fu.codepoints.unused.length,
                }
              : undefined,
            pageCount: 0,
            samplePages: [],
          };
          byVariant.set(key, entry);
        }
        entry.pageCount += 1;
        if (entry.samplePages.length < SAMPLE_PAGES) {
          entry.samplePages.push(assetFileName);
        }
      }
    }
    for (const entry of byVariant.values()) {
      const remaining = entry.pageCount - entry.samplePages.length;
      if (remaining > 0) {
        entry.samplePages.push(`...and ${remaining} more`);
      }
    }
    log(
      `Font variants (aggregated across ${fontInfo.length} page${fontInfo.length === 1 ? '' : 's'}):`
    );
    log(util.inspect([...byVariant.values()], false, 99));
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
  outerTimings['output reporting'] = reportingPhase.end();

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

  if (debug) {
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
  }

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

module.exports.UsageError = UsageError;
