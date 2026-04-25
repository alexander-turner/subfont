const expect = require('unexpected');
const { convert } = require('../lib/fontConverter');
const fs = require('fs');
const pathModule = require('path');

const woff2Path = pathModule.resolve(
  __dirname,
  '..',
  'testdata',
  'subsetFonts',
  'Roboto-400.woff2'
);

describe('fontConverter', function () {
  let woff2Font;
  before(function () {
    woff2Font = fs.readFileSync(woff2Path);
  });

  it('should convert a woff2 font to sfnt', async function () {
    const result = await convert(woff2Font, 'sfnt');
    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should handle multiple concurrent conversions', async function () {
    const results = await Promise.all([
      convert(woff2Font, 'sfnt'),
      convert(woff2Font, 'sfnt'),
    ]);
    for (const result of results) {
      expect(result, 'to be a', Buffer);
    }
    expect(results[0].length, 'to equal', results[1].length);
  });

  it('should reject on invalid input', async function () {
    await expect(
      convert(Buffer.from('not a valid font'), 'sfnt'),
      'to be rejected'
    );
  });
});
