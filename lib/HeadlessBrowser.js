const urlTools = require('urltools');
const puppeteer = require('puppeteer-core');
const pathModule = require('path');
const os = require('os');
const {
  install,
  Browser,
  detectBrowserPlatform,
  Cache,
} = require('@puppeteer/browsers');

async function transferResults(jsHandle) {
  const results = await jsHandle.jsonValue();
  for (const [i, result] of results.entries()) {
    const resultHandle = await jsHandle.getProperty(String(i));
    const elementHandle = await resultHandle.getProperty('node');
    result.node = elementHandle;
  }
  return results;
}

async function downloadOrLocatePreferredBrowserRevision(
  extraArgs = [],
  log = console
) {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...extraArgs],
    });
  }
  const cacheDir = pathModule.resolve(__dirname, '..', 'puppeteer-browsers');
  const platform = detectBrowserPlatform();
  const cache = new Cache(cacheDir);
  const installed = cache.getInstalledBrowsers();
  let executablePath;
  const chromeEntry = installed.find((b) => b.browser === Browser.CHROME);
  if (chromeEntry) {
    executablePath = chromeEntry.executablePath;
  } else {
    // Check the default puppeteer cache (~/.cache/puppeteer) before downloading
    const defaultCacheDir = pathModule.join(
      os.homedir(),
      '.cache',
      'puppeteer'
    );
    const defaultCache = new Cache(defaultCacheDir);
    const defaultInstalled = defaultCache.getInstalledBrowsers();
    const defaultChromeEntry = defaultInstalled.find(
      (b) => b.browser === Browser.CHROME
    );
    if (defaultChromeEntry) {
      executablePath = defaultChromeEntry.executablePath;
    } else {
      log.log('Downloading Chrome');
      const result = await install({
        browser: Browser.CHROME,
        buildId: 'stable',
        cacheDir,
        platform,
      });
      executablePath = result.executablePath;
    }
  }
  return puppeteer.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', ...extraArgs],
  });
}

class HeadlessBrowser {
  constructor({ console, chromeArgs = [] }) {
    this.console = console;
    this._chromeArgs = chromeArgs;
  }

  _launchBrowserMemoized() {
    // Make sure we only download and launch one browser per HeadlessBrowser instance.
    // Clear the cached promise on failure so a subsequent call can retry.
    if (!this._launchPromise) {
      this._launchPromise = downloadOrLocatePreferredBrowserRevision(
        this._chromeArgs,
        this.console
      ).catch((err) => {
        this._launchPromise = undefined;
        throw err;
      });
    }
    return this._launchPromise;
  }

  async tracePage(htmlAsset) {
    const assetGraph = htmlAsset.assetGraph;
    const browser = await this._launchBrowserMemoized();
    const page = await browser.newPage();

    try {
      // Make up a base url to map to the assetgraph root.
      // Use the canonical root if available, so that it'll be
      // easier to handle absolute and protocol-relative urls pointing
      // at it, as well as fall through to the actual domain if some
      // assets aren't found in the graph.
      const baseUrl = assetGraph.canonicalRoot
        ? assetGraph.canonicalRoot.replace(/\/?$/, '/')
        : 'https://example.com/';

      // Intercept all requests made by the headless browser, and
      // fake a response from the assetgraph instance if the corresponding
      // asset is found there:
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const url = request.url();
        if (url.startsWith(baseUrl)) {
          let agUrl = url.replace(baseUrl, assetGraph.root);
          if (/\/$/.test(agUrl)) {
            agUrl += 'index.html';
          }
          const asset = assetGraph.findAssets({
            isLoaded: true,
            url: agUrl,
          })[0];
          if (asset) {
            request.respond({
              status: 200,
              contentType: asset.contentType,
              body: asset.rawSrc,
            });
          } else {
            // Asset not in graph — return 404 instead of letting the
            // request hit the network (baseUrl is synthetic).
            request.respond({ status: 404, body: '' });
          }
          return;
        }
        if (url.startsWith('file:')) {
          request.continue();
          return;
        }
        // External request — abort to avoid hanging on DNS/network.
        // The requestfailed handler will log it.
        request.abort('failed');
      });

      page.on('requestfailed', (request) => {
        const response = request.response();
        if (response && response.status() > 400) {
          this.console.error(
            `${request.method()} ${request.url()} returned ${response.status()}`
          );
        } else {
          this.console.error(
            `${request.method()} ${request.url()} failed: ${
              request.failure().errorText
            }`
          );
        }
      });

      page.on('pageerror', (err) => {
        // Puppeteer v24+ passes Error objects; format stack to match v19 style
        if (err instanceof Error && err.stack) {
          // Normalize "at <anonymous> (url:line:col)" to "at url:line:col"
          const normalized = err.stack.replace(
            /at <anonymous> \((.+)\)/g,
            'at $1'
          );
          this.console.error(normalized);
        } else if (err instanceof Error) {
          this.console.error(`${err.name}: ${err.message}`);
        } else {
          this.console.error(err);
        }
      });
      page.on('error', this.console.error);

      // Prevent the CSP of the page from rejecting our injection of font-tracer
      await page.setBypassCSP(true);

      await page.goto(
        urlTools.resolveUrl(
          baseUrl,
          urlTools.buildRelativeUrl(assetGraph.root, htmlAsset.url)
        )
      );

      await page.addScriptTag({
        path: require.resolve('font-tracer/dist/fontTracer.browser.js'),
      });

      const jsHandle = await page.evaluateHandle(
        /* global fontTracer */
        /* istanbul ignore next */
        () => fontTracer(document)
      );
      return await transferResults(jsHandle);
    } finally {
      await page.close();
    }
  }

  async close() {
    const launchPromise = this._launchPromise;
    if (launchPromise) {
      this._launchPromise = undefined;
      const browser = await launchPromise;
      await browser.close();
    }
  }
}

module.exports = HeadlessBrowser;
