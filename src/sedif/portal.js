// -----------------------------------------------------------------------------
// Driver of the L'Eau d'Ile-de-France (SEDIF / Veolia) customer portal.
//
// WHY A BROWSER, AND NOT AN HTTP CLIENT
// The SEDIF and its operator publish no API for consumption data. The customer
// portal is a Salesforce Experience Cloud site: everything on the Historique
// page is rendered by Lightning components and fetched through opaque, signed
// Aura payloads whose descriptors change with every site release. Every
// working community tool (MetersToHA, veolia-idf, PyVeoliaIDF) therefore drives
// a real browser, and so do we — the alternative would be a hand-forged Aura
// protocol that breaks silently on the next deploy.
//
// The one nicety the portal offers: the "Telecharger la periode" button does
// not hit the network, it builds the CSV client-side and exposes it as a
// `data:` URI on a hidden `<a download>`. We read that attribute instead of
// waiting for a file to land on disk — which matters here, because the Gladys
// sandbox mounts the container rootfs READ-ONLY.
//
// SELECTORS
// The selectors below are the ones a working, maintained tool uses against the
// same pages (see docs/fr.md). They are the fragile part of this integration:
// they are all grouped here, and `history_url` lets a user pin the history page
// without waiting for a new release.
// -----------------------------------------------------------------------------

import { tmpdir } from 'node:os';
import { createLogger } from '@gladysassistant/integration-sdk';
import { chromium } from 'playwright-core';

const logger = createLogger({ name: 'portal' });

export const DEFAULT_LOGIN_URL = 'https://connexion.leaudiledefrance.fr/s/login/';

/**
 * Where the sign-in form lives. The portal has already moved twice
 * (espace-client.vedif.eau.veolia.fr, then rock-vedif.my.site.com, now
 * connexion.leaudiledefrance.fr), so `SEDIF_LOGIN_URL` is the escape hatch for
 * the next move — and what the tests point at a stand-in portal.
 */
export function loginUrl() {
  return process.env.SEDIF_LOGIN_URL || DEFAULT_LOGIN_URL;
}

// Name the portal gives to the daily export; also how we find the hidden link.
export const DOWNLOAD_FILENAME = 'historique_jours_litres.csv';

// The portal is slow, and a cold Lightning page is slower still — but every
// second spent waiting is a second of Chromium sitting on a home server's CPU,
// so these are tight enough to fit inside the deadlines below.
const NAVIGATION_TIMEOUT_MS = 45_000;
const STEP_TIMEOUT_MS = 20_000;

/** Whole-session budget, beyond which the browser is killed no matter what. */
export const DEFAULT_DEADLINE_MS = 180_000;

// Resource types the CSV does not need. A Salesforce app pulls megabytes of
// images and webfonts; decoding them is pure CPU burnt on a box that has other
// things to do, on a page nobody will ever look at.
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font']);

// ONE browser at a time, integration-wide. Without this, the scheduled refresh
// and an impatient click on "Tester la connexion" each start a full Chromium;
// a few of those together are enough to bring a small home server to its knees.
let sessionInFlight = false;

/**
 * Sign in and bring back the raw daily consumption CSV.
 *
 * @param {object} config normalized integration configuration
 * @param {object} [deps] injection seam for the tests
 * @param {() => Promise<import('playwright-core').Browser>} [deps.launchBrowser]
 * @param {number} [deps.deadlineMs] whole-session budget
 * @returns {Promise<string>} the CSV content
 */
export async function downloadHistoryCsv(config, deps = {}) {
  const launchBrowser = deps.launchBrowser ?? defaultLaunchBrowser;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;

  if (sessionInFlight) {
    throw new PortalError(
      'SESSION_BUSY',
      'A portal session is already running; wait for it to finish before starting another',
    );
  }
  sessionInFlight = true;

  // Kept outside the deadline race so the browser can still be disposed of when
  // the deadline fires while the launch itself is what is stuck.
  let browserPromise = null;

  const started = Date.now();
  logger.info(`Starting a portal session (deadline ${Math.round(deadlineMs / 1000)} s)`);

  try {
    return await withDeadline(runSession(), deadlineMs);
  } finally {
    sessionInFlight = false;
    // Fire and forget: on the deadline path we must not wait on a promise that
    // may never settle, but we must not leak the browser either.
    browserPromise
      ?.then((browser) => browser.close())
      .catch((err) => logger.warn(`Closing the browser failed: ${err.message}`));
    logger.info(`Portal session finished in ${Math.round((Date.now() - started) / 1000)} s`);
  }

  // EVERYTHING lives in here, launch included. An earlier version only put the
  // page steps under the deadline, and a launch that never came back held the
  // session lock forever: the button hit the 120 s ack timeout with not one log
  // line to show for it, and the refreshes after it were all "postponed".
  async function runSession() {
    logger.info('Launching the browser...');
    browserPromise = launchBrowser();
    const browser = await browserPromise;
    logger.info(`Browser up after ${Date.now() - started} ms`);

    const context = await browser.newContext({
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      viewport: { width: 1280, height: 800 },
    });
    context.setDefaultTimeout(STEP_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    await context.route('**/*', (route) =>
      BLOCKED_RESOURCES.has(route.request().resourceType()) ? route.abort() : route.continue(),
    );

    const page = await context.newPage();
    try {
      await signIn(page, config);
      await openHistoryPage(page, config);
      return await readCsvFromPage(page);
    } finally {
      // Release the browser on the normal paths; the outer `finally` is only
      // the safety net for the deadline.
      await browser.close().catch(() => {});
    }
  }
}

/** Reject with a PortalError once `ms` has passed, whatever `promise` is doing. */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new PortalError(
            'DEADLINE_EXCEEDED',
            `The portal did not answer within ${Math.round(ms / 1000)} s`,
          ),
        ),
      ms,
    );
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Test seam: the session lock is module state and must not leak between tests. */
export function resetSessionLock() {
  sessionInFlight = false;
}

/** Sign in with the credentials of the account, unless already signed in. */
async function signIn(page, config) {
  logger.info(`Opening ${loginUrl()}`);
  await page.goto(loginUrl(), { waitUntil: 'domcontentloaded' });

  // The portal either shows the login form, or the avatar of a live session.
  await page.waitForSelector('input[type="password"], .profileIcon');

  if ((await page.locator('.profileIcon').count()) > 0) {
    logger.info('Session already open, skipping the login form');
    return;
  }

  logger.info('Filling the login form');
  await page.locator('input[inputmode="email"]').first().fill(config.email);
  await page.locator('input[type="password"]').first().fill(config.password);
  await page.locator('.submit-button').first().click();

  // A wrong password leaves us on the same form with an error banner; a good
  // one lands on the dashboard, whose header carries the avatar.
  const outcome = await Promise.race([
    page
      .waitForSelector('.profileIcon', { timeout: NAVIGATION_TIMEOUT_MS })
      .then(() => 'signed-in'),
    page
      .waitForSelector('.loginError, .form-element__help, [role="alert"]', {
        timeout: NAVIGATION_TIMEOUT_MS,
      })
      .then(() => 'error'),
  ]).catch(() => 'timeout');

  if (outcome === 'error') {
    const message = await page
      .locator('.loginError, .form-element__help, [role="alert"]')
      .first()
      .innerText()
      .catch(() => '');
    throw new PortalError('LOGIN_REFUSED', message.trim() || 'The portal refused the credentials');
  }
  if (outcome === 'timeout') {
    throw new PortalError('LOGIN_TIMEOUT', 'The portal did not answer the login within 60 s');
  }

  logger.info('Signed in');
}

/** Navigate to the daily history, in litres. */
async function openHistoryPage(page, config) {
  const target = config.history_url || historyUrlFrom(page.url());
  logger.info(`Opening the history page: ${target}`);
  await page.goto(target, { waitUntil: 'domcontentloaded' });

  if (config.contract) {
    await selectContract(page, config.contract);
  }

  // The history is rendered by two toggles: the unit (Litres / m3) and the
  // granularity (Jours / Mois). We want litres per day, whatever the portal
  // remembered from the last visit.
  await clickByText(page, 'Litres', { optional: true });
  await clickByText(page, 'Jours', { optional: true });
}

/**
 * On a multi-contract account, the history opens on the contract picker.
 * Single-contract accounts go straight to the chart, so a missing link is not
 * an error.
 */
async function selectContract(page, contract) {
  const link = page.locator(`a:has-text("${contract}")`).first();
  if ((await link.count()) === 0) {
    logger.debug(`No link for contract ${contract}, assuming a single-contract account`);
    return;
  }
  logger.info(`Selecting contract ${contract}`);
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await page.waitForLoadState('domcontentloaded');
}

/**
 * Press "Telecharger la periode" and read the CSV out of the `data:` URI the
 * portal attaches to the hidden download link.
 */
async function readCsvFromPage(page) {
  logger.info('Requesting the export of the displayed period');
  const downloadButton = page.locator('button', { hasText: /charger la p/i }).first();
  await downloadButton.waitFor({ state: 'visible' });
  await downloadButton.click();

  const link = page.locator(`a[download="${DOWNLOAD_FILENAME}"]`).first();
  await link.waitFor({ state: 'attached' });
  const href = await link.getAttribute('href');

  if (!href) {
    throw new PortalError('EXPORT_MISSING', 'The export link carries no data');
  }

  const csv = decodeDataUri(href);
  logger.info(`Export read: ${csv.length} characters`);
  return csv;
}

/**
 * Decode the `data:text/csv;...` URI the portal builds client-side. Both the
 * base64 and the percent-encoded forms have been observed.
 */
export function decodeDataUri(href) {
  const match = href.match(/^data:([^,]*),([\s\S]*)$/);
  if (!match) {
    throw new PortalError('EXPORT_MISSING', 'The export link is not a data URI');
  }
  const [, meta, payload] = match;
  if (/;base64/i.test(meta)) {
    return Buffer.from(payload, 'base64').toString('utf8');
  }
  return decodeURIComponent(payload);
}

/** Click the first element whose text matches, tolerating its absence. */
async function clickByText(page, text, { optional = false } = {}) {
  const locator = page.locator(`button, a, span`, {
    hasText: new RegExp(`^\\s*${text}\\s*$`, 'i'),
  });
  const count = await locator.count();
  if (count === 0) {
    if (optional) {
      logger.debug(`Control "${text}" not found, continuing`);
      return;
    }
    throw new PortalError('CONTROL_MISSING', `The portal has no "${text}" control any more`);
  }
  logger.debug(`Clicking "${text}"`);
  await locator.first().click();
  // The Lightning chart re-renders asynchronously after each toggle.
  await page.waitForTimeout(1500);
}

/**
 * The history page, relative to wherever the login landed. Which space the
 * account belongs to is only known after signing in (`/particuliers/s/`,
 * `/espace-bailleurs-syndics/s/`...), so the path is derived rather than
 * hard-coded. The query string of the landing URL carries session noise and is
 * dropped — appending to it would produce a nonsense URL.
 */
export function historyUrlFrom(currentUrl) {
  const base = new URL(currentUrl);
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/')) {
    base.pathname += '/';
  }
  return new URL('historique', base).toString();
}

/**
 * Options used to launch the browser. Exported so a test can pin them down:
 * getting this object wrong is what makes the integration fail before it even
 * reaches the portal.
 */
export function launchOptions() {
  return {
    // The headless shell, explicitly. It pairs with `--only-shell` in the
    // Dockerfile: the channel names the binary, and naming it is what keeps
    // the code and the image from drifting apart (`headless: true` alone
    // resolves the shell, but silently, which is how they drifted before).
    //
    // The shell over the full browser is a deliberate downgrade: measured
    // here, it starts 3 to 5 times faster and takes 274 MB less on disk, and
    // on the box this actually runs on the FULL browser needed 42 s just to
    // start. Fidelity to a real visitor is worth little on a machine that
    // cannot afford the browser at all.
    channel: 'chromium-headless-shell',
    // Playwright's own launch budget. Generous, because a loaded home server
    // starts Chromium slowly — but never unbounded, and always shorter than
    // the session deadline that wraps it.
    timeout: 60_000,
    // Overrides the binary for a local run. A DISTRO Chromium is NOT
    // interchangeable with Playwright's: their versions must match, or the
    // launch dies with a crashpad error and "Target page, context or browser
    // has been closed". The image ships Playwright's own build and sets no
    // CHROMIUM_PATH; when it is set, it wins over the channel.
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: [
      // The Gladys sandbox is the security boundary here; Chromium's own
      // sandbox needs privileges the integration container does not get.
      '--no-sandbox',
      // /dev/shm is tiny in a container; without this Chromium crashes on the
      // first heavy page.
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      // This runs on a home server that has better things to do. Nobody will
      // ever look at this page: decoding its images is pure wasted CPU, and
      // one renderer is plenty for a single tab.
      '--blink-settings=imagesEnabled=false',
      '--renderer-process-limit=1',
      // The rootfs is read-only: the crash handler must not try to open its
      // database under a path it cannot create.
      `--crash-dumps-dir=${tmpdir()}`,
    ],
    // The throw-away profile Playwright creates for each launch also has to
    // land on the writable volume; Playwright derives it from TMPDIR, which
    // `ensureStateDir()` points at /data (see src/storage.js). Passing
    // --user-data-dir here instead is rejected by Playwright.
  };
}

/** Launch the Chromium the image installed (see the Dockerfile). */
async function defaultLaunchBrowser() {
  try {
    return await chromium.launch(launchOptions());
  } catch (err) {
    // The raw Playwright message is genuinely useful (it names the path it
    // looked at), so keep it and add what to do about it.
    throw new PortalError(
      'BROWSER_UNAVAILABLE',
      `Cannot start the browser: ${err.message.split('\n')[0]}. ` +
        'The image must ship the Chromium matching its playwright-core version ' +
        '(see the Dockerfile).',
    );
  }
}

/** An error the user can act on: the message ends up under the action button. */
export class PortalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PortalError';
    this.code = code;
  }
}
