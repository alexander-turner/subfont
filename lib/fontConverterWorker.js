const { parentPort } = require('worker_threads');

let fontverter;

parentPort.on('message', async (msg) => {
  if (msg.type === 'init') {
    try {
      fontverter = require('fontverter');
      parentPort.postMessage({ type: 'ready' });
    } catch (err) {
      parentPort.postMessage({
        type: 'initError',
        error: err.message,
        stack: err.stack,
      });
    }
    return;
  }

  if (msg.type === 'convert') {
    const { taskId, targetFormat, sourceFormat } = msg;
    try {
      const buffer = Buffer.from(msg.buffer);
      const result = await fontverter.convert(
        buffer,
        targetFormat,
        sourceFormat
      );
      parentPort.postMessage({ type: 'result', taskId, buffer: result });
    } catch (err) {
      parentPort.postMessage({
        type: 'error',
        taskId,
        error: err.message,
        stack: err.stack,
      });
    }
  }
});
