/**
 * Worker thread for running fontTracer in parallel.
 *
 * Receives: { type: 'trace', taskId, htmlText, stylesheetsWithPredicates }
 * Returns:  { type: 'result', taskId, textByProps: [{text, props}] }
 *
 * Re-parses HTML with jsdom inside the worker since DOM objects
 * cannot be transferred via structured clone.
 */

const { parentPort } = require('worker_threads');
const { JSDOM } = require('jsdom');
const postcss = require('postcss');
const memoizeSync = require('memoizesync');
const fontTracer = require('font-tracer');
const getCssRulesByProperty = require('./getCssRulesByProperty');

// Each worker gets its own memoized getCssRulesByProperty instance.
// Since pages on the same site typically share stylesheets, the
// memoization is effective even within a single worker processing
// multiple pages sequentially.
const memoizedGetCssRulesByProperty = memoizeSync(getCssRulesByProperty);

parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    parentPort.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'trace') {
    try {
      const { taskId, htmlText, stylesheetsWithPredicates: serialized } = msg;

      // Re-parse HTML with jsdom to get a DOM document
      const dom = new JSDOM(htmlText);
      const document = dom.window.document;

      // Re-parse CSS from serialized text — asset objects with PostCSS
      // trees can't cross the structured clone boundary.
      const stylesheetsWithPredicates = serialized.map((entry) => ({
        asset: { parseTree: postcss.parse(entry.text) },
        text: entry.text,
        predicates: entry.predicates,
      }));

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
