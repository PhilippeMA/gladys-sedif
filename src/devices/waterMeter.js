// -----------------------------------------------------------------------------
// Device type: SEDIF WATER METER
//
// A read-only, once-a-day device. Two features:
//
//   - the meter index, in cubic meters: the number printed on the meter and on
//     the bill, always increasing;
//   - the daily consumption, in litres: what the household actually used that
//     day, the one people look at.
//
// The portal publishes a reading with one or two days of delay, so this device
// is a HISTORY IMPORTER more than a live sensor: each refresh fetches the whole
// exported period and publishes the days Gladys does not have yet, each with
// its own `created_at`. An import cursor on the /data volume is what keeps a
// restart from duplicating the chart.
//
// The refresh is driven by the integration itself, not by the Gladys core:
// see `buildDevice` for why the core's `poll_frequency` cannot be used here.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
  DEVICE_TRANSPORTS,
} from '@gladysassistant/integration-sdk';
import {
  contractKey,
  fetchHistory,
  litersToCubicMeters,
  selectNewReadings,
} from '../sedif/index.js';
import { clearCursor, readCursor, writeCursor } from '../storage.js';
import { isConfigured } from '../config.js';

const DEVICE_TYPE = 'water-meter';

const logger = createLogger({ name: DEVICE_TYPE });

const FEATURE = {
  INDEX: 'index',
  DAILY_VOLUME: 'daily-volume',
};

// `publishStates` accepts 100 states per request and each reading produces two
// of them, so a batch of 50 readings fills exactly one request.
const READINGS_PER_BATCH = 50;

// Beyond this, the portal is not just late, something is wrong: the badge goes
// degraded so the user sees it without opening the logs.
const STALE_AFTER_DAYS = 4;

// The manifest grants an action 120 s of ack — the maximum Gladys allows — and
// past that the UI just says "the action failed, check that the integration is
// started", which tells the user nothing. So an action gives up FIRST, with
// enough margin to send back a real explanation.
const ACTION_DEADLINE_MS = 100_000;

// Last successful poll, used by the transport badge. Not persisted: after a
// restart the badge stays neutral until the first poll says otherwise.
let lastSuccessfulReadingDate = null;
let lastFailureMessage = null;

export const waterMeter = {
  key: DEVICE_TYPE,

  deviceExternalId(gladys, config) {
    return gladys.externalIds(DEVICE_TYPE, contractKey(config)).device;
  },

  buildDevice(gladys, config) {
    const ids = gladys.externalIds(DEVICE_TYPE, contractKey(config));
    return {
      name: config.contract ? `Compteur d'eau SEDIF ${config.contract}` : "Compteur d'eau SEDIF",
      external_id: ids.device,
      // NO `poll_frequency`: the core only accepts the six values of its
      // DEVICE_POLL_FREQUENCIES list (in milliseconds, 1 s to 1 min), and
      // anything else is rejected with "invalid poll frequency". Driving a
      // browser session against the portal once a minute would be absurd for
      // a meter read once a day, so this integration schedules its own refresh
      // instead — see `refresh()` below and the loop in index.js.
      features: [
        {
          name: 'Index du compteur',
          external_id: ids.feature(FEATURE.INDEX),
          category: DEVICE_FEATURE_CATEGORIES.VOLUME_SENSOR,
          type: DEVICE_FEATURE_TYPES.VOLUME_SENSOR.DECIMAL,
          unit: DEVICE_FEATURE_UNITS.CUBIC_METER,
          min: 0,
          // A household meter is replaced long before it reaches 100 000 m3.
          max: 100000,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
        {
          name: 'Consommation quotidienne',
          external_id: ids.feature(FEATURE.DAILY_VOLUME),
          category: DEVICE_FEATURE_CATEGORIES.VOLUME_SENSOR,
          type: DEVICE_FEATURE_TYPES.VOLUME_SENSOR.INTEGER,
          unit: DEVICE_FEATURE_UNITS.LITER,
          min: 0,
          // A burst pipe can run several cubic meters in a day; leave room so
          // the leak that matters is not clipped out of the chart.
          max: 100000,
          read_only: true,
          has_feedback: false,
          keep_history: true,
        },
      ],
    };
  },

  // Single-channel device: the portal is a cloud service, there is no local
  // path to prefer. The badge is still worth publishing, because it is where a
  // stale history shows up without reading the logs.
  transport() {
    if (lastFailureMessage) {
      return {
        transport: DEVICE_TRANSPORTS.CLOUD,
        degraded: true,
        message: {
          en: `Last update failed: ${lastFailureMessage}`.slice(0, 200),
          fr: `Dernière mise à jour en échec : ${lastFailureMessage}`.slice(0, 200),
        },
      };
    }
    if (lastSuccessfulReadingDate && daysSince(lastSuccessfulReadingDate) > STALE_AFTER_DAYS) {
      return {
        transport: DEVICE_TRANSPORTS.CLOUD,
        degraded: true,
        message: {
          en: `The portal has published no reading since ${lastSuccessfulReadingDate}.`,
          fr: `L'espace client n'a publié aucun relevé depuis le ${lastSuccessfulReadingDate}.`,
        },
      };
    }
    return { transport: DEVICE_TRANSPORTS.CLOUD };
  },

  actions: {
    async test_connection(gladys, { config, deps = {} }) {
      logger.info(`Action test_connection requested (source: ${config.source})`);
      if (!isConfigured(config)) {
        return {
          en: 'Fill in the email address and the password first, or switch the source to the dropped CSV file.',
          fr: "Renseignez d'abord l'adresse e-mail et le mot de passe, ou basculez la source sur le fichier CSV déposé.",
        };
      }
      const { readings, latest } = await fetchHistory(config, {
        deadlineMs: ACTION_DEADLINE_MS,
        ...deps,
      });
      if (!latest) {
        return {
          en: `Signed in, ${readings.length} days exported, but no measured reading yet.`,
          fr: `Connexion réussie, ${readings.length} jours exportés, mais aucun relevé mesuré pour l'instant.`,
        };
      }
      const index = litersToCubicMeters(latest.indexLiters);
      return {
        en: `Connection OK: meter at ${index} m³ on ${latest.date}, ${latest.consumptionLiters} L used that day (${readings.length} days available).`,
        fr: `Connexion OK : compteur à ${index} m³ le ${latest.date}, ${latest.consumptionLiters} L consommés ce jour-là (${readings.length} jours disponibles).`,
      };
    },

    async resync_history(gladys, { config, deps = {} }) {
      logger.info('Action resync_history requested');
      await clearCursor(contractKey(config));
      const published = await importHistory(gladys, config, {
        deadlineMs: ACTION_DEADLINE_MS,
        ...deps,
      });
      return {
        en: `History re-imported: ${published} days published.`,
        fr: `Historique réimporté : ${published} jours publiés.`,
      };
    },
  },

  /**
   * Refresh this device. Called by the integration's own scheduler (index.js),
   * NOT by the Gladys core: the core's polling tops out at one minute, which
   * makes no sense for a value published once a day.
   */
  async refresh(gladys, config, deps = {}) {
    if (!isConfigured(config)) {
      logger.info('Credentials missing, nothing to refresh yet');
      return 0;
    }
    return importHistory(gladys, config, deps);
  },
};

/**
 * Fetch the portal history and publish the days Gladys does not have.
 *
 * @param {object} [deps] injection seam for the tests: `{ download }` replaces
 *   the browser session with a canned CSV, so the whole import path (parsing,
 *   selection, batching, cursor) is exercised without a portal.
 * @returns {Promise<number>} number of days published
 */
async function importHistory(gladys, config, deps = {}) {
  const key = contractKey(config);
  const ids = gladys.externalIds(DEVICE_TYPE, key);

  let history;
  try {
    history = await fetchHistory(config, deps);
    lastFailureMessage = null;
  } catch (err) {
    // "Another session is running" is not a failure of the meter, it is the
    // concurrency guard doing its job: it must not paint the badge orange.
    if (err.code !== 'SESSION_BUSY') {
      lastFailureMessage = err.message;
    }
    throw err;
  }

  const { readings, latest } = history;
  if (latest) {
    lastSuccessfulReadingDate = latest.date;
  }

  const since = await readCursor(key);
  const toPublish = selectNewReadings(readings, {
    historyDays: config.history_days,
    includeEstimated: config.include_estimated,
    since,
  });

  if (toPublish.length === 0) {
    logger.info(`Nothing new to publish (last imported day: ${since ?? 'none'})`);
    return 0;
  }

  logger.info(`Publishing ${toPublish.length} days, from ${toPublish[0].date}`);

  for (let i = 0; i < toPublish.length; i += READINGS_PER_BATCH) {
    const batch = toPublish.slice(i, i + READINGS_PER_BATCH);
    await gladys.publishStates(
      batch.flatMap((reading) => [
        {
          device_feature_external_id: ids.feature(FEATURE.INDEX),
          state: litersToCubicMeters(reading.indexLiters),
          created_at: reading.at,
        },
        {
          device_feature_external_id: ids.feature(FEATURE.DAILY_VOLUME),
          state: reading.consumptionLiters,
          created_at: reading.at,
        },
      ]),
    );
    // Move the cursor batch by batch: a failure halfway through leaves the
    // already published days behind us instead of replaying them next time.
    await writeCursor(key, batch[batch.length - 1].date);
  }

  return toPublish.length;
}

function daysSince(isoDay) {
  const then = new Date(`${isoDay}T12:00:00.000Z`).getTime();
  return Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
}

// Test seam: the module-level badge state must not leak between test cases.
export function resetBadgeState() {
  lastSuccessfulReadingDate = null;
  lastFailureMessage = null;
}
