const expect = require('unexpected');
const {
  extractFeatureTagsFromDecl,
  ruleFeatureTags,
  ruleFontFamily,
  recordRuleFeatureTags,
  resolveFeatureSettings,
  addTagsToMapEntry,
  featureSettingsProps,
} = require('../lib/fontFeatureHelpers');

describe('fontFeatureHelpers', function () {
  describe('extractFeatureTagsFromDecl', function () {
    it('should extract tags from font-feature-settings', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-feature-settings',
        '"liga" 1, "dlig" 0'
      );
      expect(tags, 'to satisfy', new Set(['liga', 'dlig']));
    });

    it('should handle single-quoted tags', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-feature-settings',
        "'smcp'"
      );
      expect(tags, 'to satisfy', new Set(['smcp']));
    });

    it('should return empty set for "normal"', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-feature-settings',
        'normal'
      );
      expect(tags.size, 'to equal', 0);
    });

    it('should extract tags from font-variant-ligatures', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-ligatures',
        'common-ligatures discretionary-ligatures'
      );
      expect(tags, 'to satisfy', new Set(['liga', 'clig', 'dlig']));
    });

    it('should extract tags from font-variant-caps', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-caps',
        'small-caps'
      );
      expect(tags, 'to satisfy', new Set(['smcp']));
    });

    it('should extract tags from font-variant-numeric', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-numeric',
        'lining-nums tabular-nums'
      );
      expect(tags, 'to satisfy', new Set(['lnum', 'tnum']));
    });

    it('should extract tags from font-variant-position', function () {
      const tags = extractFeatureTagsFromDecl('font-variant-position', 'sub');
      expect(tags, 'to satisfy', new Set(['subs']));
    });

    it('should extract tags from font-variant-east-asian', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-east-asian',
        'jis78 full-width'
      );
      expect(tags, 'to satisfy', new Set(['jp78', 'fwid']));
    });

    it('should handle font-variant-alternates with historical-forms', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'historical-forms'
      );
      expect(tags, 'to satisfy', new Set(['hist']));
    });

    it('should handle font-variant-alternates with stylistic()', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'stylistic(my-style)'
      );
      expect(tags, 'to satisfy', new Set(['salt']));
    });

    it('should handle font-variant-alternates with styleset()', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'styleset(fancy)'
      );
      expect(tags.has('ss01'), 'to be true');
      expect(tags.has('ss20'), 'to be true');
      expect(tags.size, 'to equal', 20);
    });

    it('should handle font-variant-alternates with character-variant()', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'character-variant(alt)'
      );
      expect(tags.has('cv01'), 'to be true');
      expect(tags.has('cv99'), 'to be true');
      expect(tags.size, 'to equal', 99);
    });

    it('should return empty set for an unrecognized property', function () {
      const tags = extractFeatureTagsFromDecl('color', 'red');
      expect(tags.size, 'to equal', 0);
    });

    it('should be case-insensitive on the property name', function () {
      const tags = extractFeatureTagsFromDecl(
        'Font-Feature-Settings',
        '"liga"'
      );
      expect(tags, 'to satisfy', new Set(['liga']));
    });
  });

  describe('ruleFeatureTags', function () {
    it('should return null when no feature declarations exist', function () {
      const rule = { nodes: [{ type: 'decl', prop: 'color', value: 'red' }] };
      expect(ruleFeatureTags(rule), 'to be null');
    });

    it('should collect tags from feature declarations', function () {
      const rule = {
        nodes: [
          {
            type: 'decl',
            prop: 'font-feature-settings',
            value: '"liga" 1',
          },
          { type: 'decl', prop: 'font-variant-caps', value: 'small-caps' },
        ],
      };
      const tags = ruleFeatureTags(rule);
      expect(tags, 'to satisfy', new Set(['liga', 'smcp']));
    });

    it('should ignore non-decl nodes', function () {
      const rule = {
        nodes: [
          { type: 'comment', prop: 'font-feature-settings', value: '"liga"' },
        ],
      };
      expect(ruleFeatureTags(rule), 'to be null');
    });
  });

  describe('ruleFontFamily', function () {
    it('should return null when no font-family declaration exists', function () {
      const rule = { nodes: [{ type: 'decl', prop: 'color', value: 'red' }] };
      expect(ruleFontFamily(rule), 'to be null');
    });

    it('should return the last font-family value', function () {
      const rule = {
        nodes: [
          { type: 'decl', prop: 'font-family', value: 'Arial' },
          { type: 'decl', prop: 'font-family', value: 'Roboto, sans-serif' },
        ],
      };
      expect(ruleFontFamily(rule), 'to equal', 'Roboto, sans-serif');
    });
  });

  describe('addTagsToMapEntry', function () {
    it('should create a new set for a new key', function () {
      const map = new Map();
      addTagsToMapEntry(map, 'test', ['a', 'b']);
      expect(map.get('test'), 'to satisfy', new Set(['a', 'b']));
    });

    it('should add to an existing set', function () {
      const map = new Map([['test', new Set(['a'])]]);
      addTagsToMapEntry(map, 'test', ['b', 'c']);
      expect(map.get('test'), 'to satisfy', new Set(['a', 'b', 'c']));
    });
  });

  describe('recordRuleFeatureTags', function () {
    it('should return null for rules without feature declarations', function () {
      const rule = { nodes: [{ type: 'decl', prop: 'color', value: 'red' }] };
      expect(recordRuleFeatureTags(rule, null), 'to be null');
    });

    it('should return true when feature settings have no font-family', function () {
      const rule = {
        nodes: [
          { type: 'decl', prop: 'font-feature-settings', value: '"liga"' },
        ],
      };
      const result = recordRuleFeatureTags(rule, null);
      expect(result, 'to be true');
    });

    it('should return family names when font-family is present', function () {
      const rule = {
        nodes: [
          { type: 'decl', prop: 'font-family', value: 'Roboto, Arial' },
          { type: 'decl', prop: 'font-variant-caps', value: 'small-caps' },
        ],
      };
      const map = new Map();
      const result = recordRuleFeatureTags(rule, map);
      expect(result, 'to be an', 'array');
      expect(map.get('roboto'), 'to satisfy', new Set(['smcp']));
      expect(map.get('arial'), 'to satisfy', new Set(['smcp']));
    });

    it('should record to wildcard * when no font-family present', function () {
      const rule = {
        nodes: [
          { type: 'decl', prop: 'font-feature-settings', value: '"dlig"' },
        ],
      };
      const map = new Map();
      recordRuleFeatureTags(rule, map);
      expect(map.get('*'), 'to satisfy', new Set(['dlig']));
    });

    it('should return families but skip recording when map is null', function () {
      const rule = {
        nodes: [
          { type: 'decl', prop: 'font-family', value: 'Roboto' },
          { type: 'decl', prop: 'font-variant-caps', value: 'small-caps' },
        ],
      };
      const result = recordRuleFeatureTags(rule, null);
      expect(result, 'to be an', 'array');
    });
  });

  describe('resolveFeatureSettings', function () {
    it('should return false when no feature settings detected', function () {
      const result = resolveFeatureSettings(['Roboto'], null, null);
      expect(result, 'to equal', { hasFontFeatureSettings: false });
    });

    it('should return true for all families when fontFamiliesWithFeatureSettings is true', function () {
      const result = resolveFeatureSettings(['Roboto'], true, null);
      expect(result.hasFontFeatureSettings, 'to be true');
    });

    it('should return true when family is in the set', function () {
      const result = resolveFeatureSettings(
        ['Roboto'],
        new Set(['roboto']),
        null
      );
      expect(result.hasFontFeatureSettings, 'to be true');
    });

    it('should return false when family is not in the set', function () {
      const result = resolveFeatureSettings(
        ['Arial'],
        new Set(['roboto']),
        null
      );
      expect(result.hasFontFeatureSettings, 'to be false');
    });

    it('should collect tags from featureTagsByFamily including global wildcard', function () {
      const featureTagsByFamily = new Map([
        ['*', new Set(['liga'])],
        ['roboto', new Set(['smcp', 'dlig'])],
      ]);
      const result = resolveFeatureSettings(
        ['Roboto'],
        true,
        featureTagsByFamily
      );
      expect(result.hasFontFeatureSettings, 'to be true');
      expect(
        new Set(result.fontFeatureTags),
        'to satisfy',
        new Set(['liga', 'smcp', 'dlig'])
      );
    });

    it('should return undefined fontFeatureTags when no tags found', function () {
      const featureTagsByFamily = new Map();
      const result = resolveFeatureSettings(
        ['Roboto'],
        true,
        featureTagsByFamily
      );
      expect(result.fontFeatureTags, 'to be undefined');
    });
  });

  describe('featureSettingsProps', function () {
    it('should contain all known feature-related CSS properties', function () {
      expect(featureSettingsProps.has('font-feature-settings'), 'to be true');
      expect(featureSettingsProps.has('font-variant-caps'), 'to be true');
      expect(featureSettingsProps.has('font-variant-ligatures'), 'to be true');
      expect(featureSettingsProps.has('font-variant-numeric'), 'to be true');
      expect(featureSettingsProps.has('font-variant-position'), 'to be true');
      expect(featureSettingsProps.has('font-variant-east-asian'), 'to be true');
      expect(featureSettingsProps.has('font-variant-alternates'), 'to be true');
    });
  });
});
