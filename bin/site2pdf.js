#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { main } from '../dist/index.js';

const argv = yargs(hideBin(process.argv))
  .usage('Usage: $0 <url> [url-pattern] [options]')
  .positional('urlPattern', {
    type: 'string',
    description: 'Regex pattern to match URLs for processing'
  })
  .option('separate', {
    alias: 's',
    type: 'boolean',
    description: 'Generate separate PDFs for each page'
  })
  .option('output', {
    alias: 'o',
    type: 'string',
    description: 'Output path for PDF file(s)',
    default: './out'
  })
  .help()
  .alias('help', 'h')
  .parse();

main(argv._[0], argv.urlPattern, {
  separate: argv.separate,
  outputPath: argv.output
});
