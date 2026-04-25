export interface PhaseHandle {
  end(note?: string | null): number;
}
export interface ProgressConsole {
  log?: (...args: unknown[]) => void;
}
export function makePhaseTracker(
  console: ProgressConsole | Console | undefined | null,
  debug: boolean
): (label: string) => PhaseHandle;
