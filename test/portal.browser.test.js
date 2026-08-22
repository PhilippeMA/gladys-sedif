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
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { normalizeConfig } from '../src/config.js';
import { startFakePortal } from './helpers/fakePortal.js';

// Diagnostics land on the state volume; keep the tests out of a real /data.
process.env.GLADYS_SEDIF_STATE_DIR = await mkdtemp(path.join(tmpdir(), 'gladys-sedif-browser-'));

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

test('names an unreachable portal instead of timing out in the browser', { skip }, async () => {
  // A container with no route out reported this 45 s later as
  // "page.goto: Timeout exceeded", which reads like a portal problem and sends
  // you hunting selectors. The pre-flight names the transport failure in a
  // second, and before paying for a browser.
  const { assertPortalReachable } = await import('../src/sedif/portal.js');

  // A port nothing listens on: connection refused, the clearest kind of "no".
  await assert.rejects(
    () => assertPortalReachable('http://127.0.0.1:1/s/login/', 2000),
    (err) => {
      assert.equal(err.code, 'PORTAL_UNREACHABLE');
      assert.match(err.message, /refused the connection/);
      return true;
    },
  );

  // A name that cannot resolve is named as a DNS problem, not a vague one.
  await assert.rejects(
    () => assertPortalReachable('https://nonexistent.invalid/s/login/', 5000),
    (err) => {
      assert.equal(err.code, 'PORTAL_UNREACHABLE');
      assert.match(err.message, /DNS cannot resolve/);
      return true;
    },
  );

  // The stand-in portal answers, so the same check passes against it.
  await assertPortalReachable(portal.loginUrl, 5000);
});

test('the pre-flight never refuses what the browser would accept', { skip }, async () => {
  // The regression that cost a whole round-trip: the first version did a
  // `fetch()`, and a portal serving an incomplete certificate chain — which
  // browsers repair themselves — was reported as unreachable. The check stops
  // at TCP precisely so it can never be stricter than the browser behind it.
  const { assertPortalReachable } = await import('../src/sedif/portal.js');
  const { createServer } = await import('node:net');

  // A listener that accepts the connection and speaks no TLS whatsoever: any
  // handshake against it fails, exactly as a bad certificate chain would.
  const server = createServer((socket) => socket.resume());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    // `fetch` cannot get through it...
    await assert.rejects(() => fetch(`https://127.0.0.1:${port}/`));

    // ...and the pre-flight passes, because the host IS reachable — which is
    // the only question it is allowed to answer.
    await assertPortalReachable(`https://127.0.0.1:${port}/s/login/`, 5000);
  } finally {
    server.close();
  }
});

test('refuses a second browser while one is already running', { skip }, async () => {
  // The failure this guards against: the 6-hour refresh and an impatient click
  // on "Tester la connexion" each start a full Chromium, and a few of those
  // together bring a small home server down.
  const config = normalizeConfig({ email: 'user@example.com', password: 'secret' });

  const first = downloadHistoryCsv(config);
  await assert.rejects(
    () => downloadHistoryCsv(config),
    (err) => {
      assert.equal(err.code, 'SESSION_BUSY');
      return true;
    },
  );
  assert.equal(await first, CSV);

  // ...and the lock is released, so the next one goes through.
  assert.equal(await downloadHistoryCsv(config), CSV);
});

test('kills the browser when the session outlives its deadline', { skip }, async () => {
  const config = normalizeConfig({ email: 'user@example.com', password: 'secret' });
  await assert.rejects(
    () => downloadHistoryCsv(config, { deadlineMs: 1 }),
    (err) => {
      assert.equal(err.code, 'DEADLINE_EXCEEDED');
      assert.match(err.message, /did not answer within/);
      return true;
    },
  );
  // The browser was closed and the lock released despite the abort.
  assert.equal(await downloadHistoryCsv(config), CSV);
});

test('finds the login form even when it lives in an iframe', { skip }, async () => {
  // `page.locator()` only searches the main frame. A Salesforce site that
  // renders its login in an iframe would look, to the old code, exactly like a
  // page with no password field at all — a false negative on a working portal.
  const framed = await startFakePortal({ csv: CSV, framedLogin: true });
  try {
    process.env.SEDIF_LOGIN_URL = framed.loginUrl;
    const config = normalizeConfig({
      email: 'user@example.com',
      password: 'secret',
      history_url: framed.historyUrl,
    });
    assert.equal(await downloadHistoryCsv(config), CSV);
  } finally {
    process.env.SEDIF_LOGIN_URL = portal.loginUrl;
    await framed.close();
  }
});

test('a failed step leaves a screenshot and says what the page was', { skip }, async () => {
  // A portal that answers but shows no form at all: the error must carry the
  // page's identity, not just "not found".
  const blank = await startFakePortal({ csv: CSV });
  try {
    process.env.SEDIF_LOGIN_URL = `${blank.loginUrl}nope/`;
    const config = normalizeConfig({ email: 'user@example.com', password: 'secret' });

    await assert.rejects(
      () => downloadHistoryCsv(config, { deadlineMs: 60_000 }),
      (err) => {
        assert.equal(err.code, 'LOGIN_FORM_NOT_FOUND');
        // The diagnostics summary is appended to the message the user reads.
        assert.match(err.message, /page ".*" at http/);
        assert.match(err.message, /0 password field\(s\)/);
        return true;
      },
    );

    const { readdir } = await import('node:fs/promises');
    const { DIAGNOSTICS_DIR } = await import('../src/storage.js');
    const files = await readdir(DIAGNOSTICS_DIR());
    assert.ok(
      files.some((f) => f.endsWith('.png')) && files.some((f) => f.endsWith('.html')),
      `expected a screenshot and an HTML dump, got ${files.join(', ')}`,
    );
  } finally {
    process.env.SEDIF_LOGIN_URL = portal.loginUrl;
    await blank.close();
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
