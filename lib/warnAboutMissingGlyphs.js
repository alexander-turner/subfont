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
          // Report only the first location plus a count of remaining
          // occurrences. A character like U+200B can appear thousands of
          // times on a page and per-occurrence lines drown the log.
          let firstLocation;
          let occurrences = 0;
          if (char.length > 0) {
            const sourceText = htmlOrSvgAsset.text;
            let searchIdx = 0;
            while (true) {
              const charIdx = sourceText.indexOf(char, searchIdx);
              if (charIdx === -1) break;
              occurrences++;
              if (occurrences === 1) {
                if (!linesAndColumns) {
                  linesAndColumns = new LinesAndColumns(sourceText);
                }
                const position = linesAndColumns.locationForIndex(charIdx);
                firstLocation = `${htmlOrSvgAsset.urlOrDescription}:${
                  position.line + 1
                }:${position.column + 1}`;
              }
              searchIdx = charIdx + char.length;
            }
          }

          if (!firstLocation) {
            firstLocation = `${htmlOrSvgAsset.urlOrDescription} (generated content)`;
          }

          missingGlyphsErrors.push({
            codePoint,
            char,
            htmlOrSvgAsset,
            fontUsage,
            location: firstLocation,
            occurrences,
          });
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
      ({ char, fontUsage, location, occurrences }) => {
        const extra = occurrences > 1 ? ` (+${occurrences - 1} more)` : '';
        return `- \\u{${char.codePointAt(0).toString(16)}} (${char}) in font-family '${
          fontUsage.props['font-family']
        }' (${fontUsage.props['font-weight']}/${
          fontUsage.props['font-style']
        }) at ${location}${extra}`;
      }
    );

    const message = `Missing glyph fallback detected.
When your primary webfont doesn't contain the glyphs you use, browsers that don't support unicode-range will load your fallback fonts, which will be a potential waste of bandwidth.
These glyphs are used on your site, but they don't exist in the font you applied to them:`;

    assetGraph.info(new Error(`${message}\n${errorLog.join('\n')}`));
  }
}

module.exports = warnAboutMissingGlyphs;
