const neostandard = require('neostandard');
const eslintConfigPrettier = require('eslint-config-prettier');
const mochaPlugin = require('eslint-plugin-mocha');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = [
  ...neostandard(),
  eslintConfigPrettier,
  {
    plugins: {
      mocha: mochaPlugin,
    },
    rules: {
      'prefer-template': 'error',
      'mocha/no-exclusive-tests': 'error',
      'mocha/no-nested-tests': 'error',
      'mocha/no-identical-title': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: globals.mocha,
    },
  },
  // TypeScript source: forbid explicit `any`. Untyped third-party shims live
  // in src/types/ and src/*.d.ts where loose `any` is unavoidable; those
  // files are exempted below.
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // TypeScript's own checker handles undefined identifiers, including
      // built-in globals like Console / NodeJS that ESLint's no-undef
      // doesn't recognise.
      'no-undef': 'off',
    },
  },
  {
    // .d.ts ambient shims for untyped dependencies — `any` is the right
    // tool here; tightening would require typing the deps themselves.
    files: ['src/**/*.d.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-undef': 'off',
    },
  },
  {
    ignores: [
      'testdata/',
      'node_modules/',
      'coverage/',
      'vendor/',
      'puppeteer-browsers/',
      // Compiled TypeScript output — source lives under src/.
      'lib/cli.js',
      'lib/subfont.js',
      'lib/subsetFonts.js',
      'lib/FontTracerPool.js',
      'lib/subsetFontWithGlyphs.js',
      'lib/subsetGeneration.js',
    ],
  },
];
