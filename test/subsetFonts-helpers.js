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

module.exports = {
  expect,
  AssetGraph,
  pathModule,
  LinesAndColumns,
  httpception,
  sinon,
  fs,
  subsetFonts,
  getFontInfo,
  defaultLocalSubsetMock,
  setupCleanup,
};
