const { toSfnt } = require('./sfntCache');

const GSUB_FEATURE_TAGS = new Set([
  'aalt',
  'c2sc',
  'calt',
  'clig',
  'dlig',
  'dnom',
  'frac',
  'liga',
  'lnum',
  'numr',
  'onum',
  'ordn',
  'pnum',
  'salt',
  'sinf',
  'smcp',
  'ss01',
  'ss02',
  'ss03',
  'ss04',
  'ss05',
  'ss06',
  'ss07',
  'ss08',
  'ss09',
  'ss10',
  'ss11',
  'ss12',
  'ss13',
  'ss14',
  'ss15',
  'ss16',
  'ss17',
  'ss18',
  'ss19',
  'ss20',
  'subs',
  'sups',
  'swsh',
  'tnum',
  'zero',
]);

const enqueueWasm = require('./wasmQueue');

async function collectFeatureGlyphIdsImpl(fontBuffer, text) {
  const harfbuzzJs = await require('harfbuzzjs');
  const sfnt = await toSfnt(fontBuffer);

  const blob = harfbuzzJs.createBlob(sfnt);
  const face = harfbuzzJs.createFace(blob, 0);
  const font = harfbuzzJs.createFont(face);

  try {
    const fontFeatures = new Set(face.getTableFeatureTags('GSUB'));
    const featuresToTest = [...fontFeatures].filter((tag) =>
      GSUB_FEATURE_TAGS.has(tag)
    );

    if (featuresToTest.length === 0) return [];

    // Shape the full string once per feature: O(features) calls, not O(chars × features).
    const uniqueChars = [...new Set(text)].filter((ch) => ch.trim() !== '');
    if (uniqueChars.length === 0) return [];
    const testText = uniqueChars.join('');

    const baseBuf = harfbuzzJs.createBuffer();
    let baseGids;
    try {
      baseBuf.addText(testText);
      baseBuf.guessSegmentProperties();
      harfbuzzJs.shapeWithTrace(font, baseBuf, '', 10000, 0);
      const baseGlyphs = baseBuf.json(font);
      if (baseGlyphs.length === 0) return [];
      baseGids = new Set(baseGlyphs.map((g) => g.g));
    } finally {
      baseBuf.destroy();
    }

    const altGlyphIds = new Set();

    for (const feat of featuresToTest) {
      const buf = harfbuzzJs.createBuffer();
      try {
        buf.addText(testText);
        buf.guessSegmentProperties();
        harfbuzzJs.shapeWithTrace(font, buf, `+${feat}`, 10000, 0);
        const result = buf.json(font);

        for (const glyph of result) {
          if (!baseGids.has(glyph.g)) {
            altGlyphIds.add(glyph.g);
          }
        }
      } finally {
        buf.destroy();
      }
    }

    return [...altGlyphIds];
  } finally {
    font.destroy();
    face.destroy();
    blob.destroy();
  }
}

function collectFeatureGlyphIds(fontBuffer, text) {
  return enqueueWasm(() => collectFeatureGlyphIdsImpl(fontBuffer, text));
}

module.exports = collectFeatureGlyphIds;
