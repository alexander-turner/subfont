declare function parseCommandLineOptions(): Record<string, any> & {
  yargs: { showHelp: () => void };
  help: unknown;
};
export = parseCommandLineOptions;
