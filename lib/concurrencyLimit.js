const os = require('os');

// Approximate memory footprint of each worker thread (jsdom + font-tracer).
const WORKER_MEMORY_BYTES = 50 * 1024 * 1024; // 50 MB

function getMaxConcurrency() {
  const byMemory = Math.floor(os.freemem() / WORKER_MEMORY_BYTES);
  const byCpu = os.cpus().length * 4;
  return Math.max(1, Math.min(byMemory, byCpu));
}

module.exports = { WORKER_MEMORY_BYTES, getMaxConcurrency };
