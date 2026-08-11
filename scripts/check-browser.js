// -----------------------------------------------------------------------------
// Build-time (and support-time) check: is the browser the code asks for really
// in the image, at the path Playwright will resolve?
//
// Twice now, an image built fine and only failed on the user's box, minutes
// after startup, deep inside a refresh — once with a distro Chromium Playwright
// could not drive, once with the full browser installed while the code asked
// for the headless shell. Both are pure packaging mistakes, and both are
// visible the moment the image is built. This script makes the Docker build
// fail instead.
//
// It deliberately does NOT launch the browser: the arm64 image is built under
// QEMU emulation, where starting Chromium is slow and unreliable. Resolving
// the path through Playwright's own logic and checking the file is executable
// catches the packaging mistakes without that fragility.
// -----------------------------------------------------------------------------

import { accessSync, constants, statSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { launchOptions } from '../src/sedif/portal.js';

const { channel, executablePath } = launchOptions();

let resolved = executablePath;
if (!resolved) {
  try {
    resolved = chromium.executablePath({ channel });
  } catch (err) {
    fail(`Playwright cannot resolve the "${channel}" browser: ${err.message.split('\n')[0]}`);
  }
}

try {
  if (!statSync(resolved).isFile()) {
    fail(`${resolved} is not a file`);
  }
  accessSync(resolved, constants.X_OK);
} catch (err) {
  fail(
    `the browser is missing or not executable at ${resolved} (${err.code ?? err.message}). ` +
      'The image must run `playwright-core install --no-shell chromium` with the same ' +
      'PLAYWRIGHT_BROWSERS_PATH it uses at runtime.',
  );
}

console.log(`Browser OK: channel "${channel}" resolves to ${resolved}`);

function fail(message) {
  console.error(`Browser check failed: ${message}`);
  process.exit(1);
}
