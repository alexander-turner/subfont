const pathModule = require('path');
const {
  Browser,
  Cache,
  detectBrowserPlatform,
  install,
} = require('@puppeteer/browsers');

let _result;

/**
 * Check whether a headless Chrome binary is available for puppeteer.
 * Caches the result so the check only runs once per test run.
 * @returns {Promise<boolean>}
 */
async function canUsePuppeteer() {
  if (_result !== undefined) return _result;

  // If an explicit executable path is set, trust it
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    _result = true;
    return _result;
  }

  const cacheDir = pathModule.resolve(__dirname, '..', 'puppeteer-browsers');
  const cache = new Cache(cacheDir);
  const installed = cache.getInstalledBrowsers();
  if (installed.some((b) => b.browser === Browser.CHROME)) {
    _result = true;
    return _result;
  }

  // Try to install — if it fails (no network, 404, etc.), Chrome is unavailable
  try {
    await install({
      browser: Browser.CHROME,
      buildId: 'stable',
      cacheDir,
      platform: detectBrowserPlatform(),
    });
    _result = true;
  } catch {
    _result = false;
  }
  return _result;
}

module.exports = canUsePuppeteer;
