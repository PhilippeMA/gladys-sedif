// -----------------------------------------------------------------------------
// The SEDIF "driver": one function the device blueprint calls, one shape it
// gets back. Which source is behind it is decided here and nowhere else.
//
//   - `api`  : the portal's own Salesforce Aura API (src/sedif/api.js);
//   - `file` : a CSV the user dropped in /data/import (src/sedif/file.js),
//              parsed by src/sedif/csv.js.
//
// Both hand back the same `Reading` shape, so everything downstream — the
// import cursor, the dated backfill, the batching, the device itself — is
// written once and does not care where the days came from.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { fetchConsumption } from './api.js';
import { readDroppedCsv } from './file.js';
import { latestReading, parseHistoryCsv } from './csv.js';

const logger = createLogger({ name: 'sedif' });

export { PortalError } from './errors.js';
export { latestReading, litersToCubicMeters, parseHistoryCsv, selectNewReadings } from './csv.js';

/**
 * Fetch the consumption history of the configured account.
 *
 * @param {object} config normalized integration configuration
 * @param {object} [deps] injection seam for the tests
 * @param {(config: object, deps: object) => Promise<string>} [deps.download] CSV provider
 * @param {(config: object, deps: object) => Promise<object>} [deps.fetchApi] API provider
 * @returns {Promise<{ readings: Reading[], latest: Reading|null, pricePerCubicMeter: number|null }>}
 */
export async function fetchHistory(config, deps = {}) {
  const started = Date.now();
  const { readings, pricePerCubicMeter } = await readFromSource(config, deps);
  const latest = latestReading(readings, config.include_estimated);

  logger.info(
    `${readings.length} readings retrieved in ${Math.round((Date.now() - started) / 1000)} s` +
      (latest ? `, last measured day ${latest.date}` : ', no measured day'),
  );

  return { readings, latest, pricePerCubicMeter };
}

async function readFromSource(config, deps) {
  if (config.source === 'file') {
    // `deps.download` is what the tests substitute for a folder of files.
    const download = deps.download ?? readDroppedCsv;
    return { readings: parseHistoryCsv(await download(config, deps)), pricePerCubicMeter: null };
  }

  const fetchApi = deps.fetchApi ?? deps.download ?? fetchConsumption;
  const result = await fetchApi(config, deps);
  // A test seam that hands back raw CSV stays usable against the API source.
  if (typeof result === 'string') {
    return { readings: parseHistoryCsv(result), pricePerCubicMeter: null };
  }
  return { readings: result.readings ?? [], pricePerCubicMeter: result.pricePerCubicMeter ?? null };
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
