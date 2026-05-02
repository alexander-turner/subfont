// Map codepoints to OpenType script tags using a small hand-rolled range
// table. This is intentionally not exhaustive — it covers the scripts that
// actually show up on the web, which is what HB_SUBSET_SETS_LAYOUT_SCRIPT_TAG
// needs to retain shaping for. Codepoints outside any range are skipped
// (returns undefined); callers always retain DFLT and latn so unmapped
// codepoints don't strip shaping the page might still rely on.

interface ScriptRange {
  min: number;
  max: number;
  tag: string;
}

// Order matters only for overlapping ranges, of which there are none here.
const SCRIPT_RANGES: ScriptRange[] = [
  // Latin: basic + supplements + extended
  { min: 0x0000, max: 0x024f, tag: 'latn' },
  { min: 0x1e00, max: 0x1eff, tag: 'latn' }, // Latin Extended Additional
  { min: 0x2c60, max: 0x2c7f, tag: 'latn' }, // Latin Extended-C
  { min: 0xa720, max: 0xa7ff, tag: 'latn' }, // Latin Extended-D

  // Cyrillic
  { min: 0x0400, max: 0x052f, tag: 'cyrl' },
  { min: 0x2de0, max: 0x2dff, tag: 'cyrl' }, // Cyrillic Extended-A
  { min: 0xa640, max: 0xa69f, tag: 'cyrl' }, // Cyrillic Extended-B

  // Greek and Coptic
  { min: 0x0370, max: 0x03ff, tag: 'grek' },
  { min: 0x1f00, max: 0x1fff, tag: 'grek' }, // Greek Extended

  // Arabic
  { min: 0x0600, max: 0x06ff, tag: 'arab' },
  { min: 0x0750, max: 0x077f, tag: 'arab' }, // Arabic Supplement
  { min: 0xfb50, max: 0xfdff, tag: 'arab' }, // Arabic Presentation Forms-A
  { min: 0xfe70, max: 0xfeff, tag: 'arab' }, // Arabic Presentation Forms-B

  // Hebrew
  { min: 0x0590, max: 0x05ff, tag: 'hebr' },

  // Devanagari
  { min: 0x0900, max: 0x097f, tag: 'deva' },

  // Bengali
  { min: 0x0980, max: 0x09ff, tag: 'beng' },

  // Gurmukhi (Punjabi)
  { min: 0x0a00, max: 0x0a7f, tag: 'guru' },

  // Gujarati
  { min: 0x0a80, max: 0x0aff, tag: 'gujr' },

  // Tamil
  { min: 0x0b80, max: 0x0bff, tag: 'taml' },

  // Telugu
  { min: 0x0c00, max: 0x0c7f, tag: 'telu' },

  // Kannada
  { min: 0x0c80, max: 0x0cff, tag: 'knda' },

  // Malayalam
  { min: 0x0d00, max: 0x0d7f, tag: 'mlym' },

  // Hiragana / Katakana → kana
  { min: 0x3040, max: 0x30ff, tag: 'kana' },

  // Hangul
  { min: 0xac00, max: 0xd7af, tag: 'hang' }, // Hangul Syllables
  { min: 0x1100, max: 0x11ff, tag: 'hang' }, // Hangul Jamo
  { min: 0x3130, max: 0x318f, tag: 'hang' }, // Hangul Compatibility Jamo

  // Han / CJK ideographs
  { min: 0x4e00, max: 0x9fff, tag: 'hani' }, // CJK Unified Ideographs
  { min: 0x3400, max: 0x4dbf, tag: 'hani' }, // CJK Extension A
  { min: 0xf900, max: 0xfaff, tag: 'hani' }, // CJK Compatibility Ideographs
  { min: 0x20000, max: 0x2a6df, tag: 'hani' }, // CJK Extension B
];

function lookupScript(cp: number): string | undefined {
  for (const r of SCRIPT_RANGES) {
    if (cp >= r.min && cp <= r.max) return r.tag;
  }
  return undefined;
}

// Returns the OpenType script tags exercised by the given text, plus the two
// safety tags `DFLT` (default script — always required) and `latn` (most
// fonts have Latin fallback even when used with another script).
export function scriptsForText(text: string): string[] {
  const tags = new Set<string>(['DFLT', 'latn']);
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const tag = lookupScript(cp);
    if (tag) tags.add(tag);
  }
  return [...tags];
}
