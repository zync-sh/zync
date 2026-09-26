#!/usr/bin/env node
import { validatePackageDirectory } from '../validate.js';

const [command, directory, ...extra] = process.argv.slice(2);
const withVersion = extra.length === 2 && extra[0] === '--zync-version';
if (command !== 'validate' || !directory || (extra.length && !withVersion)) {
  console.error('Usage: zync-plugin validate <plugin-directory> [--zync-version <version>]');
  process.exitCode = 2;
} else {
  try {
    const result = validatePackageDirectory(directory, withVersion ? { zyncVersion: extra[1] } : {});
    for (const issue of result.issues) {
      const stream = issue.severity === 'error' ? process.stderr : process.stdout;
      stream.write(`${issue.severity}: ${issue.path}: ${issue.message}\n`);
    }
    if (result.valid) console.log('Plugin preflight passed. Zync will validate again at install time.');
    else process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
