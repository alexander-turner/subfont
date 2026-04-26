import os = require('os');
// yargs is exported as a callable/chainable singleton; the typings only
// expose half of that shape, so this union (and the cast below) keeps the
// runtime API ergonomics without leaking `unknown` everywhere.
import yargsModule = require('yargs');
import type { Argv } from 'yargs';
import { getMaxConcurrency } from './concurrencyLimit';

interface YargsLib extends Argv {
  (argv: string[]): Argv;
  terminalWidth(): number;
}
// eslint-disable-next-line no-restricted-syntax
const yargsLib = yargsModule as unknown as YargsLib;

interface ParseResult {
  yargs: Argv;
  inputFiles: Array<string | number>;
  // Yargs forwards arbitrary keys (camelCase + alias mirrors) into the
  // returned object; downstream consumers index by string key.
  // eslint-disable-next-line no-restricted-syntax
  [key: string]: unknown;
}

function parseCommandLineOptions(argv?: string[]): ParseResult {
  let y: Argv = yargsLib;
  if (argv) {
    y = yargsLib(argv);
  }

  const maxConcurrency = getMaxConcurrency();

  const { version } = require('../package.json');

  y.usage(
    'Create optimal font subsets from your actual font usage.\n$0 [options] <htmlFile(s) | url(s)>'
  )
    .version(version)
    .options('root', {
      describe:
        'Path to your web root (will be deduced from your input files if not specified)',
      type: 'string',
    })
    .options('canonical-root', {
      describe:
        'URI root where the site will be deployed. Must be either an absolute, a protocol-relative, or a root-relative url',
      type: 'string',
    })
    .options('output', {
      alias: 'o',
      describe: 'Directory where results should be written to',
      type: 'string',
    })
    .options('text', {
      describe:
        'Additional characters to include in the subset for every @font-face found on the page',
      type: 'string',
    })
    .options('fallbacks', {
      describe:
        'Async-load the full original font as a fallback for dynamic content. Disable with --no-fallbacks',
      type: 'boolean',
      default: true,
    })
    .options('dynamic', {
      describe:
        'Also trace the usage of fonts in a headless browser with JavaScript enabled',
      type: 'boolean',
      default: false,
    })
    .options('in-place', {
      alias: 'i',
      describe: 'Modify HTML-files in-place. Only use on build artifacts',
      type: 'boolean',
      default: false,
    })
    .options('inline-css', {
      describe: 'Inline CSS that declares the @font-face for the subset fonts',
      type: 'boolean',
      default: false,
    })
    .options('font-display', {
      describe: 'Injects a font-display value into the @font-face CSS',
      type: 'string',
      default: 'swap',
      choices: ['auto', 'block', 'swap', 'fallback', 'optional'],
    })
    .options('recursive', {
      alias: 'r',
      describe:
        'Crawl all HTML-pages linked with relative and root relative links. This stays inside your domain',
      type: 'boolean',
      default: false,
    })
    .options('relative-urls', {
      describe: 'Issue relative urls instead of root-relative ones',
      type: 'boolean',
      default: false,
    })
    .options('silent', {
      alias: 's',
      describe: `Do not write anything to stdout`,
      type: 'boolean',
      default: false,
    })
    .options('debug', {
      alias: 'd',
      describe: 'Verbose insights into font glyph detection',
      type: 'boolean',
      default: false,
    })
    .options('dry-run', {
      describe: `Don't write anything to disk. Shows a preview of files, sizes, and CSS changes that would be made`,
      type: 'boolean',
      default: false,
    })
    .options('cache', {
      describe:
        'Enable disk caching of subset font results between runs. Pass a directory path or use without a value for the default .subfont-cache directory',
      type: 'string',
      default: false,
      coerce(val: string | boolean) {
        if (val === '' || val === true) return true;
        return val;
      },
    })
    .options('chrome-flags', {
      alias: ['chromeFlags'],
      describe:
        'Custom flags to pass to the Chrome/Chromium browser for dynamic tracing (comma-separated)',
      type: 'string',
      coerce(flags: string | undefined) {
        if (!flags) return [];
        return flags.split(',').map((f) => f.trim());
      },
    })
    .options('concurrency', {
      describe: `Maximum number of worker threads for parallel font tracing. Defaults to the number of CPU cores (max 8). Upper bound: ${maxConcurrency} (based on free memory and CPU count)`,
      type: 'number',
    })
    .check((argv: { concurrency?: number }) => {
      if (argv.concurrency !== undefined) {
        if (!Number.isInteger(argv.concurrency) || argv.concurrency < 1) {
          throw new Error('--concurrency must be a positive integer');
        }
        if (argv.concurrency > maxConcurrency) {
          throw new Error(
            `--concurrency must not exceed ${maxConcurrency} (each worker uses ~50 MB; ${Math.round(os.freemem() / (1024 * 1024 * 1024))} GB free, ${os.cpus().length} CPUs)`
          );
        }
      }
      return true;
    })
    .options('source-maps', {
      describe: 'Preserve CSS source maps through subfont processing',
      type: 'boolean',
      default: false,
    })
    .options('strict', {
      describe:
        'Exit with a non-zero status code if any warnings are emitted during the run',
      type: 'boolean',
      default: false,
    })
    .wrap(yargsLib.terminalWidth());

  // Yargs returns an opaque shape; the runtime payload is positionals plus
  // arbitrary string-keyed flag values. eslint-disable-next-line —
  // `unknown` is the right type for "anything yargs handed back".
  // eslint-disable-next-line no-restricted-syntax
  type ParsedArgv = { _: Array<string | number> } & Record<string, unknown>;
  const parsed = y.argv as ParsedArgv;
  const { _: inputFiles, ...rest } = parsed;

  return {
    yargs: y,
    inputFiles,
    ...rest,
  };
}

export = parseCommandLineOptions;
