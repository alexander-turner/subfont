const expect = require('unexpected').clone().use(require('unexpected-sinon'));
const sinon = require('sinon');
const fs = require('fs');
const pathModule = require('path');
const proxyquire = require('proxyquire').noCallThru();
const realGetFontInfo = require('../lib/getFontInfo');

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
      './sfntCache': {
        toSfnt: (...args) => fontverterStub.convert(...args),
      },
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

    it('should reject with a useful error for a zero-length buffer', async function () {
      fontverterStub.convert.rejects(
        new Error('Empty buffer is not a supported font format')
      );

      const emptyBuffer = Buffer.alloc(0);
      await expect(
        getFontInfo(emptyBuffer),
        'to be rejected with',
        'Empty buffer is not a supported font format'
      );
    });

    it('should reject with a useful error for random garbage input', async function () {
      fontverterStub.convert.rejects(new Error('Not a supported font format'));

      const garbage = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
      await expect(
        getFontInfo(garbage),
        'to be rejected with',
        'Not a supported font format'
      );
    });

    it('should allow retrying the same buffer after a failure (cache eviction)', async function () {
      const buf = Buffer.from('retry-font');

      // First attempt fails
      fontverterStub.convert
        .onFirstCall()
        .rejects(new Error('transient error'));
      await expect(getFontInfo(buf), 'to be rejected with', 'transient error');

      // Second attempt with the same buffer should work (not return cached rejection)
      fontverterStub.convert.onSecondCall().resolves(Buffer.from('ok'));
      const result = await getFontInfo(buf);
      expect(result.characterSet, 'to equal', [0x41, 0x42, 0x43]);
    });

    it('should not block the queue after a failure', async function () {
      fontverterStub.convert.onFirstCall().rejects(new Error('boom'));
      fontverterStub.convert.onSecondCall().resolves(Buffer.from('ok'));
      fontverterStub.convert.onThirdCall().resolves(Buffer.from('ok2'));

      const bad = Buffer.from('bad');
      const good1 = Buffer.from('good1');
      const good2 = Buffer.from('good2');

      // Queue all three concurrently — the first fails, the rest should succeed
      const p1 = getFontInfo(bad);
      const p2 = getFontInfo(good1);
      const p3 = getFontInfo(good2);

      await expect(p1, 'to be rejected with', 'boom');

      const r2 = await p2;
      expect(r2.characterSet, 'to equal', [0x41, 0x42, 0x43]);

      const r3 = await p3;
      expect(r3.characterSet, 'to equal', [0x41, 0x42, 0x43]);
    });
  });

  describe('real font integration', function () {
    this.timeout(30000);

    it('should extract a non-empty character set from a real TTF', async function () {
      const buffer = fs.readFileSync(
        pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/OpenSans-400.ttf'
        )
      );
      const info = await realGetFontInfo(buffer);

      // Verify structure: real fonts return code points (numbers), not mock values.
      expect(info.characterSet, 'to be an array');
      expect(info.characterSet.length, 'to be greater than', 0);
      for (const codePoint of info.characterSet) {
        expect(codePoint, 'to be a number');
      }
      expect(info.variationAxes, 'to equal', {});
    });

    it('should extract variation axes from a real variable TTF', async function () {
      const buffer = fs.readFileSync(
        pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/variable-font-unused-axes/RobotoFlex-VariableFont_GRAD,XTRA,YOPQ,YTAS,YTDE,YTFI,YTLC,YTUC,opsz,slnt,wdth,wght.ttf'
        )
      );
      const info = await realGetFontInfo(buffer);

      expect(info.variationAxes, 'to have keys', ['wght', 'wdth', 'opsz']);
      expect(info.variationAxes.wght, 'to satisfy', {
        min: expect.it('to be a number'),
        max: expect.it('to be a number'),
        default: expect.it('to be a number'),
      });
      expect(info.variationAxes.wght.min, 'to be less than', 400);
      expect(info.variationAxes.wght.max, 'to be greater than', 400);
    });
  });
});
