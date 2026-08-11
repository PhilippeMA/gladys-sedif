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

// The portal is slow, and a cold Lightning page is slower still.
const NAVIGATION_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 30_000;

/**
 * Sign in and bring back the raw daily consumption CSV.
 *
 * @param {object} config normalized integration configuration
 * @param {object} [deps] injection seam for the tests
 * @param {() => Promise<import('playwright-core').Browser>} [deps.launchBrowser]
 * @returns {Promise<string>} the CSV content
 */
export async function downloadHistoryCsv(config, deps = {}) {
  const launchBrowser = deps.launchBrowser ?? defaultLaunchBrowser;

  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      viewport: { width: 1280, height: 1024 },
    });
    context.setDefaultTimeout(STEP_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    const page = await context.newPage();
    await signIn(page, config);
    await openHistoryPage(page, config);
    return await readCsvFromPage(page);
  } finally {
    // Always release the browser: a leaked Chromium would survive every poll
    // and eat the memory of the box within a day.
    await browser.close().catch((err) => logger.warn('Closing the browser failed', err));
  }
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

/** Launch the Chromium shipped in the image (see the Dockerfile). */
async function defaultLaunchBrowser() {
  return chromium.launch({
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
    ],
    // The rootfs is read-only, so the throw-away profile Playwright creates for
    // each launch must land on the writable volume. Playwright derives it from
    // TMPDIR, which `ensureStateDir()` points at /data (see src/storage.js).
    // Passing --user-data-dir here instead is rejected by Playwright.
  });
}

/** An error the user can act on: the message ends up under the action button. */
export class PortalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PortalError';
    this.code = code;
  }
}
