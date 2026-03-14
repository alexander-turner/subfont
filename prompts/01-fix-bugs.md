# Bug Fixes for subfont

Fix all confirmed bugs in `lib/subsetFonts.js` and `lib/fontTracerWorker.js`.
Each fix must include a regression test. Run the existing test suite after
each fix to confirm nothing breaks.

---

## Bug 1: `getFontFaceDeclarationText` — `Map.set()` called with wrong arity

**File:** `lib/subsetFonts.js`, around line 171

```js
// CURRENT (broken):
const originalHrefTypeByRelation = new Map();
for (const relation of relations) {
  originalHrefTypeByRelation.set(relation.hrefType);   // <-- ONE arg
  relation.hrefType = 'absolute';
}
```

`Map.set(key)` with one argument stores `(relation.hrefType, undefined)`.
The restore loop on lines 177-182 then iterates `.entries()` and sets
`relation.hrefType = undefined`, permanently corrupting all relations.

**Fix:** Change to `originalHrefTypeByRelation.set(relation, relation.hrefType);`

**Test:** Write a unit test (or extend an existing integration test) that
calls a code path exercising `getFontFaceDeclarationText` and asserts that
`relation.hrefType` is preserved after the call.

---

## Bug 2: Operator precedence in `getVariationAxisUsage` (two instances)

**File:** `lib/subsetFonts.js`, around lines 868 and 882

```js
// CURRENT (broken):
if (fontStyles.size > fontStyles.has('italic') ? 1 : 0) {
// Parses as: (fontStyles.size > fontStyles.has('italic')) ? 1 : 0
// Which is always 1 (truthy) when fontStyles is non-empty
```

Same pattern on line 882 with `'oblique'`.

**Fix:** Add parentheses:
```js
if (fontStyles.size > (fontStyles.has('italic') ? 1 : 0)) {
```
and:
```js
if (fontStyles.size > (fontStyles.has('oblique') ? 1 : 0)) {
```

**Test:** Write a targeted test for `getVariationAxisUsage` (or its
observable effects through `subsetFonts`) with a font that has only
`font-style: italic` — verify that `ital=0` is NOT noted as used.
Similarly test with only `font-style: oblique` and verify `slnt=0` is
not noted.

---

## Bug 3: `warnAboutUnusedVariationAxes` references `assetGraph` out of scope

**File:** `lib/subsetFonts.js`, around line 1001

`warnAboutUnusedVariationAxes` is defined at **module scope** (line 925)
but calls `assetGraph.info(...)` on line 1001. `assetGraph` is only a
parameter of `subsetFonts` (line 1822). This function is not a closure
inside `subsetFonts`, so `assetGraph` is `undefined` here.

This crashes with `TypeError` whenever variable fonts with unused axes
are detected and `--instance` is not passed.

**Fix:** Add `assetGraph` as a fourth parameter to
`warnAboutUnusedVariationAxes`, and pass it from the call site at
line 2016:
```js
await warnAboutUnusedVariationAxes(
  fontAssetsByUrl,
  seenAxisValuesByFontUrlAndAxisName,
  outOfBoundsAxesByFontUrl,
  assetGraph   // <-- add this
);
```

**Test:** Add or extend a test using a variable font with unused
variation axes (without `--instance`). Confirm it does not crash and
instead emits the expected info message.

---

## Bug 4: Unawaited `.then()` in subset generation

**File:** `lib/subsetFonts.js`, around line 436

```js
subsetPromiseMap[promiseId].then((subsetBuffer) => {
  // Mutates fontUsage.subsets — but this chain is never awaited
});
```

`Promise.all(Object.values(subsetPromiseMap))` on line 459 waits for the
**original** promises, not the `.then()` continuations. The mutations
inside `.then()` may not have completed by the time downstream code reads
`fontUsage.subsets`.

**Fix:** Store the full `.then()` chain back into `subsetPromiseMap`:
```js
subsetPromiseMap[promiseId] = subsetPromiseMap[promiseId].then((subsetBuffer) => {
  // ... existing mutation logic ...
}).catch((err) => {
  // ... handle or re-throw ...
});
```
Or restructure to use `await` in a loop over the results after
`Promise.all`.

**Test:** This is hard to test in isolation due to timing. Verify that
existing multi-page tests still pass and that `fontUsage.subsets` is
always populated before downstream consumers access it.

---

## Bug 5: Worker pool hangs when all workers crash

**File:** `lib/subsetFonts.js`, `FontTracerPool._onWorkerExit` (around line 1070)

When a worker crashes, it is removed from the idle pool but never
replaced. If all workers crash, the pending task queue grows unbounded
and promises never resolve, hanging the process indefinitely.

**Fix:** After handling the crashed worker's in-flight task, reject all
remaining pending tasks if no workers remain:
```js
_onWorkerExit(worker, code) {
  if (code !== 0) {
    const idx = this._idle.indexOf(worker);
    if (idx !== -1) this._idle.splice(idx, 1);
    // Remove from workers array too
    const wIdx = this._workers.indexOf(worker);
    if (wIdx !== -1) this._workers.splice(wIdx, 1);

    const taskId = this._taskByWorker.get(worker);
    this._taskByWorker.delete(worker);
    if (taskId !== undefined) {
      const cb = this._taskCallbacks.get(taskId);
      if (cb) {
        this._taskCallbacks.delete(taskId);
        cb.reject(new Error(`Worker exited with code ${code}`));
      }
    }

    // If no workers remain, reject all pending tasks
    if (this._workers.length === 0) {
      for (const pending of this._pendingTasks) {
        const cb = this._taskCallbacks.get(pending.message.taskId);
        if (cb) {
          this._taskCallbacks.delete(pending.message.taskId);
          cb.reject(new Error('All workers have crashed'));
        }
      }
      this._pendingTasks = [];
    }
  }
}
```

**Test:** Write a unit test for `FontTracerPool` that sends it an
HTML payload which causes the worker to crash (e.g., by sending an
invalid message type and having the worker `process.exit(1)`). Verify
the promise rejects rather than hanging.

---

## Bug 6: `extractVisibleText` extracts `value` from hidden inputs

**File:** `lib/subsetFonts.js`, around line 94

The regex `/\b(?:alt|title|placeholder|value|aria-label)\s*=\s*"([^"]*)"/gi`
extracts `value` attributes from ALL elements, including
`<input type="hidden" value="secret_token">`.

**Fix:** Remove `value` from the attribute list (it is rarely visible
text and is a source of false positives), or change the regex to exclude
`type="hidden"` inputs. The simpler fix is removing `value`:
```js
/\b(?:alt|title|placeholder|aria-label)\s*=\s*"([^"]*)"/gi
```

**Test:** Add a test to `test/extractVisibleText.js` confirming that
hidden input values are not extracted, and that `placeholder` still is.

---

## Verification

After all fixes, run:
```bash
npm test
```

All existing tests must pass. Each bug fix should have at least one new
test case that would have caught the bug.
