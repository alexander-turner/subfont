const expect = require('unexpected').clone().use(require('unexpected-sinon'));
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('HeadlessBrowser', function () {
  let HeadlessBrowser;
  let mockBrowser;
  let mockPage;
  let puppeteerStub;
  let browsersStub;
  let fakeConsole;
  let mockAssetGraph;

  beforeEach(function () {
    fakeConsole = { log: sinon.stub(), error: sinon.stub() };

    mockPage = {
      setRequestInterception: sinon.stub().resolves(),
      on: sinon.stub(),
      close: sinon.stub().resolves(),
      setBypassCSP: sinon.stub().resolves(),
      goto: sinon.stub().resolves(),
      addScriptTag: sinon.stub().resolves(),
      evaluateHandle: sinon.stub().resolves({
        jsonValue: sinon.stub().resolves([]),
        getProperty: sinon.stub().resolves({
          getProperty: sinon.stub().resolves(null),
        }),
      }),
    };

    mockBrowser = {
      newPage: sinon.stub().resolves(mockPage),
      close: sinon.stub().resolves(),
    };

    puppeteerStub = {
      launch: sinon.stub().resolves(mockBrowser),
    };

    browsersStub = {
      install: sinon.stub().resolves({ executablePath: '/fake/chrome' }),
      Browser: { CHROME: 'chrome' },
      detectBrowserPlatform: sinon.stub().returns('linux'),
      Cache: sinon.stub().returns({
        getInstalledBrowsers: sinon
          .stub()
          .returns([{ browser: 'chrome', executablePath: '/fake/chrome' }]),
      }),
    };

    mockAssetGraph = {
      canonicalRoot: 'https://example.com/',
      root: 'file:///test/',
      findAssets: sinon.stub().returns([]),
    };

    HeadlessBrowser = proxyquire('../lib/HeadlessBrowser', {
      'puppeteer-core': puppeteerStub,
      '@puppeteer/browsers': browsersStub,
    });
  });

  describe('constructor', function () {
    it('should store the console reference', function () {
      const hb = new HeadlessBrowser({ console: fakeConsole });
      expect(hb.console, 'to be', fakeConsole);
    });
  });

  describe('_launchBrowserMemoized', function () {
    it('should launch a browser and return the same promise on subsequent calls', async function () {
      const hb = new HeadlessBrowser({ console: fakeConsole });
      const promise1 = hb._launchBrowserMemoized();
      const promise2 = hb._launchBrowserMemoized();
      expect(promise1, 'to be', promise2);
      const browser = await promise1;
      expect(browser, 'to be', mockBrowser);
    });
  });

  describe('close', function () {
    it('should close the browser if one was launched', async function () {
      const hb = new HeadlessBrowser({ console: fakeConsole });
      await hb._launchBrowserMemoized();
      await hb.close();
      expect(mockBrowser.close, 'was called once');
    });

    it('should be a no-op if no browser was launched', async function () {
      const hb = new HeadlessBrowser({ console: fakeConsole });
      await hb.close();
      expect(mockBrowser.close, 'was not called');
    });

    it('should clear the launch promise so a new browser can be launched', async function () {
      const hb = new HeadlessBrowser({ console: fakeConsole });
      await hb._launchBrowserMemoized();
      await hb.close();
      expect(hb._launchPromise, 'to be undefined');
    });
  });

  describe('tracePage', function () {
    it('should close the page after tracing', async function () {
      const hb = new HeadlessBrowser({ console: fakeConsole });
      const mockHtmlAsset = {
        assetGraph: mockAssetGraph,
        url: 'file:///test/index.html',
      };

      await hb.tracePage(mockHtmlAsset);
      expect(mockPage.close, 'was called once');
    });

    it('should close the page even if goto throws', async function () {
      mockPage.goto = sinon.stub().rejects(new Error('navigation failed'));
      const hb = new HeadlessBrowser({ console: fakeConsole });
      const mockHtmlAsset = {
        assetGraph: mockAssetGraph,
        url: 'file:///test/index.html',
      };

      await expect(
        hb.tracePage(mockHtmlAsset),
        'to be rejected with',
        'navigation failed'
      );
      expect(mockPage.close, 'was called once');
    });

    it('should close the page even if transferResults throws', async function () {
      mockPage.evaluateHandle = sinon.stub().resolves({
        jsonValue: sinon.stub().rejects(new Error('evaluation failed')),
      });
      const hb = new HeadlessBrowser({ console: fakeConsole });
      const mockHtmlAsset = {
        assetGraph: mockAssetGraph,
        url: 'file:///test/index.html',
      };

      await expect(
        hb.tracePage(mockHtmlAsset),
        'to be rejected with',
        'evaluation failed'
      );
      expect(mockPage.close, 'was called once');
    });
  });

  describe('browser launch failure', function () {
    it('should propagate the error when puppeteer.launch fails', async function () {
      const launchError = new Error('Chrome not found');
      puppeteerStub.launch.rejects(launchError);

      const hb = new HeadlessBrowser({ console: fakeConsole });
      await expect(
        hb._launchBrowserMemoized(),
        'to be rejected with',
        'Chrome not found'
      );
    });
  });
});
