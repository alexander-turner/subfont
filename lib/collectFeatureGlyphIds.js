const fontverter = require('fontverter');

// Standard OpenType GSUB feature tags that can substitute glyphs.
// We intersect with the font's actual GSUB features to avoid
// unnecessary shaping calls.
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

/**
 * Collect glyph IDs produced by GSUB features for the given text.
 *
 * Uses harfbuzzjs face.getTableFeatureTags('GSUB') to enumerate the
 * font's actual GSUB features, then only tests those that are in our
 * known substitution set. Collects ALL output glyph IDs from each
 * shaping result (not just the first), to handle ligatures and
 * multi-glyph substitutions.
 *
 * @param {Buffer} fontBuffer - The original font data
 * @param {string} text - The text whose characters to check
 * @returns {Promise<number[]>} Array of alternate glyph IDs
 */
async function collectFeatureGlyphIds(fontBuffer, text) {
  const harfbuzzJs = await require('harfbuzzjs');
  const sfnt =
    fontverter.detectFormat(fontBuffer) === 'sfnt'
      ? fontBuffer
      : await fontverter.convert(fontBuffer, 'sfnt');

  const blob = harfbuzzJs.createBlob(sfnt);
  const face = harfbuzzJs.createFace(blob, 0);
  const font = harfbuzzJs.createFont(face);

  try {
    // Use harfbuzzjs to enumerate GSUB features directly from the font,
    // then intersect with our known substitution tags
    const fontFeatures = new Set(face.getTableFeatureTags('GSUB'));
    const featuresToTest = [...fontFeatures].filter((tag) =>
      GSUB_FEATURE_TAGS.has(tag)
    );

    if (featuresToTest.length === 0) return [];

    const altGlyphIds = new Set();
    const chars = [...new Set(text)];

    for (const ch of chars) {
      if (ch.trim() === '') continue;

      // Get base glyph IDs (no features)
      const baseBuf = harfbuzzJs.createBuffer();
      let baseGids;
      try {
        baseBuf.addText(ch);
        baseBuf.guessSegmentProperties();
        harfbuzzJs.shapeWithTrace(font, baseBuf, '', 10000, 0);
        const baseGlyphs = baseBuf.json(font);
        if (baseGlyphs.length === 0) continue;
        baseGids = new Set(baseGlyphs.map((g) => g.g));
      } finally {
        baseBuf.destroy();
      }

      // Shape with each present feature and collect alternate glyph IDs
      for (const feat of featuresToTest) {
        const buf = harfbuzzJs.createBuffer();
        try {
          buf.addText(ch);
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
    }

    return [...altGlyphIds];
  } finally {
    font.destroy();
    face.destroy();
    blob.destroy();
  }
}

module.exports = collectFeatureGlyphIds;
