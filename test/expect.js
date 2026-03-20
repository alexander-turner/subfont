const expect = require('unexpected')
  .clone()
  .use(require('unexpected-sinon'))
  .use(require('unexpected-resemble'))
  .use(require('unexpected-check'))
  .use(require('magicpen-prism'));
const subsetFonts = require('../lib/subsetFonts');
const pathModule = require('path');
const AssetGraph = require('assetgraph');
const sinon = require('sinon');

let browser;
async function getBrowser() {
  if (!browser) {
    browser = await require('puppeteer').launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-lcd-text',
        '--disable-font-subpixel-positioning',
        '--font-render-hinting=none',
        '--force-color-profile=srgb',
        '--disable-gpu',
        '--disable-skia-runtime-opts',
      ],
    });

    after(async function () {
      await browser.close();
    });
  }
  return browser;
}

async function screenshot(browser, assetGraph, fileName, bannedUrls) {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  const loadedUrls = [];
  page.on('request', (request) => {
    const url = request.url();
    loadedUrls.push(url);
    if (url.startsWith('https://example.com/')) {
      let agUrl = url.replace('https://example.com/', assetGraph.root);
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
        return;
      }
    }
    request.continue();
  });
  await page.goto(`https://example.com/${fileName}`, {
    waitUntil: 'load',
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Wait for a paint cycle to ensure fonts are rendered and layout is stable
    // eslint-disable-next-line no-undef
    await new Promise(
      (resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)) // eslint-disable-line no-undef
    );
  });
  if (bannedUrls) {
    const loadedBannedUrls = loadedUrls.filter((url) =>
      bannedUrls.includes(url)
    );
    if (loadedBannedUrls.length > 0) {
      throw new Error(
        `One or more of the original fonts were loaded:\n  ${loadedBannedUrls.join(
          '\n  '
        )}`
      );
    }
  }
  const screenshot = await page.screenshot();
  await page.close();
  return screenshot;
}

expect.addAssertion(
  '<string> to render the same after subsetting <object?>',
  async (expect, fileName, options = {}) => {
    const assetGraph = new AssetGraph({
      root: pathModule.dirname(fileName),
    });
    const warnSpy = sinon.spy();
    assetGraph.on('warn', warnSpy);
    await expect(
      assetGraph,
      'to render the same after subsetting',
      options,
      pathModule.basename(fileName)
    );
    expect(warnSpy, 'was not called');
  }
);

expect.addAssertion(
  '<object> to render the same after subsetting <object> <string?>',
  async (expect, assetGraph, options, fileName = 'index.html') => {
    const [htmlAsset] = await assetGraph.loadAssets(fileName);
    const originalText = htmlAsset.text;
    expect.subjectOutput = (output) => {
      output.code(originalText, 'html');
    };

    await assetGraph.populate();
    const browser = await getBrowser();
    const fontsBefore = assetGraph
      .findAssets({ type: { $in: ['Ttf', 'Woff', 'Woff2', 'Eot'] } })
      .map((asset) =>
        asset.url.replace(assetGraph.root, 'https://example.com/')
      );
    const screenshotBefore = await screenshot(browser, assetGraph, fileName);
    const { fontInfo } = await subsetFonts(assetGraph, options);
    if (fontInfo.length > 0) {
      const screenshotAfter = await screenshot(
        browser,
        assetGraph,
        fileName,
        fontsBefore
      );
      await expect(screenshotAfter, 'to resemble', screenshotBefore, {
        mismatchPercentage: expect.it('to be less than', 1.5),
      });
    }
  }
);

module.exports = expect;
