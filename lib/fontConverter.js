const pathModule = require('path');
const { Worker } = require('worker_threads');

const workerPath = pathModule.join(__dirname, 'fontConverterWorker.js');

function convert(buffer, targetFormat, sourceFormat) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath);
    worker.on('message', (msg) => {
      worker.terminate();
      if (msg.type === 'result') {
        resolve(Buffer.from(msg.buffer));
      } else {
        reject(new Error(msg.error));
      }
    });
    worker.on('error', (err) => {
      worker.terminate();
      reject(err);
    });
    worker.postMessage({ buffer, targetFormat, sourceFormat });
  });
}

module.exports = { convert };
