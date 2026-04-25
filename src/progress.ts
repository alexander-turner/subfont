// Helpers for surfacing phase progress to the console.
//
// Two audiences:
//   1. Non-debug users want brief, always-visible signal that the tool
//      isn't hung on large runs (banner + periodic page counts + done).
//   2. Debug users want to pinpoint *which* phase is stuck when output
//      goes silent. Paired "→ starting" / "← finished in Nms" markers
//      around each slow phase mean the last line printed is always the
//      currently-running phase.

export interface ProgressConsole {
  // Variadic console.log: accepts arbitrary printable args. eslint forbids
  // bare `unknown` per project policy; here it's the right type.
  // eslint-disable-next-line no-restricted-syntax
  log?: (...args: unknown[]) => void;
}

export interface PhaseHandle {
  end(extraInfo?: string | null): number;
}

export interface PageProgress {
  enabled: boolean;
  banner(msg: string): void;
  tick(): number;
  done(): void;
}

interface CreatePageProgressOptions {
  total: number;
  console?: ProgressConsole | Console | null;
  label: string;
  minTotal?: number;
}

// Pick a progress step that gives roughly 10 updates across the run,
// clamped to [1, 10]. For a 500-page run this prints every 50; for 30,
// every 3. Avoids long silent stretches on large runs and per-page spam
// on small ones.
function progressStep(total: number): number {
  return Math.max(1, Math.min(10, Math.ceil(total / 10)));
}

// Reporter for a phase that iterates `total` items.
//   banner(msg): optional one-line header printed immediately.
//   tick(): call once per completed item; returns the running count.
//   done(): prints "<label>: <total>/<total> pages done." footer.
// All methods no-op when disabled (missing console or below minTotal).
export function createPageProgress({
  total,
  console,
  label,
  minTotal = 5,
}: CreatePageProgressOptions): PageProgress {
  const enabled = Boolean(console) && total >= minTotal;
  const step = progressStep(total);
  let count = 0;
  return {
    enabled,
    banner(msg: string) {
      if (enabled && console?.log) console.log(msg);
    },
    tick() {
      count++;
      if (enabled && count % step === 0 && count < total && console?.log) {
        console.log(`  ${label}: ${count}/${total} pages...`);
      }
      return count;
    },
    done() {
      if (enabled && console?.log) {
        console.log(`  ${label}: ${total}/${total} pages done.`);
      }
    },
  };
}

interface TraceablePageAsset {
  urlOrDescription: string;
}

// Per-page debug line emitted right after a page finishes tracing.
// When a run hangs, the last-printed page identifies which page stalled.
export function logTracedPage(
  console: ProgressConsole | Console | null | undefined,
  debug: boolean,
  index: number,
  total: number,
  asset: TraceablePageAsset,
  startMs: number
): void {
  if (!debug || !console || !console.log) return;
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
export function logPhaseStart(
  console: ProgressConsole | Console | null | undefined,
  debug: boolean,
  label: string
): PhaseHandle {
  const log = console?.log;
  if (!debug || !log) {
    const start = Date.now();
    return {
      end() {
        return Date.now() - start;
      },
    };
  }
  const start = Date.now();
  log(`[subfont timing] → ${label}...`);
  return {
    end(extraInfo) {
      const ms = Date.now() - start;
      const suffix = extraInfo ? ` (${extraInfo})` : '';
      log(`[subfont timing] ← ${label}: ${ms}ms${suffix}`);
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
export function makePhaseTracker(
  console: ProgressConsole | Console | null | undefined,
  debug: boolean
): (label: string) => PhaseHandle {
  return (label: string) => logPhaseStart(console, debug, label);
}
