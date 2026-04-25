#!/usr/bin/env node

import parseCommandLineOptions = require('./parseCommandLineOptions');
import asyncMainWrap = require('@gustavnikolaj/async-main-wrap');
import subfont = require('./subfont');

const { yargs, help: _help, ...options } = parseCommandLineOptions();

type ErrorWithCustomOutput = Error & { customOutput?: string };

asyncMainWrap(subfont, {
  processError(err: ErrorWithCustomOutput) {
    yargs.showHelp();
    if (err.name === 'UsageError') {
      err.customOutput = err.message;
    }
    return err;
  },
})(options, console);
