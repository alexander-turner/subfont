// Cheap codepoint range checks used to gate optional table dropping.
// The ranges below are deliberately a small hardcoded list, not a faithful
// transcription of every Unicode block — getting the common cases right
// (math operators, emoji, alphanumeric symbols) is enough to keep us safe
// on the 99% of pages that would benefit, while a stray rare codepoint
// falling outside the list just means we keep the table.

interface Range {
  min: number;
  max: number;
}

const MATH_RANGES: Range[] = [
  { min: 0x2190, max: 0x21ff }, // Arrows (commonly used as math operators)
  { min: 0x2200, max: 0x22ff }, // Mathematical Operators
  { min: 0x27c0, max: 0x27ef }, // Misc Mathematical Symbols-A
  { min: 0x2980, max: 0x29ff }, // Misc Mathematical Symbols-B
  { min: 0x2a00, max: 0x2aff }, // Supplemental Mathematical Operators
  { min: 0x1d400, max: 0x1d7ff }, // Mathematical Alphanumeric Symbols
];

const EMOJI_RANGES: Range[] = [
  { min: 0x1f300, max: 0x1f5ff }, // Misc Symbols and Pictographs
  { min: 0x1f600, max: 0x1f64f }, // Emoticons
  { min: 0x1f680, max: 0x1f6ff }, // Transport and Map Symbols
  { min: 0x1f700, max: 0x1f77f }, // Alchemical Symbols (some color emoji include)
  { min: 0x1f900, max: 0x1f9ff }, // Supplemental Symbols and Pictographs
  { min: 0x1fa70, max: 0x1faff }, // Symbols and Pictographs Extended-A
  { min: 0x2600, max: 0x26ff }, // Misc Symbols (☀, ☂, ☎, …)
  { min: 0x2700, max: 0x27bf }, // Dingbats
  { min: 0x1f000, max: 0x1f02f }, // Mahjong Tiles
  { min: 0x1f0a0, max: 0x1f0ff }, // Playing Cards
];

function textHitsRanges(text: string, ranges: Range[]): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    for (const { min, max } of ranges) {
      if (cp >= min && cp <= max) return true;
    }
  }
  return false;
}

export function pageNeedsMathTable(text: string): boolean {
  return textHitsRanges(text, MATH_RANGES);
}

export function pageNeedsColorTables(text: string): boolean {
  return textHitsRanges(text, EMOJI_RANGES);
}
