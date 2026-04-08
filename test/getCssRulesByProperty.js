const expect = require('unexpected');
const getRules = require('../lib/getCssRulesByProperty');

describe('getCssRulesByProperty', function () {
  it('should throw when not passing an array of properties as first argument', function () {
    expect(getRules, 'to throw', 'properties argument must be an array');
  });

  it('should throw when not passing a cssSource as second argument', function () {
    expect(
      function () {
        getRules(['padding']);
      },
      'to throw',
      'cssSource argument must be a string containing valid CSS'
    );
  });

  it('should throw when not passing a valid CSS document in cssSource', function () {
    expect(function () {
      getRules(['padding'], 'sdkjlasjdlk');
    }, 'to throw');
  });

  it('should return empty arrays when no properties apply', function () {
    expect(
      getRules(['padding'], 'h1 { color: red; }', []),
      'to exhaustively satisfy',
      {
        counterStyles: [],
        keyframes: [],
        padding: [],
      }
    );
  });

  it('should return an array of matching property values', function () {
    expect(
      getRules(['color'], 'h1 { color: red; } h2 { color: blue; }', []),
      'to exhaustively satisfy',
      {
        counterStyles: [],
        keyframes: [],
        color: [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'color',
            value: 'red',
            important: false,
          },
          {
            selector: 'h2',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'color',
            value: 'blue',
            important: false,
          },
        ],
      }
    );
  });

  it('should handle inline styles through `bogusselector`-selector', function () {
    expect(
      getRules(['color'], 'bogusselector { color: red; }', []),
      'to exhaustively satisfy',
      {
        counterStyles: [],
        keyframes: [],
        color: [
          {
            selector: undefined,
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [1, 0, 0, 0],
            prop: 'color',
            value: 'red',
            important: false,
          },
        ],
      }
    );
  });

  describe('overridden values', function () {
    it('should return the last defined value', function () {
      expect(
        getRules(['color'], 'h1 { color: red; color: blue; }', []),
        'to exhaustively satisfy',
        {
          counterStyles: [],
          keyframes: [],
          color: [
            {
              selector: 'h1',
              predicates: {},
              namespaceURI: undefined,
              specificityArray: [0, 0, 0, 1],
              prop: 'color',
              value: 'red',
              important: false,
            },
            {
              selector: 'h1',
              predicates: {},
              namespaceURI: undefined,
              specificityArray: [0, 0, 0, 1],
              prop: 'color',
              value: 'blue',
              important: false,
            },
          ],
        }
      );
    });
  });

  describe('shorthand font-property', function () {
    it('register the longhand value from a valid shorthand', function () {
      const result = getRules(
        ['font-family', 'font-size'],
        'h1 { font: 15px serif; }',
        []
      );

      expect(result, 'to exhaustively satisfy', {
        counterStyles: [],
        keyframes: [],
        'font-family': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
        'font-size': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
      });
    });

    it('should set initial values for requested properties which are not defined in shorthand', function () {
      const result = getRules(
        ['font-family', 'font-size', 'font-style', 'font-weight'],
        'h1 { font: 15px serif; }',
        []
      );

      expect(result, 'to exhaustively satisfy', {
        counterStyles: [],
        keyframes: [],
        'font-family': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
        'font-size': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
        'font-style': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
        'font-weight': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
      });
    });

    it('register the longhand value from a shorthand', function () {
      const result = getRules(
        ['font-family', 'font-size'],
        'h1 { font-size: 10px; font: 15px serif; font-size: 20px }',
        []
      );

      expect(result, 'to exhaustively satisfy', {
        counterStyles: [],
        keyframes: [],
        'font-family': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
        ],
        'font-size': [
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font-size',
            value: '10px',
            important: false,
          },
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font',
            value: '15px serif',
            important: false,
          },
          {
            selector: 'h1',
            predicates: {},
            namespaceURI: undefined,
            specificityArray: [0, 0, 0, 1],
            prop: 'font-size',
            value: '20px',
            important: false,
          },
        ],
      });
    });
  });

  describe('animation shorthand', function () {
    it('should extract animation-name from animation shorthand', function () {
      const result = getRules(
        ['animation-name'],
        'h1 { animation: 2s ease slidein; }',
        []
      );

      expect(result, 'to satisfy', {
        'animation-name': [
          {
            selector: 'h1',
            prop: 'animation-name',
            value: 'slidein',
          },
        ],
      });
    });

    it('should extract animation-timing-function from animation shorthand', function () {
      const result = getRules(
        ['animation-timing-function'],
        'h1 { animation: 2s ease slidein; }',
        []
      );

      expect(result, 'to satisfy', {
        'animation-timing-function': [
          {
            selector: 'h1',
            prop: 'animation-timing-function',
          },
        ],
      });
    });
  });

  describe('transition shorthand', function () {
    it('should extract transition-property from transition shorthand', function () {
      const result = getRules(
        ['transition-property'],
        'h1 { transition: opacity 0.5s; }',
        []
      );

      expect(result, 'to satisfy', {
        'transition-property': [
          {
            selector: 'h1',
            prop: 'transition-property',
            value: 'opacity',
          },
        ],
      });
    });

    it('should extract transition-duration from transition shorthand', function () {
      const result = getRules(
        ['transition-duration'],
        'h1 { transition: opacity 0.5s; }',
        []
      );

      expect(result, 'to satisfy', {
        'transition-duration': [
          {
            selector: 'h1',
            prop: 'transition-duration',
            value: '0.5s',
          },
        ],
      });
    });

    it('should handle multiple transitions separated by commas', function () {
      const result = getRules(
        ['transition-property', 'transition-duration'],
        'h1 { transition: opacity 0.5s, color 1s; }',
        []
      );

      expect(result, 'to satisfy', {
        'transition-property': [
          {
            value: 'opacity, color',
          },
        ],
        'transition-duration': [
          {
            value: '0.5s, 1s',
          },
        ],
      });
    });
  });

  describe('list-style shorthand', function () {
    it('should extract list-style-type keyword from list-style shorthand', function () {
      const result = getRules(
        ['list-style-type'],
        'ul { list-style: square; }',
        []
      );

      expect(result, 'to satisfy', {
        'list-style-type': [
          {
            selector: 'ul',
            prop: 'list-style-type',
            value: 'square',
          },
        ],
      });
    });

    it('should extract quoted string from list-style shorthand', function () {
      const result = getRules(
        ['list-style-type'],
        'ul { list-style: ">>"; }',
        []
      );

      expect(result, 'to satisfy', {
        'list-style-type': [
          {
            value: '>>',
          },
        ],
      });
    });

    it('should return nothing when list-style-type is not requested', function () {
      const result = getRules(['color'], 'ul { list-style: square; }', []);

      expect(result, 'to satisfy', {
        color: [],
      });
    });
  });

  describe('@counter-style', function () {
    it('should collect counter-style rules', function () {
      const result = getRules(
        ['color'],
        '@counter-style thumbs { system: cyclic; symbols: "\\1F44D"; suffix: " "; } h1 { color: red; }',
        []
      );

      expect(result, 'to satisfy', {
        counterStyles: [
          {
            name: 'thumbs',
            props: {
              system: 'cyclic',
              symbols: '"\\1F44D"',
              suffix: '" "',
            },
          },
        ],
      });
    });
  });

  describe('@keyframes', function () {
    it('should collect keyframes rules and not recurse into them', function () {
      const result = getRules(
        ['color'],
        '@keyframes slidein { from { color: red; } to { color: blue; } } h1 { color: green; }',
        []
      );

      expect(result, 'to satisfy', {
        keyframes: [
          {
            name: 'slidein',
          },
        ],
        color: [
          {
            selector: 'h1',
            value: 'green',
          },
        ],
      });
      // color declarations inside @keyframes should NOT appear in rulesByProperty
      expect(result.color, 'to have length', 1);
    });
  });

  describe('@media and @supports predicates', function () {
    it('should propagate @media predicates to contained rules', function () {
      const result = getRules(
        ['color'],
        '@media (min-width: 768px) { h1 { color: red; } }',
        []
      );

      expect(result, 'to satisfy', {
        color: [
          {
            selector: 'h1',
            value: 'red',
            predicates: { 'mediaQuery:(min-width: 768px)': true },
          },
        ],
      });
    });

    it('should propagate @supports predicates to contained rules', function () {
      const result = getRules(
        ['color'],
        '@supports (display: grid) { h1 { color: red; } }',
        []
      );

      expect(result, 'to satisfy', {
        color: [
          {
            selector: 'h1',
            value: 'red',
            predicates: { 'supportsQuery:(display: grid)': true },
          },
        ],
      });
    });

    it('should merge existing predicates with at-rule predicates', function () {
      const result = getRules(
        ['color'],
        '@media print { h1 { color: black; } }',
        { 'mediaQuery:screen': true }
      );

      expect(result, 'to satisfy', {
        color: [
          {
            predicates: {
              'mediaQuery:screen': true,
              'mediaQuery:print': true,
            },
          },
        ],
      });
    });
  });

  describe('unwrapNamespace error', function () {
    it('should throw for namespace that is not a string or url()', function () {
      expect(
        function () {
          getRules(['color'], '@namespace foo; h1 { color: red; }', []);
        },
        'to throw',
        /Cannot parse CSS namespace/
      );
    });
  });

  describe('with a different default namespace', function () {
    describe('given as a quoted string', function () {
      it('should annotate the style rules with the default namespace', function () {
        const result = getRules(
          ['font-size'],
          '@namespace "foo"; h1 { font-size: 20px }',
          []
        );

        expect(result, 'to satisfy', {
          'font-size': [
            {
              selector: 'h1',
              namespaceURI: 'foo',
              value: '20px',
            },
          ],
        });
      });
    });

    describe('given as a url(...)', function () {
      it('should annotate the style rules with the default namespace', function () {
        const result = getRules(
          ['font-size'],
          '@namespace url(foo); h1 { font-size: 20px }',
          []
        );

        expect(result, 'to satisfy', {
          'font-size': [
            {
              selector: 'h1',
              namespaceURI: 'foo',
              value: '20px',
            },
          ],
        });
      });
    });

    describe('given as a url("...")', function () {
      it('should annotate the style rules with the default namespace', function () {
        const result = getRules(
          ['font-size'],
          '@namespace url("foo"); h1 { font-size: 20px }',
          []
        );

        expect(result, 'to satisfy', {
          'font-size': [
            {
              selector: 'h1',
              namespaceURI: 'foo',
              value: '20px',
            },
          ],
        });
      });
    });
  });
});
