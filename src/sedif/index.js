// -----------------------------------------------------------------------------
// The SEDIF "driver": one function the device blueprint calls, one shape it
// gets back. Everything portal-specific (browser, selectors, CSV quirks) stays
// behind this boundary.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { downloadHistoryCsv } from './portal.js';
import { readDroppedCsv } from './file.js';
import { latestReading, parseHistoryCsv } from './csv.js';

const logger = createLogger({ name: 'sedif' });

export { PortalError } from './portal.js';
export { latestReading, litersToCubicMeters, parseHistoryCsv, selectNewReadings } from './csv.js';

/**
 * Fetch the consumption history of the configured account.
 *
 * @param {object} config normalized integration configuration
 * @param {object} [deps] injection seam for the tests
 * @param {(config: object) => Promise<string>} [deps.download] CSV provider
 * @returns {Promise<{ readings: import('./csv.js').Reading[], latest: import('./csv.js').Reading|null }>}
 */
export async function fetchHistory(config, deps = {}) {
  // The two sources are interchangeable by design: both hand back the raw CSV
  // the portal produces, and everything after this line is identical.
  const download =
    deps.download ?? (config.source === 'file' ? readDroppedCsv : downloadHistoryCsv);

  const started = Date.now();
  // `deps` carries the session budget (deadlineMs) as well as the test seam.
  const csv = await download(config, deps);
  const readings = parseHistoryCsv(csv);
  const latest = latestReading(readings, config.include_estimated);

  logger.info(
    `${readings.length} readings retrieved in ${Math.round((Date.now() - started) / 1000)} s` +
      (latest ? `, last measured day ${latest.date}` : ', no measured day'),
  );

  return { readings, latest };
}

/**
 * Stable key identifying the meter of this configuration. It is what the
 * device external_id and the import cursor are built from, so it must not
 * change between two runs of the same account.
 *
 * The contract number is the natural identifier; when the user left it empty
 * (single-contract account), the account email plays that role. Either way the
 * value is reduced to `[a-z0-9-]`, because it ends up inside an external id.
 */
export function contractKey(config) {
  const raw = config.contract || config.email;
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default'
  );
}
