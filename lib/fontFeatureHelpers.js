const cssFontParser = require('css-font-parser');

const featureSettingsProps = new Set([
  'font-feature-settings',
  'font-variant-alternates',
  'font-variant-caps',
  'font-variant-east-asian',
  'font-variant-ligatures',
  'font-variant-numeric',
  'font-variant-position',
]);

// Map font-variant-* CSS values to their corresponding OpenType feature tags.
const fontVariantToOTTags = {
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

// Extract OpenType feature tags referenced by a CSS declaration.
function extractFeatureTagsFromDecl(prop, value) {
  const tags = new Set();
  const propLower = prop.toLowerCase();

  if (propLower === 'font-feature-settings') {
    // Parse quoted 4-letter tags: "liga" 1, 'dlig', etc.
    const re = /["']([a-zA-Z0-9]{4})["']/g;
    let m;
    while ((m = re.exec(value)) !== null) {
      tags.add(m[1]);
    }
    return tags;
  }

  if (propLower === 'font-variant-alternates') {
    const v = value.toLowerCase();
    if (v.includes('historical-forms')) tags.add('hist');
    if (/stylistic\s*\(/.test(v)) tags.add('salt');
    if (/swash\s*\(/.test(v)) tags.add('swsh');
    if (/ornaments\s*\(/.test(v)) tags.add('ornm');
    if (/annotation\s*\(/.test(v)) tags.add('nalt');
    if (/styleset\s*\(/.test(v)) {
      for (let i = 1; i <= 20; i++) {
        tags.add(`ss${String(i).padStart(2, '0')}`);
      }
    }
    if (/character-variant\s*\(/.test(v)) {
      for (let i = 1; i <= 99; i++) {
        tags.add(`cv${String(i).padStart(2, '0')}`);
      }
    }
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
  }
  return tags;
}

// Collect feature tags from all feature-related declarations in a CSS rule.
function ruleFeatureTags(rule) {
  const tags = new Set();
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

function ruleFontFamily(rule) {
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
function addTagsToMapEntry(map, key, tags) {
  let s = map.get(key);
  if (!s) {
    s = new Set();
    map.set(key, s);
  }
  for (const t of tags) s.add(t);
}

// Record the OT tags from a single CSS rule into featureTagsByFamily,
// keyed by font-family (or '*' when no font-family is specified).
function recordRuleFeatureTags(rule, featureTagsByFamily) {
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

// Determine which font-families use font-feature-settings or font-variant-*.
// Returns null (none detected), a Set of lowercase family names, or true (all).
// Also populates featureTagsByFamily with the OT tags per family (lowercase).
function findFontFamiliesWithFeatureSettings(
  stylesheetsWithPredicates,
  featureTagsByFamily
) {
  let result = null;
  for (const { asset } of stylesheetsWithPredicates) {
    if (!asset || !asset.parseTree) continue;
    asset.parseTree.walkRules((rule) => {
      if (result === true && !featureTagsByFamily) return;

      const recorded = recordRuleFeatureTags(rule, featureTagsByFamily);
      if (!recorded) return;

      if (recorded === true) {
        result = true;
      } else if (result !== true) {
        if (!result) result = new Set();
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
function resolveFeatureSettings(
  fontFamilies,
  fontFamiliesWithFeatureSettings,
  featureTagsByFamily
) {
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

  let fontFeatureTags;
  if (hasFontFeatureSettings && featureTagsByFamily) {
    const tags = new Set();
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
    if (tags.size > 0) {
      fontFeatureTags = [...tags];
    }
  }

  return { hasFontFeatureSettings, fontFeatureTags };
}

module.exports = {
  featureSettingsProps,
  fontVariantToOTTags,
  extractFeatureTagsFromDecl,
  ruleFeatureTags,
  ruleFontFamily,
  addTagsToMapEntry,
  recordRuleFeatureTags,
  findFontFamiliesWithFeatureSettings,
  resolveFeatureSettings,
};
