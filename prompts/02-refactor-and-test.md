# Refactoring, Debug Mode, and Comprehensive Testing

Improve the maintainability, testability, and code quality of subfont.
The main target is `lib/subsetFonts.js` (2,700 lines, 8+ caches, a
worker pool class, and deeply nested logic). All existing tests must
continue to pass after each step.

---

## Part A: Gate timing instrumentation behind debug mode

There are ~27 unconditional `console.log('[subfont timing]...')` calls
scattered through `subsetFonts.js` and `subfont.js`. These spam stdout
on every run.

### Tasks

1. **Add a `debug` parameter** to `collectTextsByPage` and thread it
   through from the `subsetFonts` options (which already has `console`).

2. **Create a `debugLog` helper** in `subsetFonts.js`:
   ```js
   function debugLog(console, debug, ...args) {
     if (debug && console) {
       console.log(...args);
     }
   }
   ```

3. **Replace every `console.log('[subfont timing]...')` call** with
   `debugLog(console, debug, ...)`. Search for the pattern
   `console.log(\`\[subfont timing\]` to find all instances.

4. **Do the same in `subfont.js`** — the `log(...)` calls that print
   `[subfont timing]` should only fire when `debug` is true. The `debug`
   option already exists in `subfont.js`'s parameter list.

5. **Verify** that running with `--debug` produces timing output and
   running without it does not.

---

## Part B: Extract modules from the monolith

Break `lib/subsetFonts.js` into focused modules. Each extraction should
be a separate commit. After each commit, run `npm test` to confirm
nothing broke.

### B1: Extract `FontTracerPool` → `lib/FontTracerPool.js`

Move the `FontTracerPool` class (currently around lines 1015-1123)
to its own file.

- Export the class.
- `require` it from `subsetFonts.js`.
- Keep `fontTracerWorker.js` as-is (it's already separate).

### B2: Extract `extractVisibleText` → `lib/extractVisibleText.js`

Move the `extractVisibleText` function to its own module.

- Export it.
- `require` it from `subsetFonts.js`.
- **Update `test/extractVisibleText.js`** to `require` the new module
  directly instead of using the fragile `eval`-from-source approach.
  Delete the regex/eval extraction code entirely.

### B3: Extract variation axis utilities → `lib/variationAxes.js`

Move these functions to a new module:
- `getVariationAxisUsage`
- `getVariationAxisBounds`
- `warnAboutUnusedVariationAxes`
- `parseFontVariationSettings` (already separate — just re-export or
  reference it)
- The constants `standardVariationAxes`, `ignoredVariationAxes`
- `renderNumberRange`

The new module should export `getVariationAxisUsage`,
`getVariationAxisBounds`, and `warnAboutUnusedVariationAxes`.

Note: `warnAboutUnusedVariationAxes` currently references `assetGraph`
from an enclosing scope — if bug #3 from `01-fix-bugs.md` has not
already been fixed, fix it as part of this extraction by adding
`assetGraph` as an explicit parameter.

### B4: Extract subset generation → `lib/subsetGeneration.js`

Move these functions:
- `getSubsetPromiseId`
- `getSubsetsForFontUsage`
- `getSubsetPromiseId`

They depend on `getFontInfo`, `subsetFont`, `fontverter`, etc.
Pass those as needed or require them directly.

### B5: Extract CSS/font-face utilities → `lib/fontFaceHelpers.js`

Move these pure/near-pure functions:
- `stringifyFontFamily`
- `cssQuoteIfNecessary`
- `getPreferredFontUrl`
- `getFontFaceForFontUsage`
- `getUnusedVariantsStylesheet`
- `getFontUsageStylesheet`
- `getFontFaceDeclarationText`
- `parseFontWeightRange`
- `parseFontStretchRange`
- `getCodepoints`
- `cssAssetIsEmpty`
- `uniqueChars`
- `uniqueCharsFromArray`
- `md5HexPrefix`

These are all stateless utilities. Group them in one module with named
exports.

### Validation

After all extractions, `lib/subsetFonts.js` should be roughly 1,000-1,200
lines — primarily the `collectTextsByPage` and `subsetFonts` orchestration
functions. Run `npm test` to confirm.

---

## Part C: Consolidate caches

The code currently maintains 8+ separate cache Maps with overlapping
key schemes. Several use the same `getDeclarationsKey()`.

### Tasks

1. **Merge caches keyed by `declKey`** into a single struct:
   ```js
   // Instead of:
   snappedEntriesCache.get(declKey)
   globalFontUsageCache.get(declKey)
   pageTextIndexCache.get(declKey)
   preloadEntriesCache.get(declKey)

   // Use:
   const declCache = new Map(); // declKey -> { snappedEntries, fontUsageTemplates, pageTextIndex, preloadIndex }
   ```

2. **Document cache lifecycle** with a comment block at the top of
   `collectTextsByPage` explaining:
   - What each cache stores
   - What its key represents
   - When it's populated vs. read
   - Whether entries are ever invalidated

---

## Part D: Comprehensive test coverage

Add tests for the code paths that currently have zero coverage. Use the
existing test infrastructure (`unexpected` + `assetgraph`). Each test
group below should be its own `describe` block.

### D1: `FontTracerPool` unit tests (`test/FontTracerPool.js`)

```
describe('FontTracerPool')
  it('should initialize workers and process trace requests')
  it('should handle multiple concurrent trace requests')
  it('should fall back gracefully when a worker crashes')
  it('should reject pending tasks when all workers crash')
  it('should clean up workers on destroy')
```

Use a simple HTML string + minimal stylesheet as the trace input.
For the crash test, send a message that causes the worker to throw
or exit.

### D2: `extractVisibleText` tests (update `test/extractVisibleText.js`)

After Part B2, update the test file to import directly. Add:

```
it('should handle multiple sibling script elements')
  // <script>a</script>between<script>b</script>
  // Assert "between" is present, "a" and "b" are not

it('should not extract value from hidden inputs')
  // <input type="hidden" value="secret">
  // Assert "secret" is not present

it('should handle attributes with HTML entities')
  // <img alt="Tom &amp; Jerry">
  // Assert "Tom & Jerry" is present

it('should handle unquoted attributes')
  // <img alt=hello>
  // Assert behavior is defined (either extracts or doesn't)

it('should handle data- attributes that look like extractable attrs')
  // <div data-alt="not-visible">
  // Assert "not-visible" is not extracted
```

### D3: Template optimization tests (`test/subsetFonts.js`)

Add a `describe('template-aware tracing optimization')` block:

```
it('should produce correct subsets when pages share @font-face but have different text')
  // Use the multi-page-different-text fixture
  // Verify that the subset includes characters from both pages

it('should produce identical results whether fast-extract or full-trace is used')
  // Process the same site twice: once with >= 4 pages (triggers worker pool)
  // and once with < 4 pages (sequential). Compare subset sizes.

it('should handle pages with different inline styles but same external CSS')
  // Create fixture with shared external CSS but different <style> blocks
  // Verify correct grouping and subsetting
```

### D4: Variation axis edge case tests

```
describe('variation axis tracking')
  it('should not note ital=0 when only italic is used')
  it('should not note slnt=0 when only oblique is used')
  it('should correctly track multiple axis values')
```

These test the operator precedence bug fix from `01-fix-bugs.md`.

### D5: `--skip-source-map-processing` test

```
it('should skip source map processing when skipSourceMapProcessing is true')
  // Run subsetFonts with skipSourceMapProcessing: true on a fixture
  // that has CSS source maps. Verify it completes without processing maps.
```

### D6: `--debug` timing output test

```
it('should emit timing logs when debug is true')
it('should not emit timing logs when debug is false')
```

Capture console output and check for `[subfont timing]` prefix.

---

## Part E: Minor cleanup

1. **Remove `profile-font-tracer.js`** or fix it to use the same
   relation-following strategy as `subfont.js`. Currently it uses
   `{ crossorigin: false }` which doesn't match the real code path,
   making its profiling results misleading.

2. **Update `package.json` engines** from `"node": ">=10.0.0"` to
   `"node": ">=14.0.0"` (worker_threads stable in Node 12, but Node 12
   is EOL; Node 14 is the realistic minimum).

3. **Remove the redundant check** on line ~2220:
   ```js
   if (existingFontAsset && fontAsset.isInline) {
   ```
   The outer `if` on line ~2215 already guarantees `fontAsset.isInline`
   is true.

---

## Order of operations

1. Part A (debug mode) — small, safe, high-value
2. Part B1-B2 (extract FontTracerPool + extractVisibleText) — enables D1/D2
3. Part D1-D2 (tests for newly extracted modules)
4. Part B3-B5 (remaining extractions)
5. Part C (consolidate caches)
6. Part D3-D6 (remaining tests)
7. Part E (cleanup)

Run `npm test` after each step.
