/**
 * Worker thread for running fontTracer in parallel.
 *
 * Receives: { type: 'trace', taskId, htmlText, stylesheetsWithPredicates }
 * Returns:  { type: 'result', taskId, textByProps: [{text, props}] }
 *
 * Re-parses HTML with jsdom inside the worker since DOM objects
 * cannot be transferred via structured clone.
 */

import { parentPort } from 'worker_threads';
import { JSDOM } from 'jsdom';
import * as postcss from 'postcss';
import memoizeSync = require('memoizesync');
import fontTracer = require('font-tracer');
import getCssRulesByProperty = require('./getCssRulesByProperty');

interface InitMessage {
  type: 'init';
}

interface TraceMessage {
  type: 'trace';
  taskId: number;
  htmlText: string;
  stylesheetsWithPredicates: Array<{
    text: string;
    // Predicates carry CSS-tracing context (mediaQuery, conditionalComment,
    // script/scope flags). The pool serializes them across the worker
    // boundary unchanged; the value union is wider than booleans alone.
    predicates: Record<string, unknown>; // eslint-disable-line no-restricted-syntax
  }>;
}

type IncomingMessage = InitMessage | TraceMessage;

if (!parentPort) {
  throw new Error('fontTracerWorker must be run as a worker thread');
}

const port = parentPort;

// Each worker gets its own memoized getCssRulesByProperty instance.
// Since pages on the same site typically share stylesheets, the
// memoization is effective even within a single worker processing
// multiple pages sequentially.
const memoizedGetCssRulesByProperty = memoizeSync(getCssRulesByProperty);

port.on('message', (msg: IncomingMessage) => {
  if (msg.type === 'init') {
    port.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'trace') {
    const { taskId, htmlText, stylesheetsWithPredicates: serialized } = msg;
    let dom: JSDOM | undefined;
    try {
      // Re-parse HTML with jsdom to get a DOM document
      dom = new JSDOM(htmlText);
      const document = dom.window.document;

      // Re-parse CSS from serialized text — asset objects with PostCSS
      // trees can't cross the structured clone boundary.
      const stylesheetsWithPredicates = serialized.map((entry) => ({
        asset: { parseTree: postcss.parse(entry.text) },
        text: entry.text,
        predicates: entry.predicates,
      }));

      const textByProps = fontTracer(document, {
        stylesheetsWithPredicates,
        getCssRulesByProperty: memoizedGetCssRulesByProperty,
      });

      // Strip any non-serializable data from results
      const serializableResults = textByProps.map((entry) => ({
        text: entry.text,
        props: { ...entry.props },
      }));

      port.postMessage({
        type: 'result',
        taskId,
        textByProps: serializableResults,
      });
    } catch (rawErr) {
      const err = rawErr as Error;
      port.postMessage({
        type: 'error',
        taskId: msg.taskId,
        error: err.message,
        stack: err.stack,
      });
    } finally {
      // Clean up jsdom to free memory — must run even if fontTracer throws
      if (dom) dom.window.close();
    }
  }
});
