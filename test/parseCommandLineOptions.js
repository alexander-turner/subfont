const expect = require('unexpected');
const parseCommandLineOptions = require('../lib/parseCommandLineOptions');

describe('parseCommandLineOptions', function () {
  it('should return an object with the parsed options', function () {
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
  ].forEach(({ desc, argv, expected }) => {
    it(`should parse ${desc}`, function () {
      expect(parseCommandLineOptions(argv), 'to satisfy', expected);
    });
  });
});
