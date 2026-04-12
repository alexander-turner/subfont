const specificity = require('specificity');
const postcss = require('postcss');
const postcssValueParser = require('postcss-value-parser');
const unquote = require('./unquote');
const parseAnimationShorthand = require('@hookun/parse-animation-shorthand');

const counterRendererNames = new Set([
  'none',
  'disc',
  'circle',
  'square',
  'decimal',
  'decimal-leading-zero',
  'lower-roman',
  'upper-roman',
  'lower-greek',
  'lower-latin',
  'lower-alpha',
  'upper-latin',
  'upper-alpha',
  'armenian',
  'georgian',
  'hebrew',
]);

function unwrapNamespace(str) {
  if (/^["']/.test(str)) {
    return unquote(str);
  } else if (/^url\(.*\)$/i.test(str)) {
    return unquote(str.replace(/^url\((.*)\)$/i, '$1'));
  } else {
    throw new Error(`Cannot parse CSS namespace: ${str}`);
  }
}

// Build a collision-free fingerprint for a CSS rule entry. Null bytes (\0)
// delimit fields because they cannot appear in CSS property values.
function ruleFingerprint(rule) {
  const predicateEntries = Object.keys(rule.predicates)
    .sort()
    .map((k) => `${k}=${rule.predicates[k]}`);
  return [
    rule.selector,
    rule.value,
    rule.prop,
    rule.important,
    (rule.specificityArray || []).join(','),
    rule.namespaceURI,
    predicateEntries.join('&'),
  ].join('\0');
}

// Remove fully-duplicate rule entries (same selector, value, specificity,
// predicates, namespace, and importance) within each property.
function deduplicateRules(rulesByProperty) {
  for (const key of Object.keys(rulesByProperty)) {
    if (key === 'counterStyles' || key === 'keyframes') continue;
    const rules = rulesByProperty[key];
    if (rules.length <= 1) continue;
    const seen = new Set();
    rulesByProperty[key] = rules.filter((rule) => {
      const fp = ruleFingerprint(rule);
      if (seen.has(fp)) return false;
      seen.add(fp);
      return true;
    });
  }
}

function getCssRulesByProperty(properties, cssSource, existingPredicates) {
  if (!Array.isArray(properties)) {
    throw new Error('properties argument must be an array');
  }
  if (typeof cssSource !== 'string') {
    throw new Error('cssSource argument must be a string containing valid CSS');
  }
  existingPredicates = existingPredicates || {};

  const parseTree = postcss.parse(cssSource);
  let defaultNamespaceURI;
  const namespacePrefixes = new Map();
  // Parse @namespace rules: either a default namespace or a prefixed one.
  // Spec: https://developer.mozilla.org/en-US/docs/Web/CSS/@namespace
  // Grammar: @namespace <prefix>? [<string> | url(<uri>)]
  parseTree.walkAtRules('namespace', (rule) => {
    const match = rule.params.match(
      /^(?<prefix>\w+)\s+(?<uri>.+)$|^(?<defaultUri>.+)$/
    );
    if (!match) return;
    const { prefix, uri, defaultUri } = match.groups;
    if (prefix) {
      namespacePrefixes.set(prefix, unwrapNamespace(uri));
    } else {
      defaultNamespaceURI = unwrapNamespace(defaultUri);
    }
  });
  const rulesByProperty = {
    counterStyles: [],
    keyframes: [],
  };

  for (const property of properties) {
    rulesByProperty[property] = [];
  }

  // Resolve the namespace URI for a selector by examining its subject
  // (the rightmost compound selector) for a namespace prefix like svg|text.
  function resolveNamespaceURI(selector) {
    if (namespacePrefixes.size === 0) {
      return defaultNamespaceURI;
    }
    // Find the subject (rightmost simple selector before pseudo-elements).
    // Split on combinators: whitespace, >, +, ~
    const compoundSelectors = selector.split(/\s*[>+~]\s*|\s+/);
    const subject = compoundSelectors[compoundSelectors.length - 1];
    // Check for namespace prefix: prefix|element, *|element, or |element
    const nsMatch = subject.match(/^(?<nsPrefix>\*|\w*)\|/);
    if (!nsMatch) {
      return defaultNamespaceURI;
    }
    const prefix = nsMatch.groups.nsPrefix;
    if (prefix === '*') {
      // *|element matches any namespace — no namespace filter
      return undefined;
    }
    if (prefix === '') {
      // |element means no namespace (elements not in any namespace)
      return '';
    }
    return namespacePrefixes.get(prefix) || defaultNamespaceURI;
  }

  const specificityCache = new Map();
  function getSpecificity(selector) {
    let cached = specificityCache.get(selector);
    if (!cached) {
      cached = specificity.calculate(selector);
      specificityCache.set(selector, cached);
    }
    return cached;
  }

  const activeCssQueryPredicates = [];
  function getCurrentPredicates() {
    if (activeCssQueryPredicates.length > 0) {
      const predicates = { ...existingPredicates };
      for (const predicate of activeCssQueryPredicates) {
        predicates[predicate] = true;
      }
      return predicates;
    } else {
      return existingPredicates;
    }
  }

  function pushRulePerSelector(node, prop, value) {
    getSpecificity(node.parent.selector).forEach((specificityObject) => {
      const isStyleAttribute = specificityObject.selector === 'bogusselector';
      const selectorStr = isStyleAttribute
        ? undefined
        : specificityObject.selector.trim();
      (rulesByProperty[prop] = rulesByProperty[prop] || []).push({
        predicates: getCurrentPredicates(),
        namespaceURI: isStyleAttribute
          ? defaultNamespaceURI
          : resolveNamespaceURI(selectorStr),
        selector: selectorStr,
        specificityArray: isStyleAttribute
          ? [1, 0, 0, 0]
          : specificityObject.specificityArray,
        prop,
        value,
        important: !!node.important,
      });
    });
  }

  (function visit(node) {
    // Check for selector. We might be in an at-rule like @font-face
    if (node.type === 'decl' && node.parent.selector) {
      const isCustomProperty = /^--/.test(node.prop);
      const propName = isCustomProperty ? node.prop : node.prop.toLowerCase(); // Custom properties ARE case sensitive
      if (isCustomProperty || properties.includes(propName)) {
        pushRulePerSelector(node, propName, node.value);
      } else if (
        propName === 'list-style' &&
        properties.includes('list-style-type')
      ) {
        let listStyleType;
        for (const valueNode of postcssValueParser(node.value).nodes) {
          if (valueNode.type === 'string') {
            listStyleType = valueNode.value;
          } else if (
            valueNode.type === 'word' &&
            counterRendererNames.has(valueNode.value)
          ) {
            listStyleType = valueNode.value;
          }
        }

        if (typeof listStyleType !== 'undefined') {
          pushRulePerSelector(node, 'list-style-type', listStyleType);
        }
      } else if (propName === 'animation') {
        const parsedAnimation = parseAnimationShorthand.parseSingle(
          node.value
        ).value;

        if (properties.includes('animation-name')) {
          pushRulePerSelector(node, 'animation-name', parsedAnimation.name);
        }
        if (properties.includes('animation-timing-function')) {
          pushRulePerSelector(
            node,
            'animation-timing-function',
            parseAnimationShorthand.serialize({
              name: '',
              timingFunction: parsedAnimation.timingFunction,
            })
          );
        }
      } else if (propName === 'transition') {
        // Use postcss-value-parser — regex split breaks on commas inside cubic-bezier() etc.
        const transitionProperties = [];
        const transitionDurations = [];
        const parsed = postcssValueParser(node.value);
        let currentItem = [];
        for (const valueNode of parsed.nodes) {
          if (valueNode.type === 'div' && valueNode.value === ',') {
            if (currentItem.length > 0) {
              transitionProperties.push(currentItem[0]);
            }
            if (currentItem.length > 1) {
              transitionDurations.push(currentItem[1]);
            }
            currentItem = [];
          } else if (valueNode.type !== 'space') {
            currentItem.push(postcssValueParser.stringify(valueNode));
          }
        }
        if (currentItem.length > 0) {
          transitionProperties.push(currentItem[0]);
        }
        if (currentItem.length > 1) {
          transitionDurations.push(currentItem[1]);
        }

        if (properties.includes('transition-property')) {
          pushRulePerSelector(
            node,
            'transition-property',
            transitionProperties.join(', ')
          );
        }
        if (properties.includes('transition-duration')) {
          pushRulePerSelector(
            node,
            'transition-duration',
            transitionDurations.join(', ')
          );
        }
      } else if (propName === 'font') {
        const fontLonghands = [
          'font-family',
          'font-weight',
          'font-size',
          'font-style',
        ].filter((prop) => properties.includes(prop));
        if (fontLonghands.length > 0) {
          getSpecificity(node.parent.selector).forEach((specificityObject) => {
            const isStyleAttribute =
              specificityObject.selector === 'bogusselector';
            const fontSelector = isStyleAttribute
              ? undefined
              : specificityObject.selector.trim();
            const entry = {
              predicates: getCurrentPredicates(),
              namespaceURI: isStyleAttribute
                ? defaultNamespaceURI
                : resolveNamespaceURI(fontSelector),
              selector: fontSelector,
              specificityArray: isStyleAttribute
                ? [1, 0, 0, 0]
                : specificityObject.specificityArray,
              prop: 'font',
              value: node.value,
              important: !!node.important,
            };
            for (const prop of fontLonghands) {
              rulesByProperty[prop].push(entry);
            }
          });
        }
      }
    } else if (
      node.type === 'atrule' &&
      node.name.toLowerCase() === 'counter-style'
    ) {
      const props = {};
      for (const childNode of node.nodes) {
        props[childNode.prop] = childNode.value;
      }
      rulesByProperty.counterStyles.push({
        name: node.params,
        predicates: getCurrentPredicates(),
        props,
      });
    } else if (
      node.type === 'atrule' &&
      node.name.toLowerCase() === 'keyframes'
    ) {
      rulesByProperty.keyframes.push({
        name: node.params,
        namespaceURI: defaultNamespaceURI,
        predicates: getCurrentPredicates(),
        node,
      });
      return;
    }

    if (node.nodes) {
      let popAfter = false;
      if (node.type === 'atrule') {
        const name = node.name.toLowerCase();
        if (name === 'media' || name === 'supports') {
          activeCssQueryPredicates.push(`${name}Query:${node.params}`);
          popAfter = true;
        }
      }
      for (const childNode of node.nodes) {
        visit(childNode);
      }
      if (popAfter) {
        activeCssQueryPredicates.pop();
      }
    }
  })(parseTree);

  deduplicateRules(rulesByProperty);

  return rulesByProperty;
}

module.exports = getCssRulesByProperty;
