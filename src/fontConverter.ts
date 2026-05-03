import pathModule = require('path');
import { Worker } from 'worker_threads';

const workerPath = pathModule.join(__dirname, 'fontConverterWorker.js');
const CONVERT_TIMEOUT_MS = 120_000;

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
    let settled = false;
    const worker = new Worker(workerPath);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        worker.terminate();
        reject(
          new Error(
            `Font conversion to ${targetFormat} timed out after ${CONVERT_TIMEOUT_MS}ms`
          )
        );
      }
    }, CONVERT_TIMEOUT_MS);
    timer.unref();

    worker.on('message', (msg: WorkerMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (msg.type === 'result' && msg.buffer) {
        resolve(Buffer.from(msg.buffer));
      } else {
        reject(
          new Error(msg.error || `Font conversion to ${targetFormat} failed`)
        );
      }
    });
    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      reject(err);
    });
    worker.postMessage({ buffer, targetFormat, sourceFormat });
  });
}
