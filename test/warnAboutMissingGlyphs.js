const expect = require('unexpected').clone().use(require('unexpected-sinon'));
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('warnAboutMissingGlyphs', function () {
  let warnAboutMissingGlyphs;
  let getFontInfoStub;
  let assetGraph;

  function makeAssetGraph() {
    return {
      warn: sinon.stub(),
      info: sinon.stub(),
    };
  }

  // Helper to build the nested structure warnAboutMissingGlyphs expects
  function makeInput({
    text = 'ABC',
    sourceText = '<p>ABC</p>',
    fontFamily = 'TestFont',
    fontWeight = '400',
    fontStyle = 'normal',
    hasSubsets = true,
  } = {}) {
    const subsetBuffer = Buffer.from('fake-subset');
    const fontFaceNode = {
      // Simulate a PostCSS node with no existing unicode-range declaration
      some: () => false,
      append: sinon.stub(),
    };
    const cssAsset = { markDirty: sinon.stub() };
    const fontUsage = {
      subsets: hasSubsets ? { woff2: subsetBuffer } : undefined,
      fontFamilies: new Set([fontFamily]),
      pageText: text,
      codepoints: { original: [...text].map((c) => c.codePointAt(0)) },
      props: {
        'font-family': fontFamily,
        'font-weight': fontWeight,
        'font-style': fontStyle,
      },
    };

    return {
      htmlOrSvgAsset: {
        text: sourceText,
        urlOrDescription: 'test.html',
      },
      fontUsages: [fontUsage],
      accumulatedFontFaceDeclarations: [
        {
          'font-family': fontFamily,
          relations: [{ node: fontFaceNode, from: cssAsset }],
        },
      ],
    };
  }

  beforeEach(function () {
    getFontInfoStub = sinon.stub();
    assetGraph = makeAssetGraph();

    warnAboutMissingGlyphs = proxyquire('../lib/warnAboutMissingGlyphs', {
      './getFontInfo': getFontInfoStub,
    });
  });

  it('should not warn when all glyphs are present in the subset', async function () {
    getFontInfoStub.resolves({ characterSet: [0x41, 0x42, 0x43] });

    const input = makeInput({ text: 'ABC', sourceText: '<p>ABC</p>' });
    await warnAboutMissingGlyphs([input], assetGraph);

    expect(assetGraph.info, 'was not called');
  });

  it('should warn when a glyph is missing from the subset', async function () {
    // Subset only has A and B, but text uses A, B, C
    getFontInfoStub.resolves({ characterSet: [0x41, 0x42] });

    const input = makeInput({ text: 'ABC', sourceText: '<p>ABC</p>' });
    await warnAboutMissingGlyphs([input], assetGraph);

    expect(assetGraph.info, 'was called once');
    const err = assetGraph.info.firstCall.args[0];
    expect(err.message, 'to contain', '\\u{43}');
    expect(err.message, 'to contain', 'Missing glyph fallback detected');
  });

  it('should skip tab and newline characters', async function () {
    // Subset has A but not tab/newline
    getFontInfoStub.resolves({ characterSet: [0x41] });

    const input = makeInput({
      text: 'A\t\n',
      sourceText: '<p>A</p>',
    });
    await warnAboutMissingGlyphs([input], assetGraph);

    expect(assetGraph.info, 'was not called');
  });

  it('should skip font usages without subsets', async function () {
    getFontInfoStub.resolves({ characterSet: [0x41] });

    const input = makeInput({ text: 'AB', hasSubsets: false });
    await warnAboutMissingGlyphs([input], assetGraph);

    expect(assetGraph.info, 'was not called');
    expect(getFontInfoStub, 'was not called');
  });

  it('should handle getFontInfo failure gracefully', async function () {
    getFontInfoStub.rejects(new Error('corrupt font'));

    const input = makeInput({ text: 'A' });
    await warnAboutMissingGlyphs([input], assetGraph);

    // Should warn about the corrupt font but not crash
    expect(assetGraph.warn, 'was called once');
    // Should not emit a missing glyph info message
    expect(assetGraph.info, 'was not called');
  });

  it('should report missing characters as generated content when not found in source', async function () {
    // Z is in pageText but not in sourceText (e.g. from JS-generated content)
    getFontInfoStub.resolves({ characterSet: [0x41] });

    const input = makeInput({
      text: 'AZ',
      sourceText: '<p>A</p>',
    });
    await warnAboutMissingGlyphs([input], assetGraph);

    expect(assetGraph.info, 'was called once');
    const err = assetGraph.info.firstCall.args[0];
    expect(err.message, 'to contain', '(generated content)');
  });

  it('should report line and column for missing characters found in source', async function () {
    getFontInfoStub.resolves({ characterSet: [0x41] });

    const input = makeInput({
      text: 'AZ',
      sourceText: 'line1\nAZ',
    });
    await warnAboutMissingGlyphs([input], assetGraph);

    expect(assetGraph.info, 'was called once');
    const err = assetGraph.info.firstCall.args[0];
    // Z is at line 2, column 2
    expect(err.message, 'to contain', 'test.html:2:2');
  });

  it('should deduplicate subset buffers across multiple font usages', async function () {
    getFontInfoStub.resolves({ characterSet: [0x41, 0x42, 0x43] });

    const input1 = makeInput({ text: 'ABC' });
    const input2 = makeInput({ text: 'ABC' });
    // Make both use the same subset buffer
    input2.fontUsages[0].subsets = input1.fontUsages[0].subsets;

    await warnAboutMissingGlyphs([input1, input2], assetGraph);

    // getFontInfo should only be called once for the shared buffer
    expect(getFontInfoStub, 'was called once');
  });

  it('should add unicode-range to @font-face when glyphs are missing', async function () {
    getFontInfoStub.resolves({ characterSet: [0x41] });

    const input = makeInput({ text: 'AB' });
    await warnAboutMissingGlyphs([input], assetGraph);

    const fontFaceNode =
      input.accumulatedFontFaceDeclarations[0].relations[0].node;
    expect(fontFaceNode.append, 'was called once');
    const appendArg = fontFaceNode.append.firstCall.args[0];
    expect(appendArg.prop, 'to equal', 'unicode-range');
  });
});
