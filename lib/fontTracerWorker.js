/**
 * Worker thread for running fontTracer in parallel.
 *
 * Receives: { htmlText, stylesheetsWithPredicates, cssRulesCache? }
 * Returns:  { textByProps: [{text, props}] }
 *
 * Re-parses HTML with jsdom inside the worker since DOM objects
 * cannot be transferred via structured clone.
 */

const { parentPort } = require('worker_threads');
const { JSDOM } = require('jsdom');
const memoizeSync = require('memoizesync');
const fontTracer = require('font-tracer');
const getCssRulesByProperty = require('./getCssRulesByProperty');

// Each worker gets its own memoized getCssRulesByProperty.
// If a pre-computed CSS rules cache is provided, we use a lookup wrapper.
let memoizedGetCssRulesByProperty;
let precomputedCssRulesCache = null;

function getCssRulesWithCache(properties, cssSource, existingPredicates) {
  // Check the pre-computed cache first
  if (precomputedCssRulesCache) {
    const cacheKey = JSON.stringify([properties, cssSource, existingPredicates]);
    const cached = precomputedCssRulesCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }
  // Fall back to computing
  return getCssRulesByProperty(properties, cssSource, existingPredicates);
}

parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    // Initialize the pre-computed CSS rules cache if provided
    if (msg.cssRulesCache) {
      precomputedCssRulesCache = new Map(msg.cssRulesCache);
    }
    // Create memoized wrapper
    memoizedGetCssRulesByProperty = precomputedCssRulesCache
      ? memoizeSync(getCssRulesWithCache)
      : memoizeSync(getCssRulesByProperty);
    parentPort.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'trace') {
    try {
      const { taskId, htmlText, stylesheetsWithPredicates } = msg;

      // Re-parse HTML with jsdom to get a DOM document
      const dom = new JSDOM(htmlText);
      const document = dom.window.document;

      // Run fontTracer — asset is undefined (skips conditional comments
      // and noscript traversal, which is acceptable for modern sites)
      const textByProps = fontTracer(document, {
        stylesheetsWithPredicates,
        getCssRulesByProperty: memoizedGetCssRulesByProperty,
      });

      // Clean up jsdom to free memory
      dom.window.close();

      // Strip any non-serializable data from results
      const serializableResults = textByProps.map((entry) => ({
        text: entry.text,
        props: { ...entry.props },
      }));

      parentPort.postMessage({
        type: 'result',
        taskId,
        textByProps: serializableResults,
      });
    } catch (err) {
      parentPort.postMessage({
        type: 'error',
        taskId: msg.taskId,
        error: err.message,
        stack: err.stack,
      });
    }
  }
});
