// -----------------------------------------------------------------------------
// The browser plumbing, driven for real against a stand-in portal (see
// test/helpers/fakePortal.js): sign in, reach the history, press the export
// button, read the `data:` URI out of the DOM.
//
// This does NOT prove the selectors still match the real SEDIF portal — only a
// run against the live site with real credentials can do that. It proves the
// mechanics around them: that we fill the right inputs, that a refused login is
// reported as such instead of hanging, and that the export is decoded intact.
//
// Skipped when no Chromium is installed, so the suite still runs on a machine
// that only has Node (CI installs one, see .github/workflows/ci.yml).
// -----------------------------------------------------------------------------

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { normalizeConfig } from '../src/config.js';
import { startFakePortal } from './helpers/fakePortal.js';

const CSV = [
  'Date;Index;Consommation;Methode',
  '2026-08-07 00:00:00;1234300;150;Estimé',
  '2026-08-08 00:00:00;1234414;114;Mesuré',
].join('\n');

/** First Chromium we can find: the distro one, or a Playwright download. */
function findChromium() {
  const distro = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium', // what the Docker image installs
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ]
    .filter(Boolean)
    .find((candidate) => existsSync(candidate));
  if (distro) {
    return distro;
  }
  try {
    // `npx playwright-core install chromium` (what CI runs) puts it in a
    // versioned cache directory only Playwright knows about.
    const bundled = chromium.executablePath();
    return existsSync(bundled) ? bundled : null;
  } catch {
    return null;
  }
}

const chromiumPath = findChromium();
const skip = chromiumPath ? false : 'no Chromium available on this machine';

let portal;
let downloadHistoryCsv;
let PortalError;

before(async () => {
  if (skip) {
    return;
  }
  process.env.CHROMIUM_PATH = chromiumPath;
  // The driver reads SEDIF_LOGIN_URL at import time, so the stand-in portal
  // has to be up and the variable set before the module is loaded.
  portal = await startFakePortal({ csv: CSV });
  process.env.SEDIF_LOGIN_URL = portal.loginUrl;
  ({ downloadHistoryCsv, PortalError } = await import('../src/sedif/portal.js'));
});

after(async () => {
  await portal?.close();
  delete process.env.SEDIF_LOGIN_URL;
});

test('signs in and brings back the export, byte for byte', { skip }, async () => {
  const config = normalizeConfig({ email: 'user@example.com', password: 'secret' });
  const csv = await downloadHistoryCsv(config);
  assert.equal(csv, CSV);
});

test('types the credentials into the right inputs', { skip }, async () => {
  // The stand-in portal echoes what it received into the dashboard page, and
  // the history page is reached from there: getting the export back at all
  // means the form was filled and submitted, not merely rendered.
  const config = normalizeConfig({ email: 'someone@example.com', password: 'hunter2' });
  const csv = await downloadHistoryCsv(config);
  assert.match(csv, /1234414/);
});

test('follows the contract link of a multi-contract account', { skip }, async () => {
  const multi = await startFakePortal({ csv: CSV, contract: '7654321' });
  try {
    process.env.SEDIF_LOGIN_URL = multi.loginUrl;
    const config = normalizeConfig({
      email: 'user@example.com',
      password: 'secret',
      contract: '7654321',
      history_url: multi.historyUrl,
    });
    assert.equal(await downloadHistoryCsv(config), CSV);
  } finally {
    process.env.SEDIF_LOGIN_URL = portal.loginUrl;
    await multi.close();
  }
});

test('reports a refused login instead of timing out silently', { skip }, async () => {
  const refusing = await startFakePortal({ csv: CSV, rejectLogin: true });
  try {
    process.env.SEDIF_LOGIN_URL = refusing.loginUrl;
    const config = normalizeConfig({ email: 'user@example.com', password: 'wrong' });
    await assert.rejects(
      () => downloadHistoryCsv(config),
      (err) => {
        assert.ok(err instanceof PortalError);
        assert.equal(err.code, 'LOGIN_REFUSED');
        assert.match(err.message, /identifiant ou votre mot de passe/);
        return true;
      },
    );
  } finally {
    process.env.SEDIF_LOGIN_URL = portal.loginUrl;
    await refusing.close();
  }
});
