const neostandard = require('neostandard');
const eslintConfigPrettier = require('eslint-config-prettier');
const mochaPlugin = require('eslint-plugin-mocha');

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
      globals: {
        mocha: true,
      },
    },
  },
  {
    ignores: [
      'testdata/',
      'node_modules/',
      'coverage/',
      'vendor/',
      'puppeteer-browsers/',
    ],
  },
];
