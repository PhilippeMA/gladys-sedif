// -----------------------------------------------------------------------------
// What the page actually looked like when a step failed.
//
// Every round of debugging so far has cost a full rebuild-and-report cycle,
// because a failure said "selector not found" and nothing about the page it did
// not find it in. A selector is a guess about someone else's HTML: the only way
// to stop guessing is to look.
//
// So a failed session leaves behind a screenshot and the page HTML on the
// writable volume, and puts the headline facts — URL, title, what form fields
// exist, how many frames — straight into the error the user sees. No log
// spelunking, no extra round trip.
// -----------------------------------------------------------------------------

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { DIAGNOSTICS_DIR } from '../storage.js';

const logger = createLogger({ name: 'diagnostics' });

// Enough to see what went wrong twice over, few enough that a stuck
// integration cannot fill the volume.
const KEEP_LAST = 6;

/**
 * Describe the page, and dump it to disk.
 *
 * Never throws: this runs while another error is already on its way up, and
 * losing that error to a diagnostics failure would be the worst outcome.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} label short step name, used in the file names
 * @returns {Promise<string>} a one-line, user-facing summary
 */
export async function capturePageState(page, label) {
  try {
    const [url, title, counts] = await Promise.all([
      Promise.resolve(page.url()),
      page.title().catch(() => '(no title)'),
      countLandmarks(page),
    ]);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(DIAGNOSTICS_DIR(), `${stamp}_${label}`);

    await mkdir(DIAGNOSTICS_DIR(), { recursive: true });
    await Promise.all([
      page.screenshot({ path: `${base}.png`, fullPage: true }).catch((err) => {
        logger.warn(`Screenshot failed: ${err.message}`);
      }),
      page
        .content()
        .then((html) => writeFile(`${base}.html`, html, 'utf8'))
        .catch((err) => logger.warn(`HTML dump failed: ${err.message}`)),
    ]);

    await pruneOldCaptures();

    const summary =
      `page "${title}" at ${url} — ` +
      `${counts.passwordInputs} password field(s), ${counts.emailInputs} email field(s), ` +
      `${counts.buttons} button(s), ${counts.frames} frame(s)` +
      (counts.text ? ` — visible text starts with: "${counts.text}"` : '');

    logger.info(`Captured ${base}.png / .html — ${summary}`);
    return summary;
  } catch (err) {
    logger.warn(`Could not capture the page state: ${err.message}`);
    return 'the page state could not be captured';
  }
}

/** The handful of things worth knowing about a page we failed on. */
async function countLandmarks(page) {
  const perFrame = await Promise.all(
    page.frames().map(async (frame) => {
      try {
        return await frame.evaluate(() => ({
          passwordInputs: document.querySelectorAll('input[type="password"]').length,
          emailInputs: document.querySelectorAll(
            'input[inputmode="email"], input[type="email"], input[name*="user" i]',
          ).length,
          buttons: document.querySelectorAll('button, input[type="submit"]').length,
          text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
        }));
      } catch {
        // A frame can be detached mid-capture; it simply contributes nothing.
        return { passwordInputs: 0, emailInputs: 0, buttons: 0, text: '' };
      }
    }),
  );

  return {
    frames: page.frames().length,
    passwordInputs: sum(perFrame, 'passwordInputs'),
    emailInputs: sum(perFrame, 'emailInputs'),
    buttons: sum(perFrame, 'buttons'),
    text: perFrame.map((f) => f.text).find((t) => t.length > 0) ?? '',
  };
}

function sum(items, key) {
  return items.reduce((total, item) => total + item[key], 0);
}

/** Keep the last few captures; a stuck integration must not fill the volume. */
async function pruneOldCaptures() {
  try {
    const entries = (await readdir(DIAGNOSTICS_DIR())).sort();
    // Two files per capture (.png + .html), oldest first thanks to the stamp.
    const excess = entries.slice(0, Math.max(0, entries.length - KEEP_LAST * 2));
    await Promise.all(
      excess.map((name) => rm(path.join(DIAGNOSTICS_DIR(), name), { force: true })),
    );
  } catch (err) {
    logger.warn(`Could not prune old captures: ${err.message}`);
  }
}
