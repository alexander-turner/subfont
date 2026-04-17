const expect = require('unexpected');
const parseCommandLineOptions = require('../lib/parseCommandLineOptions');

describe('parseCommandLineOptions', function () {
  it('should return an object with the parsed options and correct defaults', function () {
    expect(
      parseCommandLineOptions(['--dry-run', '--recursive']),
      'to satisfy',
      {
        root: undefined,
        canonicalRoot: undefined,
        output: undefined,
        debug: false,
        dryRun: true,
        silent: false,
        inlineCss: false,
        fontDisplay: 'swap',
        inPlace: false,
        inputFiles: [],
        recursive: true,
        fallbacks: true,
        dynamic: false,
        sourceMaps: false,
        relativeUrls: false,
        cache: false,
        strict: false,
      }
    );
  });

  [
    {
      desc: '--concurrency',
      argv: ['--concurrency', '4'],
      expected: { concurrency: 4 },
    },
    {
      desc: '--chrome-flags (comma-separated)',
      argv: ['--chrome-flags=--no-sandbox,--disable-gpu'],
      expected: { chromeFlags: ['--no-sandbox', '--disable-gpu'] },
    },
    {
      desc: '--cache with a path',
      argv: ['--cache', '/tmp/my-cache'],
      expected: { cache: '/tmp/my-cache' },
    },
    {
      desc: '--cache with empty string triggers boolean coercion',
      argv: ['--cache='],
      expected: { cache: true },
    },
    {
      desc: '--output / -o alias',
      argv: ['-o', '/tmp/output'],
      expected: { output: '/tmp/output' },
    },
    {
      desc: '--in-place / -i alias',
      argv: ['-i'],
      expected: { inPlace: true },
    },
    {
      desc: '--recursive / -r alias',
      argv: ['-r'],
      expected: { recursive: true },
    },
    {
      desc: '--silent / -s alias',
      argv: ['-s'],
      expected: { silent: true },
    },
    {
      desc: '--debug / -d alias',
      argv: ['-d'],
      expected: { debug: true },
    },
    {
      desc: '--font-display with valid value',
      argv: ['--font-display', 'optional'],
      expected: { fontDisplay: 'optional' },
    },
    {
      desc: '--no-fallbacks',
      argv: ['--no-fallbacks'],
      expected: { fallbacks: false },
    },
    {
      desc: '--dynamic',
      argv: ['--dynamic'],
      expected: { dynamic: true },
    },
    {
      desc: '--inline-css',
      argv: ['--inline-css'],
      expected: { inlineCss: true },
    },
    {
      desc: '--source-maps',
      argv: ['--source-maps'],
      expected: { sourceMaps: true },
    },
    {
      desc: '--strict',
      argv: ['--strict'],
      expected: { strict: true },
    },
    {
      desc: '--relative-urls',
      argv: ['--relative-urls'],
      expected: { relativeUrls: true },
    },
    {
      desc: '--root',
      argv: ['--root', '/var/www'],
      expected: { root: '/var/www' },
    },
    {
      desc: '--canonical-root',
      argv: ['--canonical-root', 'https://example.com/'],
      expected: { canonicalRoot: 'https://example.com/' },
    },
    {
      desc: '--text',
      argv: ['--text', '0123456789'],
      expected: { text: '0123456789' },
    },
    {
      desc: '--chrome-flags with empty string',
      argv: ['--chrome-flags='],
      expected: { chromeFlags: [] },
    },
    {
      desc: '--chrome-flags trims whitespace',
      argv: ['--chrome-flags= --no-sandbox , --disable-gpu '],
      expected: { chromeFlags: ['--no-sandbox', '--disable-gpu'] },
    },
  ].forEach(({ desc, argv, expected }) => {
    it(`should parse ${desc}`, function () {
      expect(parseCommandLineOptions(argv), 'to satisfy', expected);
    });
  });

  it('should collect positional arguments as inputFiles', function () {
    const result = parseCommandLineOptions([
      'index.html',
      'about.html',
      '--dry-run',
    ]);
    expect(result.inputFiles, 'to equal', ['index.html', 'about.html']);
    expect(result.dryRun, 'to be true');
  });
});
