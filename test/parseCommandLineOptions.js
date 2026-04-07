const expect = require('unexpected');
const parseCommandLineOptions = require('../lib/parseCommandLineOptions');

describe('parseCommandLineOptions', function () {
  it('should return an object with the parsed options', function () {
    expect(
      parseCommandLineOptions(['--dryrun', '--no-fallbacks', '--recursive']),
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
        fallbacks: false,
        dynamic: false,
      }
    );
  });

  it('should allow repeating --formats', function () {
    expect(
      parseCommandLineOptions(['--formats', 'truetype', '--formats', 'woff2']),
      'to satisfy',
      {
        formats: ['truetype', 'woff2'],
      }
    );
  });

  it('should allow passing a comma-separated list of formats', function () {
    const options = parseCommandLineOptions(['--formats', 'truetype,woff2']);

    expect(options, 'to satisfy', {
      formats: ['truetype', 'woff2'],
    });
  });

  it('should parse --concurrency as a number', function () {
    expect(parseCommandLineOptions(['--concurrency', '4']), 'to satisfy', {
      concurrency: 4,
    });
  });

  it('should parse --chrome-flags as a comma-separated array', function () {
    expect(
      parseCommandLineOptions(['--chrome-flags=--no-sandbox,--disable-gpu']),
      'to satisfy',
      { chromeFlags: ['--no-sandbox', '--disable-gpu'] }
    );
  });

  it('should parse --cache with a path', function () {
    expect(
      parseCommandLineOptions(['--cache', '/tmp/my-cache']),
      'to satisfy',
      { cache: '/tmp/my-cache' }
    );
  });
});
