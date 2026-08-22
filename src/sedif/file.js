// -----------------------------------------------------------------------------
// Second data source: the export YOU drop in, no browser involved.
//
// The automatic source signs in to the portal on your behalf. Some people
// would rather it did not, and a portal can always change under us. So the
// data can also get in by hand: download
// `historique_jours_litres.csv` from the customer portal yourself, drop it in
// the integration's import folder, and everything downstream — parsing, the
// import cursor, the dated backfill, the batching — works exactly as it does
// for the automated path. Same code, same charts.
//
// The folder is `<state dir>/import`, i.e. `/data/import` inside the sandbox,
// on the one writable volume the integration owns. Files are never deleted:
// the import cursor already makes re-reading them harmless, and a user who
// dropped a file has every right to still find it there.
// -----------------------------------------------------------------------------

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { IMPORT_DIR } from '../storage.js';
import { PortalError } from './errors.js';

const logger = createLogger({ name: 'file' });

/**
 * Read every CSV dropped in the import folder.
 *
 * Several files are concatenated rather than picked between: exports overlap,
 * the parser sorts by date and the cursor skips what Gladys already has, so
 * dropping this month's export next to last month's is the natural way to
 * extend the history rather than a mistake to arbitrate.
 *
 * @param {object} _config normalized configuration (unused, kept for symmetry
 *   with the portal driver so the two are interchangeable)
 * @param {object} [deps] injection seam for the tests
 * @param {string} [deps.importDir]
 * @returns {Promise<string>} the concatenated CSV content
 */
export async function readDroppedCsv(_config, deps = {}) {
  const directory = deps.importDir ?? IMPORT_DIR();

  let entries;
  try {
    entries = await readdir(directory);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new PortalError('IMPORT_DIR_MISSING', `The import folder ${directory} does not exist`);
    }
    throw err;
  }

  const files = entries.filter((name) => name.toLowerCase().endsWith('.csv')).sort();

  if (files.length === 0) {
    throw new PortalError(
      'NO_IMPORT_FILE',
      `No .csv file in ${directory}. Download the daily history from the portal ` +
        'and drop it there.',
    );
  }

  logger.info(`Reading ${files.length} file(s) from ${directory}: ${files.join(', ')}`);

  const contents = await Promise.all(
    files.map((name) => readFile(path.join(directory, name), 'utf8')),
  );

  return contents.join('\n');
}
