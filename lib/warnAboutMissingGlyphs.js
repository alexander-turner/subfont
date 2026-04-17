const LinesAndColumns = require('lines-and-columns').default;
const getFontInfo = require('./getFontInfo');
const unicodeRange = require('./unicodeRange');

const MAX_LOCATIONS_PER_GLYPH = 3;

async function warnAboutMissingGlyphs(
  htmlOrSvgAssetTextsWithProps,
  assetGraph
) {
  // Collapse per (char, font-face, page) to one entry with a count + a few
  // example locations. A single missing char (e.g. U+200B zero-width space)
  // can otherwise produce hundreds of identical lines.
  const collapsed = new Map();

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
          const key = `${htmlOrSvgAsset.urlOrDescription}\0${fontUsage.props['font-family']}\0${fontUsage.props['font-weight']}\0${fontUsage.props['font-style']}\0${codePoint}`;
          let entry = collapsed.get(key);
          if (!entry) {
            entry = {
              codePoint,
              char,
              htmlOrSvgAsset,
              fontUsage,
              locations: [],
              count: 0,
              searchFrom: 0,
            };
            collapsed.set(key, entry);
          }
          entry.count += 1;

          if (entry.locations.length < MAX_LOCATIONS_PER_GLYPH) {
            const sourceText = htmlOrSvgAsset.text;
            const foundIdx = sourceText.indexOf(char, entry.searchFrom);
            if (foundIdx !== -1) {
              if (!linesAndColumns) {
                linesAndColumns = new LinesAndColumns(sourceText);
              }
              const position = linesAndColumns.locationForIndex(foundIdx);
              entry.locations.push(
                `${htmlOrSvgAsset.urlOrDescription}:${position.line + 1}:${position.column + 1}`
              );
              entry.searchFrom = foundIdx + char.length;
            } else if (entry.locations.length === 0) {
              entry.locations.push(
                `${htmlOrSvgAsset.urlOrDescription} (generated content)`
              );
            }
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

  if (collapsed.size > 0) {
    const errorLog = [...collapsed.values()].map(
      ({ char, fontUsage, locations, count }) => {
        const suffix =
          count > locations.length
            ? ` (+${count - locations.length} more)`
            : '';
        const countPrefix = count > 1 ? ` [${count}x]` : '';
        return `- \\u{${char.codePointAt(0).toString(16)}} (${char}) in font-family '${
          fontUsage.props['font-family']
        }' (${fontUsage.props['font-weight']}/${
          fontUsage.props['font-style']
        })${countPrefix} at ${locations.join(', ')}${suffix}`;
      }
    );

    const message = `Missing glyph fallback detected.
When your primary webfont doesn't contain the glyphs you use, browsers that don't support unicode-range will load your fallback fonts, which will be a potential waste of bandwidth.
These glyphs are used on your site, but they don't exist in the font you applied to them:`;

    assetGraph.info(new Error(`${message}\n${errorLog.join('\n')}`));
  }
}

module.exports = warnAboutMissingGlyphs;
