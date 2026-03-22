const fontverter = require('fontverter');

// All standard OpenType GSUB feature tags we care about
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
 * Check the first 4 bytes to determine if conversion to sfnt is needed.
 * Returns true if the buffer is already TrueType (00 01 00 00),
 * CFF/OpenType (OTTO), or a TrueType collection (ttcf).
 */
function isSfnt(buf) {
  if (buf.length < 4) return false;
  const sig = buf.readUInt32BE(0);
  return (
    sig === 0x00010000 || // TrueType
    sig === 0x4f54544f || // OTTO (CFF)
    sig === 0x74746366 // ttcf (TrueType Collection)
  );
}

/**
 * Parse the GSUB table from raw sfnt bytes and return the set of
 * 4-character feature tags present in the font.
 */
function parseGsubFeatureTags(sfntBuf) {
  const tags = new Set();
  const numTables = sfntBuf.readUInt16BE(4);
  let gsubOffset = -1;

  // Walk the table directory (starts at offset 12, each record is 16 bytes)
  for (let i = 0; i < numTables; i++) {
    const recordOffset = 12 + i * 16;
    const tag = sfntBuf.toString('ascii', recordOffset, recordOffset + 4);
    if (tag === 'GSUB') {
      gsubOffset = sfntBuf.readUInt32BE(recordOffset + 8);
      break;
    }
  }

  if (gsubOffset < 0) return tags;

  // GSUB header: majorVersion(2), minorVersion(2), scriptListOffset(2), featureListOffset(2)
  const featureListOffset = gsubOffset + sfntBuf.readUInt16BE(gsubOffset + 6);

  // FeatureList: featureCount(2), then featureCount FeatureRecords of tag(4) + offset(2)
  const featureCount = sfntBuf.readUInt16BE(featureListOffset);
  for (let i = 0; i < featureCount; i++) {
    const recOffset = featureListOffset + 2 + i * 6;
    const featureTag = sfntBuf.toString('ascii', recOffset, recOffset + 4);
    tags.add(featureTag);
  }

  return tags;
}

/**
 * Collect glyph IDs produced by GSUB features for the given text.
 *
 * Only tests features that actually exist in the font's GSUB table,
 * avoiding unnecessary shaping calls. Collects ALL output glyph IDs
 * from each shaping result (not just the first), to handle ligatures
 * and multi-glyph substitutions.
 *
 * @param {Buffer} fontBuffer - The original font data
 * @param {string} text - The text whose characters to check
 * @returns {Promise<number[]>} Array of alternate glyph IDs
 */
async function collectFeatureGlyphIds(fontBuffer, text) {
  const harfbuzzJs = await require('harfbuzzjs');
  const sfnt = isSfnt(fontBuffer)
    ? fontBuffer
    : await fontverter.convert(fontBuffer, 'sfnt');

  // Determine which GSUB features are actually in this font
  const fontFeatures = parseGsubFeatureTags(sfnt);
  const featuresToTest = GSUB_FEATURE_TAGS.filter((tag) =>
    fontFeatures.has(tag)
  );

  // If the font has no relevant GSUB features, skip shaping entirely
  if (featuresToTest.length === 0) return [];

  const blob = harfbuzzJs.createBlob(sfnt);
  const face = harfbuzzJs.createFace(blob, 0);
  const font = harfbuzzJs.createFont(face);

  try {
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
