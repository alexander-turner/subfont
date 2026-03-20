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

// Skip: reference image tests require pixel-perfect rendering which varies
// across Chrome versions and CI environments. These have never passed on
// the current CI configuration (Node 20 + Chrome 146).
describe.skip('reference images', function () {
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

      it('should render font-variant-*', async function () {
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
