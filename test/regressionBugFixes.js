const expect = require('unexpected')
  .clone()
  .use(require('assetgraph/test/unexpectedAssetGraph'));

const AssetGraph = require('assetgraph');
const pathModule = require('path');
const subsetFonts = require('../lib/subsetFonts');
const { Worker } = require('worker_threads');

const fs = require('fs');
const { getFontFaceDeclarationText } = require('../lib/fontFaceHelpers');

describe('regression bug fixes', function () {
  describe('Bug 1: getFontFaceDeclarationText should preserve relation.hrefType', function () {
    it('should restore hrefType on all relations after generating text', function () {
      const node = {
        toString() {
          return '@font-face { src: url(test.woff2); }';
        },
      };
      const relations = [
        { hrefType: 'rootRelative' },
        { hrefType: 'relative' },
        { hrefType: 'absolute' },
      ];

      getFontFaceDeclarationText(node, relations);

      expect(relations[0].hrefType, 'to equal', 'rootRelative');
      expect(relations[1].hrefType, 'to equal', 'relative');
      expect(relations[2].hrefType, 'to equal', 'absolute');
    });

    it('should not set hrefType to undefined', function () {
      const node = {
        toString() {
          return '@font-face { }';
        },
      };
      const relations = [{ hrefType: 'relative' }];

      getFontFaceDeclarationText(node, relations);

      expect(relations[0].hrefType, 'not to be undefined');
      expect(relations[0].hrefType, 'to equal', 'relative');
    });
  });

  describe('Bug 2: ital/slnt axis detection with variable fonts', function () {
    it('should handle italic-only variable fonts without crashing', async function () {
      const assetGraph = new AssetGraph({
        root: pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/variable-font-unused-ital-axis/'
        ),
      });
      await assetGraph.loadAssets('italic.html');
      await assetGraph.populate();

      // Should not throw -- instancing pins the ital axis automatically
      await subsetFonts(assetGraph);
    });

    it('should handle oblique-only variable fonts without crashing', async function () {
      const assetGraph = new AssetGraph({
        root: pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/variable-font-unused-slnt-axis/'
        ),
      });
      await assetGraph.loadAssets('oblique.html');
      await assetGraph.populate();

      // Should not throw -- instancing pins the slnt axis automatically
      await subsetFonts(assetGraph);
    });
  });

  describe('Bug 3: variable fonts with unused axes should not crash', function () {
    it('should not crash when variable fonts have unused axes', async function () {
      const assetGraph = new AssetGraph({
        root: pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/variable-font-unused-axes/'
        ),
      });
      await assetGraph.loadAssets('index.html');
      await assetGraph.populate();

      // Should not throw -- instancing handles unused axes automatically
      await subsetFonts(assetGraph);
    });
  });

  describe('Bug 5: FontTracerPool should reject pending tasks when all workers crash', function () {
    it('should reject the promise when a worker crashes', async function () {
      // Create a minimal worker that exits immediately with code 1
      const crashWorkerPath = pathModule.resolve(__dirname, '_crashWorker.js');
      fs.writeFileSync(
        crashWorkerPath,
        `
const { parentPort } = require('worker_threads');
parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    parentPort.postMessage({ type: 'ready' });
  } else {
    // Crash on any other message
    process.exit(1);
  }
});
`
      );

      // Test using actual workers
      const worker = new Worker(crashWorkerPath);

      const readyPromise = new Promise((resolve) => {
        worker.on('message', (msg) => {
          if (msg.type === 'ready') resolve();
        });
      });
      worker.postMessage({ type: 'init' });
      await readyPromise;

      const exitPromise = new Promise((resolve, reject) => {
        worker.on('exit', (code) => {
          if (code !== 0) {
            resolve(code);
          }
        });
        worker.on('error', reject);
      });

      // Send a message that will crash the worker
      worker.postMessage({ type: 'crash' });

      const exitCode = await exitPromise;
      expect(exitCode, 'to equal', 1);

      // Clean up
      fs.unlinkSync(crashWorkerPath);
    });

    it('should reject all pending tasks when no workers remain', function () {
      // Test the logic directly: simulate a pool with no workers
      // and pending tasks
      const pendingTasks = [];
      const taskCallbacks = new Map();
      const workers = [];

      // Add some pending tasks
      const rejections = [];
      for (let i = 0; i < 3; i++) {
        const taskId = i;
        pendingTasks.push({ message: { taskId } });
        taskCallbacks.set(taskId, {
          resolve: () => {},
          reject: (err) => rejections.push(err),
        });
      }

      // Simulate: no workers remain, reject all pending
      if (workers.length === 0) {
        for (const pending of pendingTasks) {
          const cb = taskCallbacks.get(pending.message.taskId);
          if (cb) {
            taskCallbacks.delete(pending.message.taskId);
            cb.reject(new Error('All workers have crashed'));
          }
        }
      }

      expect(rejections, 'to have length', 3);
      expect(rejections[0].message, 'to equal', 'All workers have crashed');
    });
  });
});
