import { LinesAndColumns } from 'lines-and-columns';
import getFontInfo = require('./getFontInfo');
import unicodeRange = require('./unicodeRange');

interface AtRuleLike {
  some(predicate: (node: { prop?: string }) => boolean): boolean;
  append(decl: { prop: string; value: string }): void;
}

interface FontFaceRelationLike {
  from: { markDirty(): void };
  // The postcss AtRule for `@font-face { ... }`. Container methods
  // (`some`, `append`) operate on its child declarations.
  node: AtRuleLike;
}

interface FontFaceDeclaration {
  'font-family'?: string;
  relations: FontFaceRelationLike[];
}

interface FontUsageLike {
  subsets?: Record<string, Buffer | Uint8Array>;
  pageText: string;
  fontFamilies: Set<string>;
  codepoints: { original: number[] };
  props: Record<string, string>;
}

interface AssetTextEntry {
  htmlOrSvgAsset: { text: string; urlOrDescription: string };
  fontUsages: FontUsageLike[];
  accumulatedFontFaceDeclarations: FontFaceDeclaration[];
}

interface AssetGraphLike {
  warn(err: Error): void;
  info(err: Error): void;
}

async function warnAboutMissingGlyphs(
  htmlOrSvgAssetTextsWithProps: AssetTextEntry[],
  assetGraph: AssetGraphLike
): Promise<void> {
  const missingGlyphsErrors: Array<{
    codePoint: number | undefined;
    char: string;
    htmlOrSvgAsset: AssetTextEntry['htmlOrSvgAsset'];
    fontUsage: FontUsageLike;
    location: string;
    occurrences: number;
  }> = [];

  // Collect all unique subset buffers and parse them concurrently.
  // getFontInfo internally serializes harfbuzzjs WASM calls, so
  // Promise.all just queues them up rather than running in parallel.
  const uniqueSubsetBuffers = new Map<
    Buffer | Uint8Array,
    Promise<Set<number> | null>
  >();
  for (const { fontUsages } of htmlOrSvgAssetTextsWithProps) {
    for (const fontUsage of fontUsages) {
      if (!fontUsage.subsets) continue;
      const subsetBuffer = Object.values(fontUsage.subsets)[0];
      if (!uniqueSubsetBuffers.has(subsetBuffer)) {
        uniqueSubsetBuffers.set(
          subsetBuffer,
          getFontInfo(subsetBuffer)
            .then((info) => new Set(info.characterSet))
            // eslint-disable-next-line no-restricted-syntax
            .catch((rawErr: unknown) => {
              assetGraph.warn(rawErr as Error);
              return null;
            })
        );
      }
    }
  }
  const subsetCharSetCache = new Map<Buffer | Uint8Array, Set<number> | null>();
  await Promise.all(
    [...uniqueSubsetBuffers.entries()].map(async ([buffer, promise]) => {
      subsetCharSetCache.set(buffer, await promise);
    })
  );

  // Codepoint unions per @font-face declaration, keyed by the at-rule node.
  // Built across all fontUsages on a page, then flushed in a single append
  // per @font-face so multiple fontUsages sharing a family don't lose data.
  const unicodeRangeAccumulator = new Map<
    AtRuleLike,
    {
      relation: FontFaceRelationLike;
      codepoints: Set<number>;
    }
  >();

  for (const {
    htmlOrSvgAsset,
    fontUsages,
    accumulatedFontFaceDeclarations,
  } of htmlOrSvgAssetTextsWithProps) {
    let linesAndColumns: LinesAndColumns | undefined;
    // Dedupe scans for the same missing char across different fontUsages on
    // this page. On KaTeX-heavy pages the same symbol is often missing in
    // several font-families, and each scan is an O(N) walk of the HTML text.
    const charLookupCache = new Map<
      string,
      { firstLocation: string; occurrences: number }
    >();
    const lookupChar = (char: string) => {
      const cachedHit = charLookupCache.get(char);
      if (cachedHit) return cachedHit;
      let firstLocation: string | undefined;
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
      const result = { firstLocation, occurrences };
      charLookupCache.set(char, result);
      return result;
    };
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
        if (codePoint === undefined) continue;

        const isMissing = !characterSetLookup.has(codePoint);

        if (isMissing) {
          // Report only the first location plus a count of remaining
          // occurrences. A character like U+200B can appear thousands of
          // times on a page and per-occurrence lines drown the log.
          const { firstLocation, occurrences } = lookupChar(char);

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
        for (const fontFace of accumulatedFontFaceDeclarations) {
          const family = fontFace['font-family'];
          if (!family || !fontUsage.fontFamilies.has(family)) continue;
          const relation = fontFace.relations[0];
          const node = relation.node;
          if (node.some((decl) => decl.prop === 'unicode-range')) continue;
          let entry = unicodeRangeAccumulator.get(node);
          if (!entry) {
            entry = { relation, codepoints: new Set() };
            unicodeRangeAccumulator.set(node, entry);
          }
          for (const cp of fontUsage.codepoints.original) {
            entry.codepoints.add(cp);
          }
        }
      }
    }
  }

  // Flush accumulated unicode-range declarations: one append per @font-face,
  // covering every fontUsage that mapped to it.
  for (const { relation, codepoints } of unicodeRangeAccumulator.values()) {
    relation.node.append({
      prop: 'unicode-range',
      value: unicodeRange([...codepoints]),
    });
    relation.from.markDirty();
  }

  if (missingGlyphsErrors.length) {
    const errorLog = missingGlyphsErrors.map(
      ({ char, fontUsage, location, occurrences }) => {
        const extra = occurrences > 1 ? ` (+${occurrences - 1} more)` : '';
        return `- \\u{${(char.codePointAt(0) as number).toString(16)}} (${char}) in font-family '${
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

export = warnAboutMissingGlyphs;
