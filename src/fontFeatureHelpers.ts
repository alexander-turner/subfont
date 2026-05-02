import * as cssFontParser from 'css-font-parser';

export const featureSettingsProps = new Set<string>([
  'font-feature-settings',
  'font-variant-alternates',
  'font-variant-caps',
  'font-variant-east-asian',
  'font-variant-ligatures',
  'font-variant-numeric',
  'font-variant-position',
]);

// Map font-variant-* CSS values to their corresponding OpenType feature tags.
export const fontVariantToOTTags: Record<string, Record<string, string[]>> = {
  'font-variant-ligatures': {
    'common-ligatures': ['liga', 'clig'],
    'no-common-ligatures': ['liga', 'clig'],
    'discretionary-ligatures': ['dlig'],
    'no-discretionary-ligatures': ['dlig'],
    'historical-ligatures': ['hlig'],
    'no-historical-ligatures': ['hlig'],
    contextual: ['calt'],
    'no-contextual': ['calt'],
  },
  'font-variant-caps': {
    'small-caps': ['smcp'],
    'all-small-caps': ['smcp', 'c2sc'],
    'petite-caps': ['pcap'],
    'all-petite-caps': ['pcap', 'c2pc'],
    unicase: ['unic'],
    'titling-caps': ['titl'],
  },
  'font-variant-numeric': {
    'lining-nums': ['lnum'],
    'oldstyle-nums': ['onum'],
    'proportional-nums': ['pnum'],
    'tabular-nums': ['tnum'],
    'diagonal-fractions': ['frac'],
    'stacked-fractions': ['afrc'],
    ordinal: ['ordn'],
    'slashed-zero': ['zero'],
  },
  'font-variant-position': {
    sub: ['subs'],
    super: ['sups'],
  },
  'font-variant-east-asian': {
    jis78: ['jp78'],
    jis83: ['jp83'],
    jis90: ['jp90'],
    jis04: ['jp04'],
    simplified: ['smpl'],
    traditional: ['trad'],
    'proportional-width': ['pwid'],
    'full-width': ['fwid'],
    ruby: ['ruby'],
  },
};

// Add indexed feature tags (e.g. ss01, cv02) referenced by `styleset(2, 5)` /
// `character-variant(...)`. CSS allows symbolic names (declared via
// `@font-feature-values`) — those are preserved as-is and skipped here, since
// we only know how to resolve numeric indices.
function addIndexedTags(
  value: string,
  callRe: RegExp,
  prefix: 'ss' | 'cv',
  maxIndex: number,
  tags: Set<string>
): void {
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(value)) !== null) {
    const args = m[1];
    let sawNumeric = false;
    for (const arg of args.split(',')) {
      const trimmed = arg.trim();
      if (/^\d+$/.test(trimmed)) {
        const idx = Number(trimmed);
        if (idx >= 1 && idx <= maxIndex) {
          tags.add(`${prefix}${String(idx).padStart(2, '0')}`);
          sawNumeric = true;
        }
      }
    }
    // Symbolic-name argument (or empty) — fall back to including all indices,
    // since resolving the name would require parsing @font-feature-values.
    if (!sawNumeric) {
      for (let i = 1; i <= maxIndex; i++) {
        tags.add(`${prefix}${String(i).padStart(2, '0')}`);
      }
    }
  }
}

// Extract OpenType feature tags referenced by a CSS declaration.
// Sentinel inserted into a feature-tag set when a CSS declaration references
// var() (or any other token we can't statically resolve). Downstream code
// detecting this sentinel must treat the rule's feature contribution as
// "unknown" and avoid using targeted feature retention. The string is more
// than 4 chars so it can't collide with a real OT feature tag.
export const UNRESOLVED_FEATURES_SENTINEL = '<unresolved>';

// Detects the CSS var() function. CSS keywords are case-insensitive, so
// vAr(--x) is just as valid as var(--x).
const VAR_FUNCTION_RE = /\bvar\s*\(/i;

export function extractFeatureTagsFromDecl(
  prop: string,
  value: string
): Set<string> {
  const tags = new Set<string>();
  const propLower = prop.toLowerCase();
  const hasUnresolvedToken = VAR_FUNCTION_RE.test(value);

  if (propLower === 'font-feature-settings') {
    // Parse quoted 4-letter tags: "liga" 1, 'dlig', etc.
    const re = /["']([a-zA-Z0-9]{4})["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
      tags.add(m[1]);
    }
    if (hasUnresolvedToken) tags.add(UNRESOLVED_FEATURES_SENTINEL);
    return tags;
  }

  if (propLower === 'font-variant-alternates') {
    const v = value.toLowerCase();
    if (v.includes('historical-forms')) tags.add('hist');
    if (/stylistic\s*\(/.test(v)) tags.add('salt');
    if (/swash\s*\(/.test(v)) tags.add('swsh');
    if (/ornaments\s*\(/.test(v)) tags.add('ornm');
    if (/annotation\s*\(/.test(v)) tags.add('nalt');
    addIndexedTags(v, /styleset\s*\(([^)]*)\)/g, 'ss', 20, tags);
    addIndexedTags(v, /character-variant\s*\(([^)]*)\)/g, 'cv', 99, tags);
    if (hasUnresolvedToken) tags.add(UNRESOLVED_FEATURES_SENTINEL);
    return tags;
  }

  const mapping = fontVariantToOTTags[propLower];
  if (mapping) {
    // Split into tokens for exact keyword matching — substring matching
    // would falsely trigger e.g. "sub" inside "super".
    const tokens = new Set(value.toLowerCase().split(/\s+/));
    for (const [keyword, otTags] of Object.entries(mapping)) {
      if (tokens.has(keyword)) {
        for (const t of otTags) tags.add(t);
      }
    }
    if (hasUnresolvedToken) tags.add(UNRESOLVED_FEATURES_SENTINEL);
  }
  return tags;
}

interface PostCssRuleNode {
  type: string;
  prop: string;
  value: string;
}

interface PostCssRule {
  nodes: PostCssRuleNode[];
}

// Collect feature tags from all feature-related declarations in a CSS rule.
export function ruleFeatureTags(rule: PostCssRule): Set<string> | null {
  const tags = new Set<string>();
  let hasFeatureDecl = false;
  for (const node of rule.nodes) {
    if (
      node.type === 'decl' &&
      featureSettingsProps.has(node.prop.toLowerCase())
    ) {
      hasFeatureDecl = true;
      for (const t of extractFeatureTagsFromDecl(node.prop, node.value)) {
        tags.add(t);
      }
    }
  }
  return hasFeatureDecl ? tags : null;
}

export function ruleFontFamily(rule: PostCssRule): string | null {
  for (let i = rule.nodes.length - 1; i >= 0; i--) {
    const node = rule.nodes[i];
    if (node.type === 'decl' && node.prop.toLowerCase() === 'font-family') {
      return node.value;
    }
  }
  return null;
}

// Add all items from `tags` into the Set stored at `key` in `map`,
// creating the Set if it doesn't exist yet.
export function addTagsToMapEntry<K>(
  map: Map<K, Set<string>>,
  key: K,
  tags: Iterable<string>
): void {
  let s = map.get(key);
  if (!s) {
    s = new Set();
    map.set(key, s);
  }
  for (const t of tags) s.add(t);
}

// Record the OT tags from a single CSS rule into featureTagsByFamily,
// keyed by font-family (or '*' when no font-family is specified).
export function recordRuleFeatureTags(
  rule: PostCssRule,
  featureTagsByFamily: Map<string, Set<string>> | null | undefined
): true | string[] | null {
  const tags = ruleFeatureTags(rule);
  if (!tags) return null;

  const fontFamily = ruleFontFamily(rule);
  if (!fontFamily) {
    if (featureTagsByFamily) addTagsToMapEntry(featureTagsByFamily, '*', tags);
    return true; // signals "all families"
  }

  const families = cssFontParser.parseFontFamily(fontFamily);
  if (featureTagsByFamily) {
    for (const family of families) {
      addTagsToMapEntry(featureTagsByFamily, family.toLowerCase(), tags);
    }
  }
  return families;
}

interface StylesheetEntry {
  asset?: { parseTree?: { walkRules?(cb: (rule: PostCssRule) => void): void } };
}

// Determine which font-families use font-feature-settings or font-variant-*.
// Returns null (none detected), a Set of lowercase family names, or true (all).
// Also populates featureTagsByFamily with the OT tags per family (lowercase).
export function findFontFamiliesWithFeatureSettings(
  stylesheetsWithPredicates: StylesheetEntry[],
  featureTagsByFamily: Map<string, Set<string>> | null | undefined
): true | Set<string> | null {
  let result: true | Set<string> | null = null;
  for (const { asset } of stylesheetsWithPredicates) {
    if (!asset?.parseTree?.walkRules) continue;
    asset.parseTree.walkRules((rule) => {
      if (result === true && !featureTagsByFamily) return;

      const recorded = recordRuleFeatureTags(rule, featureTagsByFamily);
      if (!recorded) return;

      if (recorded === true) {
        result = true;
      } else if (result !== true) {
        if (!result) result = new Set<string>();
        for (const family of recorded) {
          result.add(family.toLowerCase());
        }
      }
    });
    if (result === true && !featureTagsByFamily) break;
  }
  return result;
}

// Determine whether a template's font families use feature settings, and
// collect the corresponding OT feature tags from featureTagsByFamily.
export function resolveFeatureSettings(
  fontFamilies: Iterable<string>,
  fontFamiliesWithFeatureSettings: true | Set<string> | null | undefined,
  featureTagsByFamily: Map<string, Set<string>> | null | undefined
): { hasFontFeatureSettings: boolean; fontFeatureTags?: string[] } {
  let hasFontFeatureSettings = false;
  if (fontFamiliesWithFeatureSettings === true) {
    hasFontFeatureSettings = true;
  } else if (fontFamiliesWithFeatureSettings instanceof Set) {
    for (const f of fontFamilies) {
      if (fontFamiliesWithFeatureSettings.has(f.toLowerCase())) {
        hasFontFeatureSettings = true;
        break;
      }
    }
  }

  let fontFeatureTags: string[] | undefined;
  if (hasFontFeatureSettings && featureTagsByFamily) {
    const tags = new Set<string>();
    const globalTags = featureTagsByFamily.get('*');
    if (globalTags) {
      for (const t of globalTags) tags.add(t);
    }
    for (const f of fontFamilies) {
      const familyTags = featureTagsByFamily.get(f.toLowerCase());
      if (familyTags) {
        for (const t of familyTags) tags.add(t);
      }
    }
    // If any contributing rule had unresolved tokens (e.g. var()), we don't
    // know the full set — leave fontFeatureTags undefined so callers fall
    // back to retain-all-features instead of dropping features silently.
    if (tags.has(UNRESOLVED_FEATURES_SENTINEL)) {
      tags.delete(UNRESOLVED_FEATURES_SENTINEL);
    } else if (tags.size > 0) {
      fontFeatureTags = [...tags];
    }
  }

  return { hasFontFeatureSettings, fontFeatureTags };
}
