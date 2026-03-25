const expect = require('unexpected').clone().use(require('unexpected-sinon'));

const AssetGraph = require('assetgraph');
const pathModule = require('path');
const sinon = require('sinon');
const subsetFonts = require('../lib/subsetFonts');

describe('debug timing output', function () {
  this.timeout(60000);

  it('should emit timing logs when debug is true', async function () {
    const assetGraph = new AssetGraph({
      root: pathModule.resolve(
        __dirname,
        '../testdata/subsetFonts/inline-subsets/'
      ),
    });
    assetGraph.on('warn', () => {});
    await assetGraph.loadAssets('index.html');
    await assetGraph.populate();

    const mockConsole = { log: sinon.spy(), warn: sinon.spy() };
    await subsetFonts(assetGraph, {
      console: mockConsole,
      debug: true,
    });

    const timingCalls = mockConsole.log.args.filter(
      (args) =>
        typeof args[0] === 'string' && args[0].includes('[subfont timing]')
    );
    expect(timingCalls.length, 'to be greater than', 0);
  });

  it('should not emit timing logs when debug is false', async function () {
    const assetGraph = new AssetGraph({
      root: pathModule.resolve(
        __dirname,
        '../testdata/subsetFonts/inline-subsets/'
      ),
    });
    assetGraph.on('warn', () => {});
    await assetGraph.loadAssets('index.html');
    await assetGraph.populate();

    const mockConsole = { log: sinon.spy(), warn: sinon.spy() };
    await subsetFonts(assetGraph, {
      console: mockConsole,
      debug: false,
    });

    const timingCalls = mockConsole.log.args.filter(
      (args) =>
        typeof args[0] === 'string' && args[0].includes('[subfont timing]')
    );
    expect(timingCalls.length, 'to be', 0);
  });
});

describe('sourceMaps option', function () {
  this.timeout(60000);

  it('should skip source map processing when sourceMaps is false (default)', async function () {
    const assetGraph = new AssetGraph({
      root: pathModule.resolve(
        __dirname,
        '../testdata/subsetFonts/inline-subsets/'
      ),
    });
    assetGraph.on('warn', () => {});
    await assetGraph.loadAssets('index.html');
    await assetGraph.populate();

    // Spy on applySourceMaps
    const applySourceMapsSpy = sinon.spy(assetGraph, 'applySourceMaps');

    const mockConsole = { log: sinon.spy(), warn: sinon.spy() };
    await subsetFonts(assetGraph, {
      console: mockConsole,
      sourceMaps: false,
    });

    expect(applySourceMapsSpy, 'was not called');
    applySourceMapsSpy.restore();
  });
});
