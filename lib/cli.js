#!/usr/bin/env node

const { yargs, help, ...options } = require('./parseCommandLineOptions')();

require('@gustavnikolaj/async-main-wrap')(require('./subfont'), {
  processError(err) {
    yargs.showHelp();
    if (err.name === 'UsageError') {
      // Avoid rendering a stack trace for the wrong usage errors
      err.customOutput = err.message;
    }
    return err;
  },
})(options, console);
