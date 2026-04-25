import pathModule = require('path');
import { Worker } from 'worker_threads';

const workerPath = pathModule.join(__dirname, 'fontConverterWorker.js');

interface WorkerMessage {
  type: 'result' | 'error';
  buffer?: Uint8Array | Buffer;
  error?: string;
}

export function convert(
  buffer: Buffer | Uint8Array,
  targetFormat: string,
  sourceFormat?: string
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const worker = new Worker(workerPath);
    worker.on('message', (msg: WorkerMessage) => {
      worker.terminate();
      if (msg.type === 'result' && msg.buffer) {
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
