const fontverter = require('fontverter');

// Standard OpenType GSUB feature tags that can substitute glyphs.
// We test all of these to find alternate glyph IDs that the font's
// features produce for the given text.
const GSUB_FEATURE_TAGS = [
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
];

/**
 * Collect glyph IDs produced by GSUB features for the given text.
 *
 * For each character in `text`, shapes it with each standard GSUB feature
 * enabled (via harfbuzzjs shapeWithTrace) and compares the output glyph ID
 * to the base (no-feature) shaping. Any alternate glyph IDs are collected.
 *
 * These glyph IDs can be passed to HarfBuzz's subset input glyph set to
 * preserve the alternate glyphs without including all original codepoints.
 *
 * @param {Buffer} fontBuffer - The original font data
 * @param {string} text - The text whose characters to check
 * @returns {Promise<number[]>} Array of alternate glyph IDs
 */
async function collectFeatureGlyphIds(fontBuffer, text) {
  const harfbuzzJs = await require('harfbuzzjs');
  const sfnt = await fontverter.convert(fontBuffer, 'sfnt');
  const blob = harfbuzzJs.createBlob(sfnt);
  const face = harfbuzzJs.createFace(blob, 0);
  const font = harfbuzzJs.createFont(face);

  const altGlyphIds = new Set();
  const chars = [...new Set(text)];

  for (const ch of chars) {
    if (ch.trim() === '') continue;

    // Get base glyph ID (no features)
    const baseBuf = harfbuzzJs.createBuffer();
    baseBuf.addText(ch);
    baseBuf.guessSegmentProperties();
    harfbuzzJs.shapeWithTrace(font, baseBuf, '', 10000, 0);
    const baseGlyphs = baseBuf.json(font);
    baseBuf.destroy();
    if (baseGlyphs.length === 0) continue;

    const baseGid = baseGlyphs[0].g;

    // Shape with each feature and collect alternate glyph IDs
    for (const feat of GSUB_FEATURE_TAGS) {
      const buf = harfbuzzJs.createBuffer();
      buf.addText(ch);
      buf.guessSegmentProperties();
      harfbuzzJs.shapeWithTrace(font, buf, `+${feat}`, 10000, 0);
      const result = buf.json(font);
      buf.destroy();

      if (result.length > 0 && result[0].g !== baseGid) {
        altGlyphIds.add(result[0].g);
      }
    }
  }

  font.destroy();
  face.destroy();
  blob.destroy();

  return [...altGlyphIds];
}

module.exports = collectFeatureGlyphIds;
