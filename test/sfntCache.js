const expect = require('unexpected').clone().use(require('unexpected-sinon'));
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('sfntCache', function () {
  it('should return the buffer directly when format is sfnt', async function () {
    const buffer = Buffer.from('test');
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().returns('sfnt'),
        convert: sinon.stub(),
      },
    });

    const result = await toSfnt(buffer);
    expect(result, 'to be', buffer);
  });

  it('should convert non-sfnt formats', async function () {
    const buffer = Buffer.from('test');
    const converted = Buffer.from('converted');
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().returns('woff2'),
        convert: sinon.stub().resolves(converted),
      },
    });

    const result = await toSfnt(buffer);
    expect(result, 'to be', converted);
  });

  it('should fall back to convert when detectFormat throws', async function () {
    const buffer = Buffer.from('garbage');
    const converted = Buffer.from('converted');
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().throws(new Error('Unknown format')),
        convert: sinon.stub().resolves(converted),
      },
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
        convert: convertStub,
      },
    });

    await toSfnt(buffer);
    await toSfnt(buffer);
    expect(convertStub, 'was called once');
  });

  it('should evict cache on rejection so retries work', async function () {
    const buffer = Buffer.from('test');
    let callCount = 0;
    const { toSfnt } = proxyquire('../lib/sfntCache', {
      fontverter: {
        detectFormat: sinon.stub().returns('woff2'),
        convert: sinon.stub().callsFake(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error('fail'));
          }
          return Promise.resolve(Buffer.from('ok'));
        }),
      },
    });

    await expect(toSfnt(buffer), 'to be rejected with', 'fail');
    const result = await toSfnt(buffer);
    expect(result, 'to equal', Buffer.from('ok'));
  });
});
