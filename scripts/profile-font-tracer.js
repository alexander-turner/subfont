#!/usr/bin/env node

/**
 * Profile fontTracer to understand where per-page time is spent.
 *
 * Usage:
 *   node scripts/profile-font-tracer.js [path-to-html-directory]
 *
 * If no directory is provided, uses the built-in multi-page test fixture.
 */

const { performance } = require('perf_hooks');
const pathModule = require('path');
const AssetGraph = require('assetgraph');
const fontTracer = require('font-tracer');
const memoizeSync = require('memoizesync');
const getCssRulesByProperty = require('../lib/getCssRulesByProperty');
const gatherStylesheetsWithPredicates = require('../lib/gatherStylesheetsWithPredicates');

async function profileFontTracer(rootDir) {
  const root = rootDir
    ? `file://${pathModule.resolve(rootDir)}/`
    : `file://${pathModule.resolve(__dirname, '../testdata/subsetFonts/multi-page/')}/`;

  console.log(`Profiling fontTracer with root: ${root}\n`);

  // Load assets similar to subfont.js lines 112-179
  const assetGraph = new AssetGraph({ root });
  assetGraph.on('warn', () => {});

  const t0 = performance.now();
  await assetGraph.loadAssets('*.html');
  const tLoad = performance.now();
  console.log(`loadAssets: ${(tLoad - t0).toFixed(1)}ms`);

  await assetGraph.populate({
    followRelations: {
      crossorigin: false,
    },
  });
  const tPopulate = performance.now();
  console.log(`populate: ${(tPopulate - tLoad).toFixed(1)}ms`);

  const htmlAssets = assetGraph.findAssets({ type: 'Html', isInline: false });
  console.log(`Found ${htmlAssets.length} HTML pages\n`);

  // Profile each page
  const memoizedGetCssRulesByProperty = memoizeSync(getCssRulesByProperty);

  const timings = {
    gatherStylesheets: [],
    getCssRules: [],
    fontTracerTotal: [],
  };

  // Wrap getCssRulesByProperty to measure time
  let cssRuleTime = 0;
  const instrumentedGetCssRulesByProperty = memoizeSync(
    function (...args) {
      const start = performance.now();
      const result = getCssRulesByProperty(...args);
      cssRuleTime += performance.now() - start;
      return result;
    }
  );

  for (const htmlAsset of htmlAssets) {
    const pageName = htmlAsset.url.replace(root, '');

    // 1. Measure gatherStylesheetsWithPredicates
    const t1 = performance.now();
    const stylesheetsWithPredicates = gatherStylesheetsWithPredicates(
      assetGraph,
      htmlAsset
    );
    const t2 = performance.now();
    timings.gatherStylesheets.push(t2 - t1);

    // 2. Measure fontTracer (includes getCssRulesByProperty internally)
    cssRuleTime = 0;
    const t3 = performance.now();
    const textByProps = fontTracer(htmlAsset.parseTree, {
      stylesheetsWithPredicates,
      getCssRulesByProperty: instrumentedGetCssRulesByProperty,
      asset: htmlAsset,
    });
    const t4 = performance.now();
    timings.fontTracerTotal.push(t4 - t3);
    timings.getCssRules.push(cssRuleTime);

    console.log(
      `${pageName}: fontTracer=${(t4 - t3).toFixed(1)}ms, ` +
      `gatherStylesheets=${(t2 - t1).toFixed(1)}ms, ` +
      `getCssRules=${cssRuleTime.toFixed(1)}ms, ` +
      `results=${textByProps.length} entries`
    );
  }

  // Summary
  console.log('\n--- Summary ---');
  for (const [name, values] of Object.entries(timings)) {
    if (values.length === 0) continue;
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const max = Math.max(...values);
    const min = Math.min(...values);
    console.log(
      `${name}: total=${(sum / 1000).toFixed(2)}s, avg=${avg.toFixed(1)}ms, ` +
      `min=${min.toFixed(1)}ms, max=${max.toFixed(1)}ms, count=${values.length}`
    );
  }

  // Compute DOM traversal time (fontTracer - getCssRules)
  const totalFontTracer = timings.fontTracerTotal.reduce((a, b) => a + b, 0);
  const totalCssRules = timings.getCssRules.reduce((a, b) => a + b, 0);
  console.log(
    `\nEstimated DOM traversal + selector matching: ${((totalFontTracer - totalCssRules) / 1000).toFixed(2)}s ` +
    `(${(((totalFontTracer - totalCssRules) / totalFontTracer) * 100).toFixed(1)}% of fontTracer)`
  );
  console.log(
    `CSS rule parsing: ${(totalCssRules / 1000).toFixed(2)}s ` +
    `(${((totalCssRules / totalFontTracer) * 100).toFixed(1)}% of fontTracer)`
  );
}

const rootDir = process.argv[2];
profileFontTracer(rootDir).catch((err) => {
  console.error(err);
  process.exit(1);
});
