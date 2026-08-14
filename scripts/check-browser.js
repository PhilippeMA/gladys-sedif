// -----------------------------------------------------------------------------
// Build-time (and support-time) check: can the code actually start the browser
// the image installed?
//
// Every browser failure this integration has had was a packaging mistake
// invisible until a refresh ran on the real box, minutes after startup: a
// distro Chromium Playwright could not drive, then the full browser installed
// while the code asked for the headless shell. Both are visible the moment the
// image is built. This script makes the Docker build fail instead.
//
// It really launches, because there is no honest way to ask Playwright "which
// binary would you use": `chromium.executablePath({ channel })` ignores the
// channel and always answers with the full-browser path, so checking that path
// would pass while the launch fails.
//
// The arm64 image is built under QEMU emulation, where starting a browser is
// slow and can fail for reasons that have nothing to do with packaging. So the
// two are told apart: a MISSING executable fails the build, anything else is
// reported as a warning and lets it through.
// -----------------------------------------------------------------------------

import { chromium } from 'playwright-core';
import { launchOptions } from '../src/sedif/portal.js';

const options = launchOptions();

try {
  const browser = await chromium.launch(options);
  console.log(`Browser OK: channel "${options.channel}" launched, version ${browser.version()}`);
  await browser.close();
} catch (err) {
  const message = err.message.split('\n')[0];

  if (/Executable doesn't exist|Please run the following command/i.test(err.message)) {
    console.error(
      `Browser check FAILED: ${message}\n` +
        `The image asks for channel "${options.channel}" but did not install it. ` +
        'The `playwright-core install` line in the Dockerfile and the `channel` in ' +
        'src/sedif/portal.js must name the same browser (--only-shell pairs with ' +
        '"chromium-headless-shell", --no-shell with "chromium").',
    );
    process.exit(1);
  }

  // Present but would not start: real on a QEMU-emulated build, and not
  // something the packaging can fix. Say so loudly, do not block the build.
  console.warn(
    `Browser check WARNING: the executable is installed but did not start here (${message}). ` +
      'Expected when building under emulation; investigate if you see this on a native build.',
  );
}
