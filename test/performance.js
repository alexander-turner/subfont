// Regression guard for the OOM / 1h+ runtime blowup on large sites (the
// TurnTrout.com run: 33 min baseline → 46+ min / OOM on master).  Root cause
// was font-size leaking into font-tracer `propsToReturn`, which buckets every
// text chunk by distinct font-size.  On a page with 30 sizes the per-page
// textByProps count goes from ~1 to ~30+, and downstream `globalTextByProps`
// and `allTexts` scale accordingly.
//
// Strategy: build a synthetic fixture with many distinct font-sizes per page,
// run collectTextsByPage, then assert on (a) textByProps entry count — a
// deterministic proxy for the explosion — and (b) wall-clock time vs a
// snapshot stored in test/perf-snapshot.json.  The snapshot is refreshed with
// `UPDATE_SNAPSHOT=1 pnpm test`.  The timing slack is generous (5× baseline
// with a 500 ms floor) to absorb CI noise while still catching the ≥10×
// runtime growth a real regression would produce.

const fs = require('fs');
const pathModule = require('path');
const expect = require('unexpected');
const AssetGraph = require('assetgraph');

const collectTextsByPage = require('../lib/collectTextsByPage');

const FIXTURE_ROOT = pathModule.resolve(
  __dirname,
  '../testdata/subsetFonts/local-single/'
);
const SNAPSHOT_PATH = pathModule.join(__dirname, 'perf-snapshot.json');

const NUM_PAGES = 20;
const FONT_SIZES_PER_PAGE = 30;

function makePageHtml(pageId, fontSizes) {
  // Shared text across every size: font-tracer's dedup key is
  // (text, ...propsToReturn).  Identical text + different font-size
  // collapses to one entry without font-size in propsToReturn, and
  // explodes to one-entry-per-size when font-size is included.
  const spans = fontSizes
    .map((size) => `<span style="font-size:${size}">shared text</span>`)
    .join(' ');
  // Unique CSS comment per page so each page gets its own stylesheet-cache
  // group and goes through full tracing — otherwise the fast-path (which
  // regroups entries by propsKey excluding font-size) hides the regression.
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Performance fixture</title>
    <style>
      /* page ${pageId} */
      @font-face {
        font-family: 'Open Sans';
        font-style: normal;
        font-weight: 400;
        src: local('Open Sans Regular'), local('OpenSans-Regular'), url(OpenSans.ttf) format('truetype');
      }
      body { font-family: 'Open Sans'; }
    </style>
  </head>
  <body>${spans}</body>
</html>`;
}

async function buildSyntheticGraph() {
  const assetGraph = new AssetGraph({ root: FIXTURE_ROOT });
  const fontSizes = Array.from(
    { length: FONT_SIZES_PER_PAGE },
    (_, i) => `${10 + i}px`
  );
  const htmlAssets = [];
  for (let p = 0; p < NUM_PAGES; p++) {
    const asset = assetGraph.addAsset({
      type: 'Html',
      url: `${assetGraph.root}perf-${p}.html`,
      text: makePageHtml(p, fontSizes),
    });
    htmlAssets.push(asset);
  }
  await assetGraph.populate();
  return { assetGraph, htmlAssets };
}

describe('performance regression guards', function () {
  this.timeout(60000);

  it('should not multiply textByProps entries by distinct font-sizes', async function () {
    const { assetGraph, htmlAssets } = await buildSyntheticGraph();
    const { htmlOrSvgAssetTextsWithProps } = await collectTextsByPage(
      assetGraph,
      htmlAssets
    );

    const totalEntries = htmlOrSvgAssetTextsWithProps.reduce(
      (sum, entry) => sum + entry.textByProps.length,
      0
    );

    // Pre-regression: one entry per (family, weight, style, stretch) combo per
    // page ≈ NUM_PAGES entries.  With font-size in propsToReturn, entries grow
    // to NUM_PAGES * FONT_SIZES_PER_PAGE ≈ 600.  The threshold leaves some
    // slack for font-tracer edge cases while still catching the regression.
    const upperBound = NUM_PAGES * 3;
    expect(totalEntries, 'to be less than or equal to', upperBound);
  });

  it('should finish collectTextsByPage within the snapshot slack', async function () {
    // Warm-up: first pass pays JIT/module init costs.  Measure the second run.
    await collectTextsByPage(...(await buildArgs()));
    const start = Date.now();
    await collectTextsByPage(...(await buildArgs()));
    const elapsedMs = Date.now() - start;

    const snapshot = loadSnapshot();
    if (process.env.UPDATE_SNAPSHOT === '1' || snapshot === null) {
      saveSnapshot({ collectTextsByPageMs: elapsedMs });
      // Fresh snapshot — nothing to compare against on this run.
      return;
    }

    const baseline = snapshot.collectTextsByPageMs;
    // 5× baseline with a 500 ms floor absorbs CI noise while catching the
    // ≥10× runtime explosion a real regression produces.  Matches the
    // observed 33 min → OOM/46+ min blowup on TurnTrout.com.
    const slack = Math.max(500, baseline * 5);
    expect(elapsedMs, 'to be less than or equal to', slack);
  });
});

async function buildArgs() {
  const { assetGraph, htmlAssets } = await buildSyntheticGraph();
  return [assetGraph, htmlAssets];
}

function loadSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveSnapshot(data) {
  fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(data, null, 2)}\n`);
}
