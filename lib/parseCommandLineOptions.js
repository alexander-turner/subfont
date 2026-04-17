module.exports = function parseCommandLineOptions(argv) {
  const os = require('os');
  const { getMaxConcurrency } = require('./concurrencyLimit');
  let yargs = require('yargs');
  if (argv) {
    yargs = yargs(argv);
  }

  const maxConcurrency = getMaxConcurrency();

  yargs
    .usage(
      'Create optimal font subsets from your actual font usage.\n$0 [options] <htmlFile(s) | url(s)>'
    )
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
      coerce(val) {
        if (val === '' || val === true) return true;
        return val;
      },
    })
    .options('chrome-flags', {
      alias: ['chromeFlags'],
      describe:
        'Custom flags to pass to the Chrome/Chromium browser for dynamic tracing (comma-separated)',
      type: 'string',
      coerce(flags) {
        if (!flags) return [];
        return flags.split(',').map((f) => f.trim());
      },
    })
    .options('concurrency', {
      describe: `Maximum number of worker threads for parallel font tracing. Defaults to the number of CPU cores (max 8). Upper bound: ${maxConcurrency} (based on available memory)`,
      type: 'number',
    })
    .check((argv) => {
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
    .wrap(require('yargs').terminalWidth());

  const { _: inputFiles, ...rest } = yargs.argv;

  return {
    yargs,
    inputFiles,
    ...rest,
  };
};
