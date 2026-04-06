function debugLog(console, debug, ...args) {
  if (debug && console) {
    console.log(...args);
  }
}

module.exports = debugLog;
