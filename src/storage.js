// -----------------------------------------------------------------------------
// Small persistent state, in the only writable place of the sandbox.
//
// The Gladys sandbox mounts the container rootfs READ-ONLY and gives the
// integration a single writable volume, `/data`. Two things need it:
//
//   1. the import cursor — the last day already published to Gladys. Without
//      it, every restart would re-push the whole history and duplicate every
//      point of the consumption chart;
//   2. a scratch directory for Chromium, which refuses to start when it cannot
//      write its profile.
//
// Everything degrades gracefully: if `/data` is not writable, the integration
// still works, it just re-publishes what it already published.
// -----------------------------------------------------------------------------

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'storage' });

/** Writable volume of the integration; overridable for local runs and tests. */
export const STATE_DIR = process.env.GLADYS_SEDIF_STATE_DIR || '/data';

const CURSOR_FILE = () => path.join(STATE_DIR, 'cursor.json');

/** Scratch directory for the browser profile and temporary files. */
export const BROWSER_PROFILE_DIR = () => path.join(STATE_DIR, 'chromium');

/**
 * Create the writable directories. Called once at startup so a permission
 * problem shows up in the logs immediately, not at the first poll.
 */
export async function ensureStateDir() {
  try {
    await mkdir(BROWSER_PROFILE_DIR(), { recursive: true });
    // Playwright creates a throw-away browser profile under TMPDIR at every
    // launch. The default (/tmp) belongs to the read-only rootfs, so point it
    // at the volume — otherwise Chromium never starts.
    process.env.TMPDIR = BROWSER_PROFILE_DIR();
    return true;
  } catch (err) {
    logger.warn(`Cannot write in ${STATE_DIR}: ${err.message}`);
    return false;
  }
}

/**
 * Last day published for a contract, or null when nothing was ever published.
 * @param {string} contractKey stable key of the contract
 * @returns {Promise<string|null>} `YYYY-MM-DD`
 */
export async function readCursor(contractKey) {
  const value = (await readCursorFile())[contractKey];
  return typeof value === 'string' ? value : null;
}

/**
 * Remember the last published day. A failure here is logged, never fatal: the
 * data reached Gladys, which is what matters.
 */
export async function writeCursor(contractKey, day) {
  const content = await readCursorFile();
  content[contractKey] = day;
  try {
    await writeFile(CURSOR_FILE(), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  } catch (err) {
    logger.warn(`Could not persist the import cursor: ${err.message}`);
  }
}

/** Forget the cursor of a contract, so the next poll re-imports everything. */
export async function clearCursor(contractKey) {
  const content = await readCursorFile();
  delete content[contractKey];
  try {
    await writeFile(CURSOR_FILE(), `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  } catch (err) {
    logger.warn(`Could not clear the import cursor: ${err.message}`);
  }
}

/** The whole cursor file, or an empty object when it is missing or corrupt. */
async function readCursorFile() {
  try {
    return JSON.parse(await readFile(CURSOR_FILE(), 'utf8')) ?? {};
  } catch {
    return {};
  }
}
