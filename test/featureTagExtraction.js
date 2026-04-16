const expect = require('unexpected');
const {
  _extractFeatureTagsFromDecl: extractFeatureTagsFromDecl,
  _resolveFeatureSettings: resolveFeatureSettings,
} = require('../lib/collectTextsByPage');

describe('extractFeatureTagsFromDecl', function () {
  describe('font-feature-settings', function () {
    it('should extract quoted 4-letter tags', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-feature-settings',
        '"liga" 1, "dlig" 0'
      );
      expect(tags, 'to equal', new Set(['liga', 'dlig']));
    });

    it('should handle single-quoted tags', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-feature-settings',
        "'smcp' on"
      );
      expect(tags, 'to equal', new Set(['smcp']));
    });

    it('should return empty set for normal', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-feature-settings',
        'normal'
      );
      expect(tags, 'to equal', new Set());
    });

    it('should return empty set for inherit', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-feature-settings',
        'inherit'
      );
      expect(tags, 'to equal', new Set());
    });
  });

  describe('font-variant-ligatures', function () {
    it('should map common-ligatures to liga and clig', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-ligatures',
        'common-ligatures'
      );
      expect(tags, 'to equal', new Set(['liga', 'clig']));
    });

    it('should handle multiple space-separated keywords', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-ligatures',
        'common-ligatures discretionary-ligatures'
      );
      expect(tags, 'to equal', new Set(['liga', 'clig', 'dlig']));
    });

    it('should map historical-ligatures to hlig', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-ligatures',
        'historical-ligatures'
      );
      expect(tags, 'to equal', new Set(['hlig']));
    });
  });

  describe('font-variant-caps', function () {
    it('should map small-caps to smcp', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-caps',
        'small-caps'
      );
      expect(tags, 'to equal', new Set(['smcp']));
    });

    it('should map all-small-caps to smcp and c2sc', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-caps',
        'all-small-caps'
      );
      expect(tags, 'to equal', new Set(['smcp', 'c2sc']));
    });

    it('should map petite-caps to pcap', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-caps',
        'petite-caps'
      );
      expect(tags, 'to equal', new Set(['pcap']));
    });

    it('should map titling-caps to titl', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-caps',
        'titling-caps'
      );
      expect(tags, 'to equal', new Set(['titl']));
    });

    it('should return empty set for normal', function () {
      const tags = extractFeatureTagsFromDecl('font-variant-caps', 'normal');
      expect(tags, 'to equal', new Set());
    });
  });

  describe('font-variant-numeric', function () {
    it('should map tabular-nums to tnum', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-numeric',
        'tabular-nums'
      );
      expect(tags, 'to equal', new Set(['tnum']));
    });

    it('should map multiple numeric features', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-numeric',
        'lining-nums tabular-nums slashed-zero'
      );
      expect(tags, 'to equal', new Set(['lnum', 'tnum', 'zero']));
    });

    it('should map stacked-fractions to afrc', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-numeric',
        'stacked-fractions'
      );
      expect(tags, 'to equal', new Set(['afrc']));
    });
  });

  describe('font-variant-position', function () {
    it('should map sub to subs', function () {
      const tags = extractFeatureTagsFromDecl('font-variant-position', 'sub');
      expect(tags, 'to equal', new Set(['subs']));
    });

    it('should map super to sups without matching sub', function () {
      const tags = extractFeatureTagsFromDecl('font-variant-position', 'super');
      expect(tags, 'to equal', new Set(['sups']));
    });
  });

  describe('font-variant-east-asian', function () {
    it('should map jis78 to jp78', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-east-asian',
        'jis78'
      );
      expect(tags, 'to equal', new Set(['jp78']));
    });

    it('should map ruby to ruby', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-east-asian',
        'ruby'
      );
      expect(tags, 'to equal', new Set(['ruby']));
    });

    it('should handle full-width', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-east-asian',
        'full-width'
      );
      expect(tags, 'to equal', new Set(['fwid']));
    });
  });

  describe('font-variant-alternates', function () {
    it('should map stylistic() to salt', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'stylistic(fancy)'
      );
      expect(tags, 'to equal', new Set(['salt']));
    });

    it('should map swash() to swsh', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'swash(flowing)'
      );
      expect(tags, 'to equal', new Set(['swsh']));
    });

    it('should map historical-forms to hist', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'historical-forms'
      );
      expect(tags, 'to equal', new Set(['hist']));
    });

    it('should map ornaments() to ornm', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'ornaments(bullets)'
      );
      expect(tags, 'to equal', new Set(['ornm']));
    });

    it('should map annotation() to nalt', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'annotation(circled)'
      );
      expect(tags, 'to equal', new Set(['nalt']));
    });

    it('should map styleset() to ss01-ss20', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'styleset(alt-g)'
      );
      expect(tags.size, 'to equal', 20);
      expect(tags.has('ss01'), 'to be true');
      expect(tags.has('ss20'), 'to be true');
    });

    it('should map character-variant() to cv01-cv99', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'character-variant(alt-a)'
      );
      expect(tags.size, 'to equal', 99);
      expect(tags.has('cv01'), 'to be true');
      expect(tags.has('cv99'), 'to be true');
    });

    it('should handle multiple alternates', function () {
      const tags = extractFeatureTagsFromDecl(
        'font-variant-alternates',
        'historical-forms stylistic(fancy) swash(flowing)'
      );
      expect(tags.has('hist'), 'to be true');
      expect(tags.has('salt'), 'to be true');
      expect(tags.has('swsh'), 'to be true');
    });
  });

  describe('case insensitivity', function () {
    it('should handle uppercase property names', function () {
      const tags = extractFeatureTagsFromDecl(
        'Font-Feature-Settings',
        '"liga" 1'
      );
      expect(tags, 'to equal', new Set(['liga']));
    });
  });
});

describe('resolveFeatureSettings', function () {
  it('should return false when no families have feature settings', function () {
    const result = resolveFeatureSettings(['Open Sans'], null, new Map());
    expect(result.hasFontFeatureSettings, 'to be false');
    expect(result.fontFeatureTags, 'to be undefined');
  });

  it('should return true when all families are flagged', function () {
    const result = resolveFeatureSettings(['Open Sans'], true, new Map());
    expect(result.hasFontFeatureSettings, 'to be true');
  });

  it('should match families from the feature settings set', function () {
    const families = new Set(['open sans']);
    const result = resolveFeatureSettings(['Open Sans'], families, new Map());
    expect(result.hasFontFeatureSettings, 'to be true');
  });

  it('should not match unrelated families', function () {
    const families = new Set(['roboto']);
    const result = resolveFeatureSettings(['Open Sans'], families, new Map());
    expect(result.hasFontFeatureSettings, 'to be false');
  });

  it('should collect tags from featureTagsByFamily', function () {
    const tagMap = new Map([['open sans', new Set(['liga', 'smcp'])]]);
    const result = resolveFeatureSettings(['Open Sans'], true, tagMap);
    expect(result.hasFontFeatureSettings, 'to be true');
    expect(
      new Set(result.fontFeatureTags),
      'to equal',
      new Set(['liga', 'smcp'])
    );
  });

  it('should merge global tags with family-specific tags', function () {
    const tagMap = new Map([
      ['*', new Set(['liga'])],
      ['open sans', new Set(['smcp'])],
    ]);
    const result = resolveFeatureSettings(['Open Sans'], true, tagMap);
    expect(
      new Set(result.fontFeatureTags),
      'to equal',
      new Set(['liga', 'smcp'])
    );
  });

  it('should return undefined fontFeatureTags when no tags found', function () {
    const result = resolveFeatureSettings(['Open Sans'], true, new Map());
    expect(result.hasFontFeatureSettings, 'to be true');
    expect(result.fontFeatureTags, 'to be undefined');
  });
});
