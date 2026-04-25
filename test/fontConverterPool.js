const expect = require('unexpected');
const { FontConverterPool } = require('../lib/fontConverterPool');
const fs = require('fs');
const pathModule = require('path');

describe('FontConverterPool', function () {
  let pool;

  afterEach(async function () {
    if (pool) {
      await pool.destroy();
      pool = null;
    }
  });

  it('should initialize and convert a font buffer', async function () {
    pool = new FontConverterPool(1);
    const woff2Font = fs.readFileSync(
      pathModule.resolve(
        __dirname,
        '..',
        'testdata',
        'subsetFonts',
        'Roboto-400.woff2'
      )
    );

    const sfntResult = await pool.convert(woff2Font, 'sfnt');
    expect(sfntResult, 'to be a', Buffer);
    expect(sfntResult.length, 'to be greater than', 0);
    // sfnt (TrueType/OpenType) files start with a 4-byte signature
    expect(sfntResult.length, 'to be greater than', woff2Font.length);
  });

  it('should handle multiple concurrent conversions', async function () {
    pool = new FontConverterPool(2);
    const woff2Font = fs.readFileSync(
      pathModule.resolve(
        __dirname,
        '..',
        'testdata',
        'subsetFonts',
        'Roboto-400.woff2'
      )
    );

    const results = await Promise.all([
      pool.convert(woff2Font, 'sfnt'),
      pool.convert(woff2Font, 'sfnt'),
    ]);

    for (const result of results) {
      expect(result, 'to be a', Buffer);
      expect(result.length, 'to be greater than', 0);
    }
    expect(results[0].length, 'to equal', results[1].length);
  });

  it('should queue tasks when all workers are busy', async function () {
    pool = new FontConverterPool(1);
    const woff2Font = fs.readFileSync(
      pathModule.resolve(
        __dirname,
        '..',
        'testdata',
        'subsetFonts',
        'Roboto-400.woff2'
      )
    );

    const results = await Promise.all([
      pool.convert(woff2Font, 'sfnt'),
      pool.convert(woff2Font, 'sfnt'),
      pool.convert(woff2Font, 'sfnt'),
    ]);

    expect(results, 'to have length', 3);
    for (const result of results) {
      expect(result, 'to be a', Buffer);
    }
  });

  it('should clean up on destroy without hanging', async function () {
    pool = new FontConverterPool(1);
    // Just init and destroy — verify it doesn't hang
    await pool.convert(
      fs.readFileSync(
        pathModule.resolve(
          __dirname,
          '..',
          'testdata',
          'subsetFonts',
          'Roboto-400.woff2'
        )
      ),
      'sfnt'
    );
    await pool.destroy();
    pool = null;
  });

  it('should handle conversion errors gracefully', async function () {
    pool = new FontConverterPool(1);
    const invalidBuffer = Buffer.from('not a valid font');

    await expect(pool.convert(invalidBuffer, 'sfnt'), 'to be rejected');
  });
});
