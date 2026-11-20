// -----------------------------------------------------------------------------
// Small persistent state, in the only writable place of the sandbox.
//
// The Gladys sandbox mounts the container rootfs READ-ONLY and gives the
// integration a single writable volume, `/data`. Three things need it:
//
//   1. the import cursor — the last day already published to Gladys. Without
//      it, every restart would re-push the whole history and duplicate every
//      point of the consumption chart;
//   2. the drop folder of the CSV source, where the user puts the export;
//   3. the intermediate certificate fetched to repair the portal's incomplete
//      chain (see src/sedif/chain.js), so a restart does not download it again.
//
// Everything degrades gracefully: if `/data` is not writable, the integration
// still works — it just re-publishes what it already published, and fetches
// the certificate again at every start.
// -----------------------------------------------------------------------------

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'storage' });

/** Writable volume of the integration; overridable for local runs and tests. */
export const STATE_DIR = process.env.GLADYS_SEDIF_STATE_DIR || '/data';

const CURSOR_FILE = () => path.join(STATE_DIR, 'cursor.json');

/** Where the user drops the CSV exported by hand (source = "file"). */
export const IMPORT_DIR = () => path.join(STATE_DIR, 'import');

/** Intermediate certificates fetched to complete the portal's chain. */
const CHAIN_FILE = () => path.join(STATE_DIR, 'chain.pem');

/**
 * Create the writable directories. Called once at startup so a permission
 * problem shows up in the logs immediately, not at the first poll.
 */
export async function ensureStateDir() {
  try {
    // Always created, whatever the configured source: a folder that exists is
    // what tells a user where the file is supposed to go.
    await mkdir(IMPORT_DIR(), { recursive: true });
    return true;
  } catch (err) {
    logger.warn(`Cannot write in ${STATE_DIR}: ${err.message}`);
    return false;
  }
}

/**
 * The intermediate certificates learned on an earlier run, or an empty array.
 * @returns {Promise<string[]>} one PEM block per certificate
 */
export async function readLearnedChain() {
  try {
    const content = await readFile(CHAIN_FILE(), 'utf8');
    return content
      .split(/(?=-----BEGIN CERTIFICATE-----)/)
      .map((block) => block.trim())
      .filter((block) => block.startsWith('-----BEGIN CERTIFICATE-----'));
  } catch {
    return [];
  }
}

/**
 * Remember the certificates that repaired the chain. A failure here is logged,
 * never fatal: the connection already works, it will just be repaired again
 * after a restart.
 */
export async function writeLearnedChain(pems) {
  try {
    await writeFile(CHAIN_FILE(), `${pems.map((pem) => pem.trim()).join('\n')}\n`, 'utf8');
  } catch (err) {
    logger.warn(`Could not persist the fetched certificate: ${err.message}`);
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
