const expect = require('unexpected');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

function makeHarfbuzzMock({
  gsubTags = [],
  baseGlyphs = [{ g: 1 }],
  featureGlyphsByCall = null,
} = {}) {
  let jsonCallCount = 0;
  const featureGlyphs = featureGlyphsByCall || [baseGlyphs];

  const mockBuffer = {
    addText: sinon.stub(),
    guessSegmentProperties: sinon.stub(),
    json: sinon.stub().callsFake(() => {
      const result =
        jsonCallCount === 0
          ? baseGlyphs
          : featureGlyphs[jsonCallCount - 1] || baseGlyphs;
      jsonCallCount++;
      return result;
    }),
    destroy: sinon.stub(),
  };

  return {
    createBlob: sinon.stub().returns({ destroy: sinon.stub() }),
    createFace: sinon.stub().returns({
      getTableFeatureTags: sinon.stub().returns(gsubTags),
      destroy: sinon.stub(),
    }),
    createFont: sinon.stub().returns({ destroy: sinon.stub() }),
    createBuffer: sinon.stub().returns(mockBuffer),
    shapeWithTrace: sinon.stub(),
  };
}

function createModule(harfbuzzMock) {
  return proxyquire('../lib/collectFeatureGlyphIds', {
    './sfntCache': { toSfnt: sinon.stub().resolves(Buffer.from('sfnt')) },
    './wasmQueue': (fn) => fn(),
    harfbuzzjs: Promise.resolve(harfbuzzMock),
  });
}

describe('collectFeatureGlyphIds', function () {
  it('should return empty when font has no matching GSUB features', async function () {
    const mock = makeHarfbuzzMock({ gsubTags: ['kern', 'mark'] });
    const result = await createModule(mock)(Buffer.from('font'), 'abc');
    expect(result, 'to equal', []);
  });

  it('should return empty when text is only whitespace', async function () {
    const mock = makeHarfbuzzMock({ gsubTags: ['liga'] });
    const result = await createModule(mock)(Buffer.from('font'), '   \t\n');
    expect(result, 'to equal', []);
  });

  it('should return empty when base shaping produces no glyphs', async function () {
    const mock = makeHarfbuzzMock({
      gsubTags: ['liga'],
      baseGlyphs: [],
    });
    const result = await createModule(mock)(Buffer.from('font'), 'abc');
    expect(result, 'to equal', []);
  });

  it('should collect alternate glyph IDs from feature shaping', async function () {
    const mock = makeHarfbuzzMock({
      gsubTags: ['smcp'],
      baseGlyphs: [{ g: 1 }, { g: 2 }],
      featureGlyphsByCall: [[{ g: 1 }, { g: 5 }]],
    });
    const result = await createModule(mock)(Buffer.from('font'), 'ab');
    expect(result, 'to equal', [5]);
  });
});
