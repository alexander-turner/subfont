const os = require('os');

// Approximate memory footprint of each worker thread (jsdom + font-tracer).
const WORKER_MEMORY_BYTES = 50 * 1024 * 1024; // 50 MB

function getMaxConcurrency() {
  return Math.max(1, Math.floor(os.totalmem() / WORKER_MEMORY_BYTES));
}

module.exports = { WORKER_MEMORY_BYTES, getMaxConcurrency };
