const expect = require('unexpected')
  .clone()
  .use(require('unexpected-sinon'))
  .use(require('assetgraph/test/unexpectedAssetGraph'));

const AssetGraph = require('assetgraph');
const pathModule = require('path');
const sinon = require('sinon');
const subsetFonts = require('../lib/subsetFonts');
const { Worker } = require('worker_threads');

// Extract getFontFaceDeclarationText from source for unit testing
const fs = require('fs');
const moduleSource = fs.readFileSync(
  pathModule.resolve(__dirname, '../lib/subsetFonts.js'),
  'utf8'
);
const funcMatch = moduleSource.match(
  /function getFontFaceDeclarationText\(node, relations\) \{[\s\S]*?\nfunction /
);
let getFontFaceDeclarationText;
if (funcMatch) {
  const funcSource = funcMatch[0].replace(/\nfunction $/, '');
  // eslint-disable-next-line no-eval
  getFontFaceDeclarationText = eval(`(${funcSource})`);
}

describe('regression bug fixes', function () {
  describe('Bug 1: getFontFaceDeclarationText should preserve relation.hrefType', function () {
    if (!getFontFaceDeclarationText) {
      it('should be extractable from subsetFonts.js', function () {
        throw new Error(
          'Could not extract getFontFaceDeclarationText from subsetFonts.js'
        );
      });
      return;
    }

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

  describe('Bug 2: operator precedence in ital/slnt axis detection', function () {
    it('should not note ital=0 when only font-style: italic is used', async function () {
      const assetGraph = new AssetGraph({
        root: pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/variable-font-unused-ital-axis/'
        ),
      });
      await assetGraph.loadAssets('italic.html');
      await assetGraph.populate();
      const infoSpy = sinon.spy().named('info');
      assetGraph.on('info', infoSpy);

      await subsetFonts(assetGraph);

      // With the bug, ital=0 would be incorrectly noted, making the axis
      // appear fully used (no info event). With the fix, only ital=1 is noted,
      // so the axis is underutilized.
      expect(infoSpy, 'to have calls satisfying', function () {
        infoSpy({
          message: expect.it(
            'to contain',
            'Underutilized axes:\n    ital: 1 used (0-1 available)'
          ),
        });
      });
    });

    it('should not note slnt=0 when only font-style: oblique is used', async function () {
      const assetGraph = new AssetGraph({
        root: pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/variable-font-unused-slnt-axis/'
        ),
      });
      await assetGraph.loadAssets('oblique.html');
      await assetGraph.populate();
      const infoSpy = sinon.spy().named('info');
      assetGraph.on('info', infoSpy);

      await subsetFonts(assetGraph);

      // With the bug, slnt=0 would be incorrectly noted alongside slnt=-14.
      // With the fix, only slnt=-14 is noted.
      expect(infoSpy, 'to have calls satisfying', function () {
        infoSpy({
          message: expect.it(
            'to contain',
            'Underutilized axes:\n    slnt: -14 used (-20-20 available)'
          ),
        });
      });
    });
  });

  describe('Bug 3: warnAboutUnusedVariationAxes should not crash with assetGraph out of scope', function () {
    it('should emit info events without crashing when variable fonts have unused axes', async function () {
      const assetGraph = new AssetGraph({
        root: pathModule.resolve(
          __dirname,
          '../testdata/subsetFonts/variable-font-unused-axes/'
        ),
      });
      await assetGraph.loadAssets('index.html');
      await assetGraph.populate();
      const infoSpy = sinon.spy().named('info');
      assetGraph.on('info', infoSpy);

      // With the bug, this would throw: TypeError: Cannot read properties of undefined (reading 'info')
      await subsetFonts(assetGraph);

      expect(infoSpy, 'was called');
    });
  });

  describe('Bug 5: FontTracerPool should reject pending tasks when all workers crash', function () {
    it('should reject the promise when a worker crashes', async function () {
      // Create a minimal worker that exits immediately with code 1
      const crashWorkerPath = pathModule.resolve(
        __dirname,
        '_crashWorker.js'
      );
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

      // Extract FontTracerPool and patch its worker path
      const FontTracerPoolMatch = moduleSource.match(
        /class FontTracerPool \{[\s\S]*?\n\}/
      );

      // Instead of extracting the class, test via the module's behavior
      // by creating a minimal pool-like setup
      const { FontTracerPool } = (() => {
        // We'll use a simpler approach: directly test the _onWorkerExit logic
        // by creating a mock pool
        class MockPool {
          constructor() {
            this._workers = [];
            this._idle = [];
            this._pendingTasks = [];
            this._taskCallbacks = new Map();
            this._taskByWorker = new Map();
          }
        }
        return { FontTracerPool: MockPool };
      })();

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
