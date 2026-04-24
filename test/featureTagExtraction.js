const expect = require('unexpected');
const postcss = require('postcss');
const {
  extractFeatureTagsFromDecl: extract,
  resolveFeatureSettings,
  findFontFamiliesWithFeatureSettings,
} = require('../lib/fontFeatureHelpers');

describe('extractFeatureTagsFromDecl', function () {
  describe('font-feature-settings', function () {
    for (const [value, expected] of [
      ['"liga" 1, "dlig" 0', ['liga', 'dlig']],
      ["'smcp' on", ['smcp']],
      ['normal', []],
      ['inherit', []],
    ]) {
      it(`should extract ${expected.length ? expected.join(', ') : 'nothing'} from "${value}"`, function () {
        expect(
          extract('font-feature-settings', value),
          'to equal',
          new Set(expected)
        );
      });
    }

    it('should handle uppercase property names', function () {
      expect(
        extract('Font-Feature-Settings', '"liga" 1'),
        'to equal',
        new Set(['liga'])
      );
    });
  });

  describe('font-variant-ligatures', function () {
    for (const [value, expected] of [
      ['common-ligatures', ['liga', 'clig']],
      ['common-ligatures discretionary-ligatures', ['liga', 'clig', 'dlig']],
      ['historical-ligatures', ['hlig']],
    ]) {
      it(`should map "${value}"`, function () {
        expect(
          extract('font-variant-ligatures', value),
          'to equal',
          new Set(expected)
        );
      });
    }
  });

  describe('font-variant-caps', function () {
    for (const [value, expected] of [
      ['small-caps', ['smcp']],
      ['all-small-caps', ['smcp', 'c2sc']],
      ['petite-caps', ['pcap']],
      ['titling-caps', ['titl']],
      ['normal', []],
    ]) {
      it(`should map "${value}"`, function () {
        expect(
          extract('font-variant-caps', value),
          'to equal',
          new Set(expected)
        );
      });
    }
  });

  describe('font-variant-numeric', function () {
    for (const [value, expected] of [
      ['tabular-nums', ['tnum']],
      ['lining-nums tabular-nums slashed-zero', ['lnum', 'tnum', 'zero']],
      ['stacked-fractions', ['afrc']],
    ]) {
      it(`should map "${value}"`, function () {
        expect(
          extract('font-variant-numeric', value),
          'to equal',
          new Set(expected)
        );
      });
    }
  });

  describe('font-variant-position', function () {
    it('should map sub to subs', function () {
      expect(
        extract('font-variant-position', 'sub'),
        'to equal',
        new Set(['subs'])
      );
    });

    it('should map super to sups without matching sub', function () {
      expect(
        extract('font-variant-position', 'super'),
        'to equal',
        new Set(['sups'])
      );
    });
  });

  describe('font-variant-east-asian', function () {
    for (const [value, expected] of [
      ['jis78', ['jp78']],
      ['ruby', ['ruby']],
      ['full-width', ['fwid']],
    ]) {
      it(`should map "${value}"`, function () {
        expect(
          extract('font-variant-east-asian', value),
          'to equal',
          new Set(expected)
        );
      });
    }
  });

  describe('font-variant-alternates', function () {
    for (const [value, expected] of [
      ['stylistic(fancy)', ['salt']],
      ['swash(flowing)', ['swsh']],
      ['historical-forms', ['hist']],
      ['ornaments(bullets)', ['ornm']],
      ['annotation(circled)', ['nalt']],
    ]) {
      it(`should map "${value}"`, function () {
        expect(
          extract('font-variant-alternates', value),
          'to equal',
          new Set(expected)
        );
      });
    }

    it('should map styleset() to ss01-ss20', function () {
      const tags = extract('font-variant-alternates', 'styleset(alt-g)');
      expect(tags.size, 'to equal', 20);
      expect(tags.has('ss01'), 'to be true');
      expect(tags.has('ss20'), 'to be true');
    });

    it('should map character-variant() to cv01-cv99', function () {
      const tags = extract('font-variant-alternates', 'character-variant(a)');
      expect(tags.size, 'to equal', 99);
      expect(tags.has('cv01'), 'to be true');
      expect(tags.has('cv99'), 'to be true');
    });

    it('should handle multiple alternates', function () {
      const tags = extract(
        'font-variant-alternates',
        'historical-forms stylistic(fancy) swash(flowing)'
      );
      for (const t of ['hist', 'salt', 'swsh']) {
        expect(tags.has(t), 'to be true');
      }
    });
  });
});

describe('resolveFeatureSettings', function () {
  for (const [desc, families, ffsArg, mapEntries, hasFFS, hasTags] of [
    ['null ffs', ['Open Sans'], null, [], false, false],
    ['true ffs', ['Open Sans'], true, [], true, false],
    ['matching family', ['Open Sans'], new Set(['open sans']), [], true, false],
    [
      'non-matching family',
      ['Open Sans'],
      new Set(['roboto']),
      [],
      false,
      false,
    ],
    [
      'family-specific tags',
      ['Open Sans'],
      true,
      [['open sans', new Set(['liga', 'smcp'])]],
      true,
      true,
    ],
    [
      'global + family tags merged',
      ['Open Sans'],
      true,
      [
        ['*', new Set(['liga'])],
        ['open sans', new Set(['smcp'])],
      ],
      true,
      true,
    ],
  ]) {
    it(`should handle ${desc}`, function () {
      const result = resolveFeatureSettings(
        families,
        ffsArg,
        new Map(mapEntries)
      );
      expect(result.hasFontFeatureSettings, 'to be', hasFFS);
      if (hasTags) {
        expect(result.fontFeatureTags, 'to be an array');
      } else {
        expect(result.fontFeatureTags, 'to be undefined');
      }
    });
  }

  it('should merge global and family tags', function () {
    const result = resolveFeatureSettings(
      ['Open Sans'],
      true,
      new Map([
        ['*', new Set(['liga'])],
        ['open sans', new Set(['smcp'])],
      ])
    );
    expect(
      new Set(result.fontFeatureTags),
      'to equal',
      new Set(['liga', 'smcp'])
    );
  });
});

describe('findFontFamiliesWithFeatureSettings', function () {
  function makeStylesheets(css) {
    return [{ asset: { parseTree: postcss.parse(css) } }];
  }

  it('should return true when a rule has no font-family', function () {
    const result = findFontFamiliesWithFeatureSettings(
      makeStylesheets('* { font-feature-settings: "liga"; }'),
      new Map()
    );
    expect(result, 'to be true');
  });

  it('should return a Set of lowercase families for scoped rules', function () {
    const result = findFontFamiliesWithFeatureSettings(
      makeStylesheets(
        '.a { font-family: Roboto; font-feature-settings: "smcp"; }'
      ),
      new Map()
    );
    expect(result, 'to equal', new Set(['roboto']));
  });

  it('should stay true when a global rule precedes a family-scoped rule', function () {
    const featureTagsByFamily = new Map();
    const result = findFontFamiliesWithFeatureSettings(
      makeStylesheets(
        '* { font-feature-settings: "liga"; } .a { font-family: Roboto; font-feature-settings: "smcp"; }'
      ),
      featureTagsByFamily
    );
    expect(result, 'to be true');
    expect(featureTagsByFamily.get('*'), 'to equal', new Set(['liga']));
    expect(featureTagsByFamily.get('roboto'), 'to equal', new Set(['smcp']));
  });

  it('should stay true when a family-scoped rule precedes a global rule', function () {
    const featureTagsByFamily = new Map();
    const result = findFontFamiliesWithFeatureSettings(
      makeStylesheets(
        '.a { font-family: Roboto; font-feature-settings: "smcp"; } * { font-feature-settings: "liga"; }'
      ),
      featureTagsByFamily
    );
    expect(result, 'to be true');
    expect(featureTagsByFamily.get('*'), 'to equal', new Set(['liga']));
    expect(featureTagsByFamily.get('roboto'), 'to equal', new Set(['smcp']));
  });
});
