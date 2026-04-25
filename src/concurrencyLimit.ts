import os = require('os');

// Approximate memory footprint of each worker thread (jsdom + font-tracer).
export const WORKER_MEMORY_BYTES = 50 * 1024 * 1024; // 50 MB

export function getMaxConcurrency(): number {
  const byMemory = Math.floor(os.freemem() / WORKER_MEMORY_BYTES);
  // Font tracing is CPU-bound (not I/O), so match the pool size to the
  // core count directly — no multiplier.
  const byCpu = os.cpus().length;
  return Math.max(1, Math.min(byMemory, byCpu));
}
