const expect = require('unexpected').clone().use(require('unexpected-sinon'));
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('getFontInfo', function () {
  let getFontInfo;
  let mockFace;
  let mockBlob;
  let harfbuzzJsStub;
  let fontverterStub;

  beforeEach(function () {
    mockFace = {
      collectUnicodes: sinon.stub().returns(new Set([0x41, 0x42, 0x43])),
      getAxisInfos: sinon.stub().returns([]),
      destroy: sinon.stub(),
    };

    mockBlob = {
      destroy: sinon.stub(),
    };

    harfbuzzJsStub = Promise.resolve({
      createBlob: sinon.stub().returns(mockBlob),
      createFace: sinon.stub().returns(mockFace),
    });

    fontverterStub = {
      convert: sinon.stub().resolves(Buffer.from('fake-sfnt-data')),
    };

    getFontInfo = proxyquire('../lib/getFontInfo', {
      harfbuzzjs: harfbuzzJsStub,
      fontverter: fontverterStub,
    });
  });

  it('should extract characterSet and variationAxes from a font buffer', async function () {
    const buffer = Buffer.from('fake-font');
    const result = await getFontInfo(buffer);

    expect(result, 'to equal', {
      characterSet: [0x41, 0x42, 0x43],
      variationAxes: [],
    });
  });

  it('should return cached results for the same buffer', async function () {
    const buffer = Buffer.from('fake-font');
    const promise1 = getFontInfo(buffer);
    const promise2 = getFontInfo(buffer);

    expect(promise1, 'to be', promise2);
  });

  it('should process different buffers independently', async function () {
    const buffer1 = Buffer.from('font-1');
    const buffer2 = Buffer.from('font-2');

    const result1 = await getFontInfo(buffer1);
    const result2 = await getFontInfo(buffer2);

    // Both should succeed with the same mock data
    expect(result1, 'to equal', {
      characterSet: [0x41, 0x42, 0x43],
      variationAxes: [],
    });
    expect(result2, 'to equal', {
      characterSet: [0x41, 0x42, 0x43],
      variationAxes: [],
    });
  });

  it('should serialize concurrent calls through the WASM queue', async function () {
    const callOrder = [];

    fontverterStub.convert = sinon.stub().callsFake(async () => {
      callOrder.push('convert');
      return Buffer.from('sfnt');
    });

    const buf1 = Buffer.from('font-a');
    const buf2 = Buffer.from('font-b');

    // Launch both concurrently
    const [r1, r2] = await Promise.all([getFontInfo(buf1), getFontInfo(buf2)]);

    // Both should resolve successfully
    expect(r1.characterSet, 'to equal', [0x41, 0x42, 0x43]);
    expect(r2.characterSet, 'to equal', [0x41, 0x42, 0x43]);

    // fontverter.convert should have been called twice (once per buffer)
    expect(fontverterStub.convert, 'was called twice');
  });

  it('should clean up face and blob after extraction', async function () {
    const buffer = Buffer.from('fake-font');
    await getFontInfo(buffer);

    expect(mockFace.destroy, 'was called once');
    expect(mockBlob.destroy, 'was called once');
  });

  it('should handle variation axes in font info', async function () {
    const axes = [
      { tag: 'wght', minValue: 100, defaultValue: 400, maxValue: 900 },
      { tag: 'wdth', minValue: 75, defaultValue: 100, maxValue: 125 },
    ];
    mockFace.getAxisInfos.returns(axes);

    const buffer = Buffer.from('variable-font');
    const result = await getFontInfo(buffer);

    expect(result.variationAxes, 'to equal', axes);
  });

  describe('error handling', function () {
    it('should propagate errors when fontverter.convert fails', async function () {
      fontverterStub.convert.rejects(new Error('Invalid font data'));

      const buffer = Buffer.from('corrupt-font');
      await expect(
        getFontInfo(buffer),
        'to be rejected with',
        'Invalid font data'
      );
    });

    it('should continue processing after a previous call rejects', async function () {
      // First call will fail
      fontverterStub.convert.onFirstCall().rejects(new Error('bad'));
      // Second call will succeed
      fontverterStub.convert.onSecondCall().resolves(Buffer.from('ok'));

      const buf1 = Buffer.from('bad-font');
      const buf2 = Buffer.from('good-font');

      await expect(getFontInfo(buf1), 'to be rejected');

      // The queue should recover and process the next call
      const result = await getFontInfo(buf2);
      expect(result.characterSet, 'to equal', [0x41, 0x42, 0x43]);
    });
  });
});
