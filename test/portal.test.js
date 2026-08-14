// -----------------------------------------------------------------------------
// The browser session itself cannot be unit tested without a portal, but its
// one piece of pure decoding can: the `data:` URI the portal builds in the DOM
// is the only thing standing between the export and the parser.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOGIN_URL,
  DOWNLOAD_FILENAME,
  PortalError,
  decodeDataUri,
  downloadHistoryCsv,
  historyUrlFrom,
  launchOptions,
  resetSessionLock,
} from '../src/sedif/portal.js';
import { normalizeConfig } from '../src/config.js';

const CSV = 'Date;Index;Consommation;Methode\n2026-08-08 00:00:00;1234414;114;Mesuré\n';

test('decodes the base64 form of the export link', () => {
  const href = `data:text/csv;charset=utf-8;base64,${Buffer.from(CSV, 'utf8').toString('base64')}`;
  assert.equal(decodeDataUri(href), CSV);
});

test('decodes the percent-encoded form of the export link', () => {
  const href = `data:text/csv;charset=utf-8,${encodeURIComponent(CSV)}`;
  assert.equal(decodeDataUri(href), CSV);
});

test('keeps the accents of the "Mesuré" column intact', () => {
  const href = `data:text/csv;base64,${Buffer.from(CSV, 'utf8').toString('base64')}`;
  assert.match(decodeDataUri(href), /Mesuré/);
});

test('an href that is not a data URI is reported, not silently parsed', () => {
  assert.throws(() => decodeDataUri('/s/historique'), PortalError);
  assert.throws(() => decodeDataUri('/s/historique'), /not a data URI/);
});

test('the portal entry points are the ones documented for users', () => {
  assert.equal(DEFAULT_LOGIN_URL, 'https://connexion.leaudiledefrance.fr/s/login/');
  assert.equal(DOWNLOAD_FILENAME, 'historique_jours_litres.csv');
});

test('a launch that never returns is bounded, and frees the session lock', async () => {
  // This is what took the integration down: the deadline only covered the page
  // steps, so a browser launch that never came back held the lock forever. The
  // action hit the 120 s ack timeout ("check that the integration is started")
  // with no log line, and every refresh afterwards was "postponed".
  resetSessionLock();
  const config = normalizeConfig({ email: 'user@example.com', password: 'secret' });

  await assert.rejects(
    () =>
      downloadHistoryCsv(config, { launchBrowser: () => new Promise(() => {}), deadlineMs: 50 }),
    (err) => {
      assert.equal(err.code, 'DEADLINE_EXCEEDED');
      return true;
    },
  );

  // The lock is free again: the next attempt fails on its own merits, not on
  // a stale "a session is already running".
  await assert.rejects(
    () =>
      downloadHistoryCsv(config, {
        launchBrowser: () => Promise.reject(new Error('no browser here')),
      }),
    (err) => {
      assert.notEqual(err.code, 'SESSION_BUSY');
      assert.match(err.message, /no browser here/);
      return true;
    },
  );
});

test('a second session is refused while the first is still running', async () => {
  resetSessionLock();
  const config = normalizeConfig({ email: 'user@example.com', password: 'secret' });
  const hanging = downloadHistoryCsv(config, {
    launchBrowser: () => new Promise(() => {}),
    deadlineMs: 300,
  });

  await assert.rejects(
    () => downloadHistoryCsv(config, { launchBrowser: () => new Promise(() => {}) }),
    (err) => {
      assert.equal(err.code, 'SESSION_BUSY');
      return true;
    },
  );

  await assert.rejects(() => hanging);
  resetSessionLock();
});

test('the browser is launched as the full Chromium, not the headless shell', () => {
  // This is what broke in production: `headless: true` alone makes Playwright
  // look for `chromium_headless_shell-<rev>`, a separate binary the image does
  // not install, and the launch fails before reaching the portal. The channel
  // is what selects the full browser the Dockerfile actually ships.
  const options = launchOptions();
  assert.equal(options.channel, 'chromium');
  assert.equal(options.headless, true);
});

test('the browser gets the flags a read-only, shm-less container needs', () => {
  const args = launchOptions().args;
  assert.ok(args.includes('--no-sandbox'), 'the container cannot grant the Chromium sandbox');
  assert.ok(args.includes('--disable-dev-shm-usage'), '/dev/shm is tiny in a container');
  assert.ok(
    args.some((arg) => arg.startsWith('--crash-dumps-dir=')),
    'the crash handler must not write to the read-only rootfs',
  );
  // No --user-data-dir: Playwright rejects it outright in launch().
  assert.ok(!args.some((arg) => arg.startsWith('--user-data-dir')));
});

test('CHROMIUM_PATH overrides the binary, and nothing is forced without it', () => {
  const saved = process.env.CHROMIUM_PATH;
  try {
    process.env.CHROMIUM_PATH = '/somewhere/chrome';
    assert.equal(launchOptions().executablePath, '/somewhere/chrome');

    // Unset: Playwright must be free to resolve the channel itself. An empty
    // string has to behave like "unset", not like a path to nowhere.
    delete process.env.CHROMIUM_PATH;
    assert.equal(launchOptions().executablePath, undefined);
    process.env.CHROMIUM_PATH = '';
    assert.equal(launchOptions().executablePath, undefined);
  } finally {
    if (saved === undefined) {
      delete process.env.CHROMIUM_PATH;
    } else {
      process.env.CHROMIUM_PATH = saved;
    }
  }
});

test('the history page is derived from wherever the login landed', () => {
  assert.equal(
    historyUrlFrom('https://connexion.leaudiledefrance.fr/particuliers/s/'),
    'https://connexion.leaudiledefrance.fr/particuliers/s/historique',
  );
  // Missing trailing slash: the last segment must not be swallowed.
  assert.equal(
    historyUrlFrom('https://connexion.leaudiledefrance.fr/espace-bailleurs-syndics/s'),
    'https://connexion.leaudiledefrance.fr/espace-bailleurs-syndics/s/historique',
  );
  // Session noise in the query string must not end up glued to the path.
  assert.equal(
    historyUrlFrom('https://connexion.leaudiledefrance.fr/s/?tab=accueil#top'),
    'https://connexion.leaudiledefrance.fr/s/historique',
  );
});
