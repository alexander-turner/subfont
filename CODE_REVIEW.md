# Code Review: subfont

## 1. Security

### P0 - Potential XSS via URL injection in async CSS loader

**File:** `lib/subsetFonts.js:192`

The `asyncLoadStyleRelationWithFallback` function injects a URL directly into a
JavaScript string template using string interpolation:

```js
el.href = '${htmlOrSvgAsset.assetGraph.buildHref(
  originalRelation.to.url,
  htmlOrSvgAsset.url,
  { hrefType }
)}'.toString('url');
```

If `originalRelation.to.url` contains a single quote or backslash, this becomes
a script injection vector. The URL should be escaped for JS string context or
set via a data attribute rather than string interpolation. The `.toString('url')`
call is also suspicious — `String.prototype.toString` ignores arguments, so this
is a no-op.

### P1 - MD5 used for content hashing

**File:** `lib/fontFaceHelpers.js:239`

MD5 is cryptographically broken. While this is used for cache-busting filenames
(not security), it's still a collision risk and goes against modern best
practices. SHA-256 would be negligible overhead.

---

## 2. Correctness Bugs

### P0 - `stringifyFontFamily` doesn't quote when it should

**File:** `lib/fontFaceHelpers.js:12-18`

When a font-family name contains special characters, the function escapes
backslashes and double-quotes but never wraps the result in quotes. A
font-family like `Open Sans` (contains a space) will be returned unquoted,
which is invalid CSS when used in non-`font-family` contexts.

### P1 - `warnAboutMissingGlyphs` reports only first occurrence

**File:** `lib/warnAboutMissingGlyphs.js:64`

`htmlOrSvgAsset.text.indexOf(char)` always finds the *first* occurrence of a
character. If the same character appears at multiple locations with different
font assignments, only the first location is reported.

### P1 - `text` variable referenced from outer scope in closure

**File:** `lib/subsetFonts.js:981`

Inside `getOrComputeGlobalFontUsages`, the code references `text`, but this
refers to the `text` parameter from the outer `collectTextsByPage` function.
The variable is captured implicitly from a closure 3+ levels deep, making
the code fragile and hard to reason about.

### P2 - `getPreferredFontUrl` returns `undefined` silently

**File:** `lib/fontFaceHelpers.js:28-52`

When no matching font format is found, the function returns `undefined`
implicitly. Several callers check for this, but a caller forgetting to
check will get mysterious failures downstream.

---

## 3. Code Health

- **High complexity in `subsetFonts.js`** — This single file is ~2100 lines
  containing `collectTextsByPage` (~900 lines) and `subsetFonts` (~900 lines).
  This is extremely hard to maintain and test in isolation.

- **Deep nesting of closures** — Functions like `getOrComputeGlobalFontUsages`
  and `computeSnappedGlobalEntries` are closures that capture many variables
  from the outer scope, making them untestable in isolation.

- **Inconsistent error handling** — Some functions swallow errors, some throw,
  and some warn via `assetGraph.warn()`. The boundary between "warn and
  continue" vs "throw and abort" is unclear.

- **`\x1d` as separator in cache keys** — Using ASCII Group Separator as a
  delimiter in cache keys is fragile. If any font value contains `\x1d`, the
  cache will produce incorrect results. Structured keys would be safer.

---

## 4. Efficiency

### P1 - `uniqueChars` sorts all characters

**File:** `lib/fontFaceHelpers.js:224-226`

For large pages, the spread-Set-spread-sort-join pattern is O(n log n) when
O(n) would suffice for most callers.

### P1 - `collectFeatureGlyphIds` shapes every character × every feature

**File:** `lib/collectFeatureGlyphIds.js:87-121`

With 47 known features and potentially thousands of characters, this is
O(chars × features) HarfBuzz calls. Consider batching or shaping the full
text string at once per feature.

### P2 - WASM binary loaded eagerly at module level

**File:** `lib/subsetFontWithGlyphs.js:12-20`

The WASM binary is loaded when the module is `require()`'d, even if
`subsetFontWithGlyphs` is never called.

### P2 - Redundant font format conversion

`getFontInfo.js`, `collectFeatureGlyphIds.js`, and `subsetFontWithGlyphs.js`
each convert the same font buffer to sfnt/truetype independently. The
converted buffer could be cached.

---

## 5. Test Coverage Gaps

- **No tests for `asyncLoadStyleRelationWithFallback`** — This function
  generates inline JavaScript with string interpolation (the XSS issue
  above) but has no dedicated tests.

- **No stress/edge tests for `FontTracerPool`** — No tests for worker
  respawn after crash with pending tasks, or all workers crashing while
  tasks are queued.

- **No tests for Google Fonts self-hosting** —
  `createSelfHostedGoogleFontsCssAsset` is complex but appears untested
  in isolation.

- **No integration tests for fast-path fallback** — The interaction between
  fast-path pages and inline font style fallback (`hasInlineFontStyles`)
  is untested.

- **Missing negative tests for `subsetFontWithGlyphs`** — No tests for
  invalid font buffers, empty text, or WASM memory growth scenarios.

---

## 6. Missing Features

- **No unicode-range support for multiple @font-face with same family**
  (`lib/subsetFonts.js:470-477`) — The code throws when multiple `@font-face`
  declarations share the same family/style/weight. This is common for CJK fonts.

- **No `font-size-adjust` or `size-adjust` support** — These descriptors are
  increasingly used for CLS optimization but are not handled.

- **No cleanup of downloaded Chrome browsers** (`lib/HeadlessBrowser.js:28`) —
  Chrome downloads accumulate in `./puppeteer-browsers/` and are never cleaned.

- **No `--dry-run` option** — Users can't preview changes without modifying files.

---

## Summary

| Category | P0 | P1 | P2 |
|---|---|---|---|
| Security | 1 | 1 | - |
| Correctness | 1 | 2 | 1 |
| Code Health | - | - | 4 |
| Efficiency | - | 2 | 2 |
| Coverage | - | 4 gaps | - |
| Missing Features | - | 1 | 3 |

The codebase is well-engineered overall with sophisticated caching,
parallelization, and performance optimization. The highest-priority fixes are
the XSS vector in the async CSS loader and the `stringifyFontFamily` quoting
bug. The biggest maintainability concern is the 2100-line `subsetFonts.js`.
