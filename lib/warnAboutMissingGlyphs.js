const LinesAndColumns = require('lines-and-columns').default;
const getFontInfo = require('./getFontInfo');
const unicodeRange = require('./unicodeRange');

async function warnAboutMissingGlyphs(
  htmlOrSvgAssetTextsWithProps,
  assetGraph
) {
  const missingGlyphsErrors = [];

  // Collect all unique subset buffers and parse them concurrently.
  // getFontInfo internally serializes harfbuzzjs WASM calls, so
  // Promise.all just queues them up rather than running in parallel.
  const uniqueSubsetBuffers = new Map();
  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of fontUsages) {
      if (!fontUsage.subsets) continue;
      const subsetBuffer = Object.values(fontUsage.subsets)[0];
      if (!uniqueSubsetBuffers.has(subsetBuffer)) {
        uniqueSubsetBuffers.set(
          subsetBuffer,
          getFontInfo(subsetBuffer)
            .then((info) => new Set(info.characterSet))
            .catch((err) => {
              assetGraph.warn(err);
              return null;
            })
        );
      }
    }
  }
  const subsetCharSetCache = new Map();
  await Promise.all(
    [...uniqueSubsetBuffers.entries()].map(async ([buffer, promise]) => {
      subsetCharSetCache.set(buffer, await promise);
    })
  );

  for (const {
    htmlOrSvgAsset,
    fontUsages,
    accumulatedFontFaceDeclarations,
  } of htmlOrSvgAssetTextsWithProps) {
    let linesAndColumns;
    for (const fontUsage of fontUsages) {
      if (!fontUsage.subsets) continue;
      const subsetBuffer = Object.values(fontUsage.subsets)[0];
      const characterSetLookup = subsetCharSetCache.get(subsetBuffer);
      if (!characterSetLookup) continue; // getFontInfo failed on subset; already warned

      let missedAny = false;
      for (const char of fontUsage.pageText) {
        // Turns out that browsers don't mind that these are missing:
        if (char === '\t' || char === '\n') {
          continue;
        }

        const codePoint = char.codePointAt(0);

        const isMissing = !characterSetLookup.has(codePoint);

        if (isMissing) {
          // Find all occurrences of the missing character in the source,
          // not just the first, so that every location is reported.
          const locations = [];
          const sourceText = htmlOrSvgAsset.text;
          let searchIdx = 0;
          while (true) {
            const charIdx = sourceText.indexOf(char, searchIdx);
            if (charIdx === -1) break;
            if (!linesAndColumns) {
              linesAndColumns = new LinesAndColumns(sourceText);
            }
            const position = linesAndColumns.locationForIndex(charIdx);
            locations.push(
              `${htmlOrSvgAsset.urlOrDescription}:${position.line + 1}:${
                position.column + 1
              }`
            );
            searchIdx = charIdx + char.length;
          }

          if (locations.length === 0) {
            locations.push(
              `${htmlOrSvgAsset.urlOrDescription} (generated content)`
            );
          }

          for (const location of locations) {
            missingGlyphsErrors.push({
              codePoint,
              char,
              htmlOrSvgAsset,
              fontUsage,
              location,
            });
          }
          missedAny = true;
        }
      }
      if (missedAny) {
        const fontFaces = accumulatedFontFaceDeclarations.filter((fontFace) =>
          fontUsage.fontFamilies.has(fontFace['font-family'])
        );
        for (const fontFace of fontFaces) {
          const cssFontFaceSrc = fontFace.relations[0];
          const fontFaceDeclaration = cssFontFaceSrc.node;
          if (
            !fontFaceDeclaration.some((node) => node.prop === 'unicode-range')
          ) {
            fontFaceDeclaration.append({
              prop: 'unicode-range',
              value: unicodeRange(fontUsage.codepoints.original),
            });
            cssFontFaceSrc.from.markDirty();
          }
        }
      }
    }
  }

  if (missingGlyphsErrors.length) {
    const errorLog = missingGlyphsErrors.map(
      ({ char, fontUsage, location }) =>
        `- \\u{${char.codePointAt(0).toString(16)}} (${char}) in font-family '${
          fontUsage.props['font-family']
        }' (${fontUsage.props['font-weight']}/${
          fontUsage.props['font-style']
        }) at ${location}`
    );

    const message = `Missing glyph fallback detected.
When your primary webfont doesn't contain the glyphs you use, browsers that don't support unicode-range will load your fallback fonts, which will be a potential waste of bandwidth.
These glyphs are used on your site, but they don't exist in the font you applied to them:`;

    assetGraph.info(new Error(`${message}\n${errorLog.join('\n')}`));
  }
}

module.exports = warnAboutMissingGlyphs;
