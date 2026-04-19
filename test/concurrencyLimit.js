const expect = require('unexpected');
const proxyquire = require('proxyquire').noCallThru();

describe('concurrencyLimit', function () {
  function createModule({ freemem, cpus }) {
    return proxyquire('../lib/concurrencyLimit', {
      os: {
        freemem: () => freemem,
        cpus: () => new Array(cpus),
      },
    });
  }

  describe('getMaxConcurrency', function () {
    it('should return at least 1 even with very low memory', function () {
      const { getMaxConcurrency } = createModule({
        freemem: 1024,
        cpus: 1,
      });
      expect(getMaxConcurrency(), 'to equal', 1);
    });

    it('should be bounded by free memory', function () {
      const WORKER_MB = 50 * 1024 * 1024;
      // 200 MB free, 64 CPUs — memory should be the bottleneck
      const { getMaxConcurrency } = createModule({
        freemem: 200 * 1024 * 1024,
        cpus: 64,
      });
      expect(
        getMaxConcurrency(),
        'to equal',
        Math.floor((200 * 1024 * 1024) / WORKER_MB)
      );
    });

    it('should be bounded by CPU count', function () {
      // 100 GB free, 2 CPUs — CPU should be the bottleneck
      const { getMaxConcurrency } = createModule({
        freemem: 100 * 1024 * 1024 * 1024,
        cpus: 2,
      });
      expect(getMaxConcurrency(), 'to equal', 2);
    });

    it('should return 1 when both memory and CPUs report zero', function () {
      const { getMaxConcurrency } = createModule({
        freemem: 0,
        cpus: 0,
      });
      expect(getMaxConcurrency(), 'to equal', 1);
    });

    it('should use the minimum of memory and CPU bounds', function () {
      // 500 MB free (10 by memory), 4 CPUs — CPU wins
      const { getMaxConcurrency } = createModule({
        freemem: 500 * 1024 * 1024,
        cpus: 4,
      });
      expect(getMaxConcurrency(), 'to equal', 4);
    });

    it('should scale to high core counts when memory is ample', function () {
      const { getMaxConcurrency } = createModule({
        freemem: 100 * 1024 * 1024 * 1024,
        cpus: 256,
      });
      expect(getMaxConcurrency(), 'to equal', 256);
    });
  });

  describe('WORKER_MEMORY_BYTES', function () {
    it('should be 50 MB', function () {
      const { WORKER_MEMORY_BYTES } = require('../lib/concurrencyLimit');
      expect(WORKER_MEMORY_BYTES, 'to equal', 50 * 1024 * 1024);
    });
  });
});
