const { parentPort } = require('worker_threads');
const fontverter = require('fontverter');

parentPort.on('message', async (msg) => {
  try {
    const buffer = Buffer.from(msg.buffer);
    const result = await fontverter.convert(
      buffer,
      msg.targetFormat,
      msg.sourceFormat
    );
    parentPort.postMessage({ type: 'result', buffer: result });
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err.message });
  }
});
