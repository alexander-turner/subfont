// Codepoint range tables used to gate optional table dropping and to map
// codepoints to OpenType script tags. Ranges are deliberately a small
// hardcoded list, not a faithful transcription of every Unicode block —
// getting common cases right is enough; an unmapped codepoint just means
// we keep the table or skip the script.

interface Range {
  min: number;
  max: number;
}
interface ScriptRange extends Range {
  tag: string;
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
  { min: 0x2600, max: 0x26ff }, // Misc Symbols (☀, ☂, ☎, …)
  { min: 0x2700, max: 0x27bf }, // Dingbats
  { min: 0x1f000, max: 0x1f02f }, // Mahjong Tiles
  { min: 0x1f0a0, max: 0x1f0ff }, // Playing Cards
  { min: 0x1f300, max: 0x1f5ff }, // Misc Symbols and Pictographs
  { min: 0x1f600, max: 0x1f64f }, // Emoticons
  { min: 0x1f680, max: 0x1f6ff }, // Transport and Map Symbols
  { min: 0x1f700, max: 0x1f77f }, // Alchemical Symbols
  { min: 0x1f900, max: 0x1f9ff }, // Supplemental Symbols and Pictographs
  { min: 0x1fa70, max: 0x1faff }, // Symbols and Pictographs Extended-A
];

// Latin ranges are intentionally omitted: scriptsForText() always seeds
// the result set with 'latn', so any Latin codepoint already counts.
const SCRIPT_RANGES: ScriptRange[] = [
  { min: 0x0370, max: 0x03ff, tag: 'grek' }, // Greek and Coptic
  { min: 0x1f00, max: 0x1fff, tag: 'grek' }, // Greek Extended
  { min: 0x0400, max: 0x052f, tag: 'cyrl' }, // Cyrillic + Supplement
  { min: 0x2de0, max: 0x2dff, tag: 'cyrl' }, // Cyrillic Extended-A
  { min: 0xa640, max: 0xa69f, tag: 'cyrl' }, // Cyrillic Extended-B
  { min: 0x0590, max: 0x05ff, tag: 'hebr' }, // Hebrew
  { min: 0x0600, max: 0x06ff, tag: 'arab' }, // Arabic
  { min: 0x0750, max: 0x077f, tag: 'arab' }, // Arabic Supplement
  { min: 0xfb50, max: 0xfdff, tag: 'arab' }, // Arabic Presentation Forms-A
  { min: 0xfe70, max: 0xfeff, tag: 'arab' }, // Arabic Presentation Forms-B
  { min: 0x0900, max: 0x097f, tag: 'deva' }, // Devanagari
  { min: 0x0980, max: 0x09ff, tag: 'beng' }, // Bengali
  { min: 0x0a00, max: 0x0a7f, tag: 'guru' }, // Gurmukhi (Punjabi)
  { min: 0x0a80, max: 0x0aff, tag: 'gujr' }, // Gujarati
  { min: 0x0b80, max: 0x0bff, tag: 'taml' }, // Tamil
  { min: 0x0c00, max: 0x0c7f, tag: 'telu' }, // Telugu
  { min: 0x0c80, max: 0x0cff, tag: 'knda' }, // Kannada
  { min: 0x0d00, max: 0x0d7f, tag: 'mlym' }, // Malayalam
  { min: 0x3040, max: 0x30ff, tag: 'kana' }, // Hiragana / Katakana
  { min: 0x1100, max: 0x11ff, tag: 'hang' }, // Hangul Jamo
  { min: 0x3130, max: 0x318f, tag: 'hang' }, // Hangul Compatibility Jamo
  { min: 0xac00, max: 0xd7af, tag: 'hang' }, // Hangul Syllables
  { min: 0x3400, max: 0x4dbf, tag: 'hani' }, // CJK Extension A
  { min: 0x4e00, max: 0x9fff, tag: 'hani' }, // CJK Unified Ideographs
  { min: 0xf900, max: 0xfaff, tag: 'hani' }, // CJK Compatibility Ideographs
  { min: 0x20000, max: 0x2a6df, tag: 'hani' }, // CJK Extension B
];

function inRange(cp: number, r: Range): boolean {
  return cp >= r.min && cp <= r.max;
}

function textHitsRanges(text: string, ranges: Range[]): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    for (const r of ranges) if (inRange(cp, r)) return true;
  }
  return false;
}

export function pageNeedsMathTable(text: string): boolean {
  return textHitsRanges(text, MATH_RANGES);
}

export function pageNeedsColorTables(text: string): boolean {
  return textHitsRanges(text, EMOJI_RANGES);
}

// Returns the OpenType script tags exercised by `text`, plus the safety
// pair `DFLT` (default script) and `latn` (most fonts ship Latin fallback
// even when used for other scripts).
export function scriptsForText(text: string): string[] {
  const tags = new Set<string>(['DFLT', 'latn']);
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    for (const r of SCRIPT_RANGES) {
      if (inRange(cp, r)) {
        tags.add(r.tag);
        break;
      }
    }
  }
  return [...tags];
}
