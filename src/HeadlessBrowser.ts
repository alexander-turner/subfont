import * as urlTools from 'urltools';
import * as puppeteer from 'puppeteer-core';
import type { Browser as PuppeteerBrowser } from 'puppeteer-core';
import pathModule = require('path');
import os = require('os');
import {
  install,
  Browser,
  detectBrowserPlatform,
  Cache,
} from '@puppeteer/browsers';
import type { AssetGraph, Asset } from 'assetgraph';

// puppeteer's JSHandle types are heavy; only the methods we call are listed.
// The captured trace results come back as plain JSON-shaped records.
// eslint-disable-next-line no-restricted-syntax
type TraceResult = Record<string, unknown>;

interface JsHandleLike {
  jsonValue(): Promise<TraceResult[]>;
  getProperty(name: string): Promise<JsHandleLike>;
  dispose(): Promise<void>;
}

async function transferResults(jsHandle: JsHandleLike): Promise<TraceResult[]> {
  const results = await jsHandle.jsonValue();
  for (const [i, result] of results.entries()) {
    const resultHandle = await jsHandle.getProperty(String(i));
    try {
      const elementHandle = await resultHandle.getProperty('node');
      result.node = elementHandle;
    } finally {
      await resultHandle.dispose();
    }
  }
  return results;
}

// Variadic console.log; eslint-disable-next-line — unknown is correct here.
// eslint-disable-next-line no-restricted-syntax
type LogFn = (...args: unknown[]) => void;

async function downloadOrLocatePreferredBrowserRevision(
  extraArgs: string[] = [],
  log: { log: LogFn } = console
): Promise<PuppeteerBrowser> {
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
  let executablePath: string | undefined;
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
        platform: platform as Parameters<typeof install>[0]['platform'],
      });
      executablePath = result.executablePath;
    }
  }
  return puppeteer.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', ...extraArgs],
  });
}

interface HeadlessBrowserOptions {
  console: Console;
  chromeArgs?: string[];
}

class HeadlessBrowser {
  private console: Console;
  private _chromeArgs: string[];
  private _launchPromise?: Promise<PuppeteerBrowser>;

  constructor({ console, chromeArgs = [] }: HeadlessBrowserOptions) {
    this.console = console;
    this._chromeArgs = chromeArgs;
  }

  private _launchBrowserMemoized(): Promise<PuppeteerBrowser> {
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

  async tracePage(htmlAsset: Asset): Promise<TraceResult[]> {
    const assetGraph = htmlAsset.assetGraph as AssetGraph & {
      canonicalRoot?: string;
    };
    const browser = await this._launchBrowserMemoized();
    const page = await browser.newPage();

    try {
      // Make up a base url to map to the assetgraph root.
      const baseUrl = assetGraph.canonicalRoot
        ? assetGraph.canonicalRoot.replace(/\/?$/, '/')
        : 'https://example.com/';

      // Intercept all requests made by the headless browser, and
      // fake a response from the assetgraph instance if the corresponding
      // asset is found there:
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const url = request.url();
        try {
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
              request.respond({ status: 404, body: '' });
            }
            return;
          }
          if (url.startsWith('file:')) {
            request.continue();
            return;
          }
          // External request — abort to avoid hanging on DNS/network.
          request.abort('failed');
        } catch {
          // Request may already be handled or page may be closing — ignore.
        }
      });

      page.on('requestfailed', (request) => {
        const response = request.response();
        if (response && response.status() > 400) {
          this.console.error(
            `${request.method()} ${request.url()} returned ${response.status()}`
          );
        } else {
          const failure = request.failure();
          const reason = failure ? failure.errorText : 'unknown error';
          this.console.error(
            `${request.method()} ${request.url()} failed: ${reason}`
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
        ),
        { timeout: 30000 }
      );

      await page.addScriptTag({
        path: require.resolve('font-tracer/dist/fontTracer.browser.js'),
      });

      // The injected font-tracer.browser.js script attaches a global
      // `fontTracer`. The closure runs inside the browser, so the global
      // is present at runtime even though TS can't know about it.
      const jsHandle = await page.evaluateHandle(
        /* istanbul ignore next */
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => (globalThis as any).fontTracer(document)
      );
      try {
        // puppeteer's evaluateHandle return type is generic over the page
        // closure; bridge it to the local minimal shape.
        // eslint-disable-next-line no-restricted-syntax
        return await transferResults(jsHandle as unknown as JsHandleLike);
      } finally {
        await jsHandle.dispose();
      }
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    const launchPromise = this._launchPromise;
    if (launchPromise) {
      this._launchPromise = undefined;
      let browser: PuppeteerBrowser;
      try {
        browser = await launchPromise;
      } catch {
        // Launch failed — nothing to close
        return;
      }
      await browser.close();
    }
  }
}

export = HeadlessBrowser;
