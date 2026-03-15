const expect = require('unexpected')
  .clone()
  .use(require('unexpected-sinon'));
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('HeadlessBrowser', function () {
  let HeadlessBrowser;
  let mockBrowser;
  let mockPage;
  let puppeteerStub;
  let browsersStub;

  beforeEach(function () {
    mockPage = {
      setRequestInterception: sinon.stub().resolves(),
      on: sinon.stub(),
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
        getInstalledBrowsers: sinon.stub().returns([
          { browser: 'chrome', executablePath: '/fake/chrome' },
        ]),
      }),
    };

    HeadlessBrowser = proxyquire('../lib/HeadlessBrowser', {
      'puppeteer-core': puppeteerStub,
      '@puppeteer/browsers': browsersStub,
    });
  });

  describe('constructor', function () {
    it('should store the console reference', function () {
      const fakeConsole = { log: sinon.stub(), error: sinon.stub() };
      const hb = new HeadlessBrowser({ console: fakeConsole });
      expect(hb.console, 'to be', fakeConsole);
    });
  });

  describe('_launchBrowserMemoized', function () {
    it('should launch a browser and return the same promise on subsequent calls', async function () {
      const hb = new HeadlessBrowser({ console });
      const promise1 = hb._launchBrowserMemoized();
      const promise2 = hb._launchBrowserMemoized();
      expect(promise1, 'to be', promise2);
      const browser = await promise1;
      expect(browser, 'to be', mockBrowser);
    });
  });

  describe('close', function () {
    it('should close the browser if one was launched', async function () {
      const hb = new HeadlessBrowser({ console });
      // Launch a browser first
      await hb._launchBrowserMemoized();
      await hb.close();
      expect(mockBrowser.close, 'was called once');
    });

    it('should be a no-op if no browser was launched', async function () {
      const hb = new HeadlessBrowser({ console });
      // Should not throw
      await hb.close();
      expect(mockBrowser.close, 'was not called');
    });

    it('should clear the launch promise so a new browser can be launched', async function () {
      const hb = new HeadlessBrowser({ console });
      await hb._launchBrowserMemoized();
      await hb.close();
      expect(hb._launchPromise, 'to be undefined');
    });
  });

  describe('browser launch failure', function () {
    it('should propagate the error when puppeteer.launch fails', async function () {
      const launchError = new Error('Chrome not found');
      puppeteerStub.launch.rejects(launchError);

      const hb = new HeadlessBrowser({ console });
      await expect(
        hb._launchBrowserMemoized(),
        'to be rejected with',
        'Chrome not found'
      );
    });
  });
});
