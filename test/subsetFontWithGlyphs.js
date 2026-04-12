const expect = require('unexpected');
const fs = require('fs');
const pathModule = require('path');
const subsetFontWithGlyphs = require('../lib/subsetFontWithGlyphs');

const ttfPath = pathModule.resolve(
  __dirname,
  '../testdata/subsetFonts/Roboto-400.ttf'
);

describe('subsetFontWithGlyphs', function () {
  this.timeout(30000);

  let ttfBuffer;
  before(function () {
    ttfBuffer = fs.readFileSync(ttfPath);
  });

  it('should produce a smaller woff2 subset for a few characters', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'Hello', {
      targetFormat: 'woff2',
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
    expect(result.length, 'to be less than', ttfBuffer.length);
  });

  it('should produce a truetype subset', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'ABC', {
      targetFormat: 'truetype',
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should produce a woff subset', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'Test', {
      targetFormat: 'woff',
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should handle an empty text string', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, '', {
      targetFormat: 'woff2',
    });

    expect(result, 'to be a', Buffer);
  });

  it('should accept glyphIds option', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, '', {
      targetFormat: 'woff2',
      glyphIds: [0, 1, 2],
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should combine text and glyphIds', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, 'AB', {
      targetFormat: 'woff2',
      glyphIds: [0],
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should handle Unicode characters', async function () {
    const result = await subsetFontWithGlyphs(ttfBuffer, '\u00e9\u00f1\u00fc', {
      targetFormat: 'woff2',
    });

    expect(result, 'to be a', Buffer);
    expect(result.length, 'to be greater than', 0);
  });

  it('should serialize concurrent calls (p-limit)', async function () {
    const results = await Promise.all([
      subsetFontWithGlyphs(ttfBuffer, 'A', { targetFormat: 'woff2' }),
      subsetFontWithGlyphs(ttfBuffer, 'B', { targetFormat: 'woff2' }),
      subsetFontWithGlyphs(ttfBuffer, 'C', { targetFormat: 'woff2' }),
    ]);

    for (const result of results) {
      expect(result, 'to be a', Buffer);
      expect(result.length, 'to be greater than', 0);
    }
  });
});
