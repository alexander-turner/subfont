const expect = require('unexpected');
const FontTracerPool = require('../lib/FontTracerPool');

describe('FontTracerPool', function () {
  this.timeout(30000);

  it('should initialize workers and process trace requests', async function () {
    const pool = new FontTracerPool(1);
    await pool.init();

    const result = await pool.trace(
      '<html><body><p style="font-family: Arial">Hello</p></body></html>',
      []
    );

    expect(result, 'to be an', 'array');
    await pool.destroy();
  });

  it('should handle multiple concurrent trace requests', async function () {
    const pool = new FontTracerPool(2);
    await pool.init();

    const promises = [
      pool.trace('<html><body><p>Page 1</p></body></html>', []),
      pool.trace('<html><body><p>Page 2</p></body></html>', []),
      pool.trace('<html><body><p>Page 3</p></body></html>', []),
    ];

    const results = await Promise.all(promises);
    expect(results, 'to have length', 3);
    for (const result of results) {
      expect(result, 'to be an', 'array');
    }

    await pool.destroy();
  });

  it('should clean up workers on destroy', async function () {
    const pool = new FontTracerPool(2);
    await pool.init();
    expect(pool._workers, 'to have length', 2);

    await pool.destroy();
    expect(pool._workers, 'to have length', 0);
    expect(pool._idle, 'to have length', 0);
  });

  it('should handle empty HTML gracefully', async function () {
    const pool = new FontTracerPool(1);
    await pool.init();

    const result = await pool.trace('', []);
    expect(result, 'to be an', 'array');

    await pool.destroy();
  });
});
