import * as specificity from 'specificity';
import * as postcss from 'postcss';
import type {
  AnyNode,
  ChildNode,
  Container,
  Declaration,
  AtRule,
  Rule,
} from 'postcss';
import postcssValueParser = require('postcss-value-parser');
import unquote = require('./unquote');
import * as parseAnimationShorthand from '@hookun/parse-animation-shorthand';

const counterRendererNames = new Set<string>([
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

interface RuleEntry {
  predicates: Record<string, boolean>;
  namespaceURI?: string;
  selector?: string;
  specificityArray: [number, number, number, number] | number[];
  prop: string;
  value: string;
  important: boolean;
}

interface CounterStyleEntry {
  name: string;
  predicates: Record<string, boolean>;
  props: Record<string, string>;
}

interface KeyframesEntry {
  name: string;
  namespaceURI?: string;
  predicates: Record<string, boolean>;
  node: AtRule;
}

interface CssRulesByProperty {
  counterStyles: CounterStyleEntry[];
  keyframes: KeyframesEntry[];
  [property: string]: RuleEntry[] | CounterStyleEntry[] | KeyframesEntry[];
}

function unwrapNamespace(str: string): string {
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
function ruleFingerprint(rule: RuleEntry): string {
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
function deduplicateRules(rulesByProperty: CssRulesByProperty): void {
  for (const key of Object.keys(rulesByProperty)) {
    if (key === 'counterStyles' || key === 'keyframes') continue;
    const rules = rulesByProperty[key] as RuleEntry[];
    if (rules.length <= 1) continue;
    const seen = new Set<string>();
    rulesByProperty[key] = rules.filter((rule) => {
      const fp = ruleFingerprint(rule);
      if (seen.has(fp)) return false;
      seen.add(fp);
      return true;
    });
  }
}

function getCssRulesByProperty(
  properties: string[],
  cssSource: string,
  existingPredicates?: Record<string, boolean>
): CssRulesByProperty {
  const initialPredicates = existingPredicates || {};

  const parseTree = postcss.parse(cssSource);
  let defaultNamespaceURI: string | undefined;
  const namespacePrefixes = new Map<string, string>();
  // Parse @namespace rules: either a default namespace or a prefixed one.
  parseTree.walkAtRules('namespace', (rule) => {
    const match = rule.params.match(
      /^(?<prefix>\w+)\s+(?<uri>.+)$|^(?<defaultUri>.+)$/
    );
    if (!match || !match.groups) return;
    const { prefix, uri, defaultUri } = match.groups;
    if (prefix) {
      namespacePrefixes.set(prefix, unwrapNamespace(uri));
    } else {
      defaultNamespaceURI = unwrapNamespace(defaultUri);
    }
  });
  const rulesByProperty: CssRulesByProperty = {
    counterStyles: [],
    keyframes: [],
  };

  for (const property of properties) {
    rulesByProperty[property] = [] as RuleEntry[];
  }

  // Resolve the namespace URI for a selector by examining its subject
  // (the rightmost compound selector) for a namespace prefix like svg|text.
  function resolveNamespaceURI(selector: string): string | undefined {
    if (namespacePrefixes.size === 0) {
      return defaultNamespaceURI;
    }
    const compoundSelectors = selector.split(/\s*[>+~]\s*|\s+/);
    const subject = compoundSelectors[compoundSelectors.length - 1];
    const nsMatch = subject.match(/^(?<nsPrefix>\*|\w*)\|/);
    if (!nsMatch || !nsMatch.groups) {
      return defaultNamespaceURI;
    }
    const prefix = nsMatch.groups.nsPrefix;
    if (prefix === '*') {
      return undefined;
    }
    if (prefix === '') {
      return '';
    }
    return namespacePrefixes.get(prefix) || defaultNamespaceURI;
  }

  const specificityCache = new Map<string, specificity.SpecificityResult[]>();
  function getSpecificity(selector: string): specificity.SpecificityResult[] {
    let cached = specificityCache.get(selector);
    if (!cached) {
      cached = specificity.calculate(selector);
      specificityCache.set(selector, cached);
    }
    return cached;
  }

  const activeCssQueryPredicates: string[] = [];
  function getCurrentPredicates(): Record<string, boolean> {
    if (activeCssQueryPredicates.length > 0) {
      const predicates = { ...initialPredicates };
      for (const predicate of activeCssQueryPredicates) {
        predicates[predicate] = true;
      }
      return predicates;
    } else {
      return initialPredicates;
    }
  }

  function pushRulePerSelector(
    node: Declaration,
    prop: string,
    value: string
  ): void {
    const parent = node.parent as Rule;
    getSpecificity(parent.selector).forEach((specificityObject) => {
      const isStyleAttribute = specificityObject.selector === 'bogusselector';
      const selectorStr = isStyleAttribute
        ? undefined
        : specificityObject.selector.trim();
      const list = (rulesByProperty[prop] = (rulesByProperty[prop] ||
        []) as RuleEntry[]);
      list.push({
        predicates: getCurrentPredicates(),
        namespaceURI: isStyleAttribute
          ? defaultNamespaceURI
          : resolveNamespaceURI(selectorStr as string),
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

  (function visit(node: AnyNode): void {
    // Check for selector. We might be in an at-rule like @font-face
    if (node.type === 'decl' && node.parent && node.parent.type === 'rule') {
      const isCustomProperty = /^--/.test(node.prop);
      const propName = isCustomProperty ? node.prop : node.prop.toLowerCase(); // Custom properties ARE case sensitive
      if (isCustomProperty || properties.includes(propName)) {
        pushRulePerSelector(node, propName, node.value);
      } else if (
        propName === 'list-style' &&
        properties.includes('list-style-type')
      ) {
        let listStyleType: string | undefined;
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
        const transitionProperties: string[] = [];
        const transitionDurations: string[] = [];
        const parsed = postcssValueParser(node.value);
        let currentItem: string[] = [];
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
          const fontParent = node.parent as Rule;
          getSpecificity(fontParent.selector).forEach((specificityObject) => {
            const isStyleAttribute =
              specificityObject.selector === 'bogusselector';
            const fontSelector = isStyleAttribute
              ? undefined
              : specificityObject.selector.trim();
            const entry: RuleEntry = {
              predicates: getCurrentPredicates(),
              namespaceURI: isStyleAttribute
                ? defaultNamespaceURI
                : resolveNamespaceURI(fontSelector as string),
              selector: fontSelector,
              specificityArray: isStyleAttribute
                ? [1, 0, 0, 0]
                : specificityObject.specificityArray,
              prop: 'font',
              value: node.value,
              important: !!node.important,
            };
            for (const prop of fontLonghands) {
              (rulesByProperty[prop] as RuleEntry[]).push(entry);
            }
          });
        }
      }
    } else if (
      node.type === 'atrule' &&
      node.name.toLowerCase() === 'counter-style'
    ) {
      const props: Record<string, string> = {};
      for (const childNode of node.nodes ?? []) {
        if (childNode.type === 'decl') {
          props[childNode.prop] = childNode.value;
        }
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

    const containerNodes = (node as Container).nodes;
    if (containerNodes) {
      let popAfter = false;
      if (node.type === 'atrule') {
        const name = node.name.toLowerCase();
        if (name === 'media' || name === 'supports') {
          activeCssQueryPredicates.push(`${name}Query:${node.params}`);
          popAfter = true;
        }
      }
      for (const childNode of containerNodes as ChildNode[]) {
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

export = getCssRulesByProperty;
