const expect = require('unexpected')
  .clone()
  .use(require('unexpected-sinon'))
  .use(require('unexpected-set'))
  .use(require('assetgraph/test/unexpectedAssetGraph'));

const AssetGraph = require('assetgraph');
const pathModule = require('path');
const LinesAndColumns = require('lines-and-columns').default;

const httpception = require('httpception');
const sinon = require('sinon');
const fs = require('fs');
const subsetFonts = require('../lib/subsetFonts');
const getFontInfo = require('../lib/getFontInfo');

const defaultLocalSubsetMock = [
  {
    request: {
      url: 'GET https://fonts.googleapis.com/css?family=Open+Sans',
      headers: {
        'User-Agent': expect.it('to begin with', 'AssetGraph v'),
      },
    },
    response: {
      headers: {
        'Content-Type': 'text/css',
      },
      body: [
        '@font-face {',
        "  font-family: 'Open Sans';",
        '  font-style: normal;',
        '  font-weight: 400;',
        "  src: local('Open Sans Regular'), local('OpenSans-Regular'), url(https://fonts.gstatic.com/s/opensans/v15/cJZKeOuBrn4kERxqtaUH3aCWcynf_cDxXwCLxiixG1c.ttf) format('truetype');",
        '}',
      ].join('\n'),
    },
  },
  {
    request:
      'GET https://fonts.gstatic.com/s/opensans/v15/cJZKeOuBrn4kERxqtaUH3aCWcynf_cDxXwCLxiixG1c.ttf',
    response: {
      headers: {
        'Content-Type': 'font/ttf',
      },
      body: fs.readFileSync(
        pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/OpenSans-400.ttf'
        )
      ),
    },
  },
];

/**
 * Build httpception mocks for a Google Fonts CSS request.
 *
 * @param {string} cssUrl  The full Google Fonts CSS URL
 *     (e.g. 'https://fonts.googleapis.com/css?family=Roboto:400,700')
 * @param {Array<{family: string, weight?: string|number, style?: string,
 *                fontFile: string}>} variants
 *     Each entry describes one @font-face block. `fontFile` is a path
 *     relative to testdata/subsetFonts/.  The same font file may be reused
 *     across variants when the test doesn't depend on glyph content.
 * @returns {Array} An array of httpception mock entries (CSS response +
 *     one font-file response per unique fontFile).
 */
function createGoogleFontMock(cssUrl, variants) {
  const fontFileBaseUrl = 'https://fonts.gstatic.com/s/mock/v1';
  const seenFiles = new Map(); // fontFile → mock URL

  const fontFaceBlocks = variants.map((v) => {
    const weight = v.weight || 400;
    const style = v.style || 'normal';
    const fileName = pathModule.basename(v.fontFile);
    const mockUrl = `${fontFileBaseUrl}/${fileName}`;
    seenFiles.set(v.fontFile, mockUrl);
    return [
      '@font-face {',
      `  font-family: '${v.family}';`,
      `  font-style: ${style};`,
      `  font-weight: ${weight};`,
      `  src: url(${mockUrl}) format('truetype');`,
      '}',
    ].join('\n');
  });

  const mocks = [
    {
      request: {
        url: `GET ${cssUrl}`,
        headers: {
          'User-Agent': expect.it('to begin with', 'AssetGraph v'),
        },
      },
      response: {
        headers: { 'Content-Type': 'text/css' },
        body: fontFaceBlocks.join('\n'),
      },
    },
  ];

  for (const [fontFile, mockUrl] of seenFiles) {
    mocks.push({
      request: `GET ${mockUrl}`,
      response: {
        headers: { 'Content-Type': 'font/ttf' },
        body: fs.readFileSync(
          pathModule.resolve(__dirname, `../testdata/subsetFonts/${fontFile}`)
        ),
      },
    });
  }

  return mocks;
}

function setupCleanup() {
  const https = require('https');

  afterEach(function () {
    // Destroy keep-alive connections pooled by the global HTTPS agent.
    if (https.globalAgent && https.globalAgent.freeSockets) {
      for (const key of Object.keys(https.globalAgent.freeSockets)) {
        for (const socket of https.globalAgent.freeSockets[key]) {
          socket.destroy();
        }
        https.globalAgent.freeSockets[key] = [];
      }
    }
  });
}

function createGraph(testDir) {
  return new AssetGraph({
    root: pathModule.resolve(__dirname, `../testdata/subsetFonts/${testDir}/`),
  });
}

async function loadAndPopulate(assetGraph, assets = 'index.html', opts = {}) {
  const loaded = await assetGraph.loadAssets(assets);
  const populateOpts =
    opts.crossorigin !== undefined
      ? { followRelations: { crossorigin: opts.crossorigin } }
      : undefined;
  await assetGraph.populate(populateOpts);
  return loaded;
}

// Test-friendly wrapper: uses dual-format + fallbacks to match existing
// test assertions. Tests that specifically test the new defaults should
// call subsetFonts directly.
function subsetFontsWithTestDefaults(assetGraph, options = {}) {
  return subsetFonts(assetGraph, {
    formats: ['woff2', 'woff'],
    omitFallbacks: false,
    ...options,
  });
}

module.exports = {
  expect,
  AssetGraph,
  pathModule,
  LinesAndColumns,
  httpception,
  sinon,
  fs,
  subsetFonts,
  subsetFontsWithTestDefaults,
  getFontInfo,
  defaultLocalSubsetMock,
  createGoogleFontMock,
  setupCleanup,
  createGraph,
  loadAndPopulate,
};
