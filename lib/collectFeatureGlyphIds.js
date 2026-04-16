const { toSfnt } = require('./sfntCache');

// GSUB feature tags that can produce alternate glyphs.  Used as the
// fallback set when CSS doesn't specify which features are in use.
// Keep in sync with fontVariantToOTTags in collectTextsByPage.js.
const GSUB_FEATURE_TAGS = new Set([
  'aalt',
  'afrc',
  'c2pc',
  'c2sc',
  'calt',
  'ccmp', // glyph composition/decomposition — needed for combining characters
  'clig',
  'dlig',
  'dnom',
  'frac',
  'fwid',
  'hist',
  'hlig',
  'jp04',
  'jp78',
  'jp83',
  'jp90',
  'liga',
  'lnum',
  'locl', // localized forms — language-specific glyph variants
  'nalt',
  'numr',
  'onum',
  'ordn',
  'ornm',
  'pcap',
  'pnum',
  'pwid',
  'rclt', // required contextual alternates — needed for many scripts
  'rlig', // required ligatures — mandatory for Arabic/Indic scripts
  'ruby',
  'salt',
  'sinf',
  'smcp',
  'smpl',
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
  'titl',
  'tnum',
  'trad',
  'unic',
  'zero',
]);

const enqueueWasm = require('./wasmQueue');

async function collectFeatureGlyphIdsImpl(fontBuffer, text, cssFeatureTags) {
  const harfbuzzJs = await require('harfbuzzjs');
  const sfnt = await toSfnt(fontBuffer);

  const blob = harfbuzzJs.createBlob(sfnt);
  const face = harfbuzzJs.createFace(blob, 0);
  const font = harfbuzzJs.createFont(face);

  try {
    const fontFeatures = new Set(face.getTableFeatureTags('GSUB'));

    // When CSS specifies which features are used, only test those.
    // Otherwise fall back to the full set of supported GSUB features.
    const allowedTags =
      cssFeatureTags && cssFeatureTags.length > 0
        ? new Set(cssFeatureTags)
        : GSUB_FEATURE_TAGS;

    const featuresToTest = [...fontFeatures].filter((tag) =>
      allowedTags.has(tag)
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

function collectFeatureGlyphIds(fontBuffer, text, cssFeatureTags) {
  return enqueueWasm(() =>
    collectFeatureGlyphIdsImpl(fontBuffer, text, cssFeatureTags)
  );
}

module.exports = collectFeatureGlyphIds;
