const expect = require('unexpected').clone().use(require('unexpected-sinon'));
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

function createMockPool(convertStub) {
  return {
    getPool() {
      return { convert: convertStub };
    },
  };
}

describe('sfntCache', function () {
  it('should return the buffer directly when format is sfnt', async function () {
    const buffer = Buffer.from('test');
    const convertStub = sinon.stub();
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().returns('sfnt'),
      },
      './fontConverterPool': createMockPool(convertStub),
    });

    const result = await toSfnt(buffer);
    expect(result, 'to be', buffer);
    expect(convertStub, 'was not called');
  });

  it('should route woff2 through the converter pool', async function () {
    const buffer = Buffer.from('test');
    const converted = Buffer.from('converted');
    const convertStub = sinon.stub().resolves(converted);
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().returns('woff2'),
      },
      './fontConverterPool': createMockPool(convertStub),
    });

    const result = await toSfnt(buffer);
    expect(result, 'to be', converted);
    expect(convertStub, 'was called with', buffer, 'sfnt');
  });

  it('should convert non-woff2 non-sfnt via fontverter directly', async function () {
    const buffer = Buffer.from('test');
    const converted = Buffer.from('converted');
    const poolConvert = sinon.stub();
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().returns('woff'),
        convert: sinon.stub().resolves(converted),
      },
      './fontConverterPool': createMockPool(poolConvert),
    });

    const result = await toSfnt(buffer);
    expect(result, 'to be', converted);
    expect(poolConvert, 'was not called');
  });

  it('should fall back to pool when detectFormat throws', async function () {
    const buffer = Buffer.from('garbage');
    const converted = Buffer.from('converted');
    const convertStub = sinon.stub().resolves(converted);
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().throws(new Error('Unknown format')),
      },
      './fontConverterPool': createMockPool(convertStub),
    });

    const result = await toSfnt(buffer);
    expect(result, 'to be', converted);
  });

  it('should cache results for the same buffer', async function () {
    const buffer = Buffer.from('test');
    const converted = Buffer.from('converted');
    const convertStub = sinon.stub().resolves(converted);
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().returns('woff2'),
      },
      './fontConverterPool': createMockPool(convertStub),
    });

    await toSfnt(buffer);
    await toSfnt(buffer);
    expect(convertStub, 'was called once');
  });

  it('should cache the fallback convert when detectFormat throws', async function () {
    const buffer = Buffer.from('garbage');
    const converted = Buffer.from('converted');
    const convertStub = sinon.stub().resolves(converted);
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().throws(new Error('Unknown format')),
      },
      './fontConverterPool': createMockPool(convertStub),
    });

    await toSfnt(buffer);
    await toSfnt(buffer);
    expect(convertStub, 'was called once');
  });

  it('should evict cache on rejection so retries work', async function () {
    const buffer = Buffer.from('test');
    let callCount = 0;
    const convertStub = sinon.stub().callsFake(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('fail'));
      }
      return Promise.resolve(Buffer.from('ok'));
    });
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().returns('woff2'),
      },
      './fontConverterPool': createMockPool(convertStub),
    });

    await expect(toSfnt(buffer), 'to be rejected with', 'fail');
    const result = await toSfnt(buffer);
    expect(result, 'to equal', Buffer.from('ok'));
  });
});
