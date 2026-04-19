const os = require('os');

// Approximate memory footprint of each worker thread (jsdom + font-tracer).
const WORKER_MEMORY_BYTES = 50 * 1024 * 1024; // 50 MB

// Hard ceiling prevents runaway thread creation on high-core machines
// (e.g. 256-core ARM servers would otherwise request 1024 workers).
const MAX_CONCURRENCY = 16;

function getMaxConcurrency() {
  const byMemory = Math.floor(os.freemem() / WORKER_MEMORY_BYTES);
  const byCpu = os.cpus().length * 4;
  return Math.max(1, Math.min(byMemory, byCpu, MAX_CONCURRENCY));
}

module.exports = { WORKER_MEMORY_BYTES, MAX_CONCURRENCY, getMaxConcurrency };
