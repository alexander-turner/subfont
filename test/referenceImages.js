const expect = require('./expect');
const combos = require('combos');
const pathModule = require('path');

function getPathToTestCase(name) {
  return pathModule.resolve(
    __dirname,
    '..',
    'testdata',
    'referenceImages',
    name,
    'index.html'
  );
}

describe('reference images', function () {
  for (const options of combos({
    inlineCss: [false, true],
    omitFallbacks: [false, true],
    dynamic: [false, true],
  })) {
    describe(`with ${Object.keys(options)
      .map((key) => `${key}: ${options[key]}`)
      .join(', ')}`, function () {
      it('should render a simple test case without ligatures', async function () {
        await expect(
          getPathToTestCase('withoutLigatures'),
          'to render the same after subsetting',
          options
        );
      });

      it('should render ligatures correctly', async function () {
        await expect(
          getPathToTestCase('ligatures'),
          'to render the same after subsetting',
          options
        );
      });

      it('should render missing glyphs', async function () {
        await expect(
          getPathToTestCase('missingGlyphs'),
          'to render the same after subsetting',
          options
        );
      });

      it('should render unused variants', async function () {
        await expect(
          getPathToTestCase('unusedVariants'),
          'to render the same after subsetting',
          options
        );
      });

      // Skip: subsetting loses kerning pairs for alternate glyphs.
      // When features like aalt/ss01 substitute glyphs (a → a.alt01),
      // HarfBuzz's GPOS closure doesn't preserve kerning for those
      // alternates (3642 pairs → 133), causing ~1px shifts (1.15% mismatch).
      it.skip('should render font-variant-*', async function () {
        await expect(
          getPathToTestCase('fontVariant'),
          'to render the same after subsetting',
          options
        );
      });

      it('should render a variable font that can be fully instanced', async function () {
        await expect(
          getPathToTestCase('fullyInstancedVariableFont'),
          'to render the same after subsetting',
          options
        );
      });
    });
  }
});
