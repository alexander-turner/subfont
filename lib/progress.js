// Helpers for surfacing phase progress to the console.
//
// Two audiences:
//   1. Non-debug users want brief, always-visible signal that the tool
//      isn't hung on large runs (banner + periodic page counts + done).
//   2. Debug users want to pinpoint *which* phase is stuck when output
//      goes silent. Paired "→ starting" / "← finished in Nms" markers
//      around each slow phase mean the last line printed is always the
//      currently-running phase.

// Pick a progress step that gives roughly 10 updates across the run,
// clamped to [1, 10]. For a 500-page run this prints every 50; for 30,
// every 3. Avoids long silent stretches on large runs and per-page spam
// on small ones.
function progressStep(total) {
  return Math.max(1, Math.min(10, Math.ceil(total / 10)));
}

// Reporter for a phase that iterates `total` items.
//   banner(msg): optional one-line header printed immediately.
//   tick(): call once per completed item; returns the running count.
//   done(): prints "<label>: <total>/<total> pages done." footer.
// All methods no-op when disabled (missing console or below minTotal).
function createPageProgress({ total, console, label, minTotal = 5 }) {
  const enabled = Boolean(console) && total >= minTotal;
  const step = progressStep(total);
  let count = 0;
  return {
    enabled,
    banner(msg) {
      if (enabled) console.log(msg);
    },
    tick() {
      count++;
      if (enabled && count % step === 0 && count < total) {
        console.log(`  ${label}: ${count}/${total} pages...`);
      }
      return count;
    },
    done() {
      if (enabled) {
        console.log(`  ${label}: ${total}/${total} pages done.`);
      }
    },
  };
}

// Per-page debug line emitted right after a page finishes tracing.
// When a run hangs, the last-printed page identifies which page stalled.
function logTracedPage(console, debug, index, total, asset, startMs) {
  if (!debug || !console) return;
  console.log(
    `[subfont timing]   traced [${index}/${total}] ${asset.urlOrDescription} in ${Date.now() - startMs}ms`
  );
}

// Start/end markers for a debug phase. The "→ label..." line is printed
// *before* the work begins, so if the work hangs the user sees exactly
// which phase is in flight. The returned end() logs elapsed ms and
// returns the duration so callers can still populate a timings map.
//
//   const phase = logPhaseStart(console, debug, 'getSubsetsForFontUsage');
//   await getSubsetsForFontUsage(...);
//   timings.x = phase.end();
function logPhaseStart(console, debug, label) {
  if (!debug || !console) {
    const start = Date.now();
    return {
      end() {
        return Date.now() - start;
      },
    };
  }
  const start = Date.now();
  console.log(`[subfont timing] → ${label}...`);
  return {
    end(extraInfo) {
      const ms = Date.now() - start;
      const suffix = extraInfo ? ` (${extraInfo})` : '';
      console.log(`[subfont timing] ← ${label}: ${ms}ms${suffix}`);
      return ms;
    },
  };
}

// Bind a (console, debug) pair once at the top of a function, then use
// the returned tracker to open phases with a single short call:
//
//   const trackPhase = makePhaseTracker(console, debug);
//   const p = trackPhase('codepoint generation');
//   ...work...
//   timings.x = p.end();
function makePhaseTracker(console, debug) {
  return (label) => logPhaseStart(console, debug, label);
}

module.exports = {
  createPageProgress,
  logTracedPage,
  makePhaseTracker,
};
