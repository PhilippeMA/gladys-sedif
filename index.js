// -----------------------------------------------------------------------------
// Entry point of the SEDIF integration.
//
// Role of this file: wire the SDK to the device catalog (src/devices/) and own
// the refresh schedule. It holds NO portal logic — the browser session, the
// selectors and the CSV all live behind src/sedif/. This file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects, publishes the devices and starts the refresh loop.
//
// WHY A LOCAL SCHEDULE AND NOT `onPoll`
// The Gladys core polls devices at one of six fixed intervals (1 s to 1 min):
// a device publishing any other `poll_frequency` is rejected outright with
// "invalid poll frequency". A SEDIF meter is read once a day by the operator,
// so the core's polling is the wrong tool. The integration therefore publishes
// its device WITHOUT `poll_frequency` — the core never polls it — and runs its
// own timer here.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { isConfigured, normalizeConfig } from './src/config.js';
import {
  DEVICE_BLUEPRINTS,
  buildDiscoveredDevices,
  buildTransportEntries,
  refreshAllDevices,
} from './src/devices/index.js';
import { ensureStateDir } from './src/storage.js';

const gladys = new GladysIntegration();

// Let the connection settle before the first refresh — long enough that a user
// who just saved their credentials can press "Tester la connexion" without the
// two colliding.
const FIRST_REFRESH_DELAY_MS = 60_000;

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Refresh loop state.
let refreshTimer = null;
let firstRefreshTimer = null;
let refreshInFlight = false;

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing the configured meter');
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
});

// --- Manifest actions: buttons in the Configuration screen -------------------
for (const blueprint of DEVICE_BLUEPRINTS) {
  for (const [actionKey, handler] of Object.entries(blueprint.actions ?? {})) {
    gladys.onAction(actionKey, async (fields) => {
      const message = await handler(gladys, { fields, config });
      // An action can publish states (re-import): reflect the outcome on the
      // device badge right away instead of waiting for the next refresh.
      await publishDeviceTransports().catch(() => {});
      return message;
    });
  }
}

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  const previous = config;
  config = normalizeConfig(newConfig);

  // The device external_id is derived from the contract: changing it creates a
  // new device rather than renaming the old one. Say so in the logs, otherwise
  // the "duplicate" device in Gladys looks like a bug.
  if (previous.contract !== config.contract || previous.email !== config.email) {
    logger.info('The account or contract changed: a new device will be published');
  }

  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
  await publishDeviceTransports();
  await reportConfigurationStatus();

  // Credentials or interval may have changed: restart the loop so the user
  // sees the result of what they just typed, not in six hours.
  startRefreshLoop();
});

// --- Connection lifecycle ----------------------------------------------------
// The SDK logs the WebSocket lifecycle itself (under `gladys-sdk`); these
// handlers only run the integration's own (re)initialization.
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
    await publishDeviceTransports();
    await reportConfigurationStatus();
    startRefreshLoop();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

gladys.on('disconnected', () => {
  // No point driving a browser session while we cannot publish the result.
  stopRefreshLoop();
});

/** (Re)start the refresh schedule: once shortly from now, then periodically. */
function startRefreshLoop() {
  stopRefreshLoop();
  if (!isConfigured(config)) {
    logger.info('Refresh loop not started: credentials missing');
    return;
  }
  logger.info(`Refresh loop started: every ${config.poll_frequency} s`);
  firstRefreshTimer = setTimeout(runRefresh, FIRST_REFRESH_DELAY_MS);
  refreshTimer = setInterval(runRefresh, config.poll_frequency * 1000);
  // Do not hold the event loop open just for the timers.
  firstRefreshTimer.unref?.();
  refreshTimer.unref?.();
}

function stopRefreshLoop() {
  clearTimeout(firstRefreshTimer);
  clearInterval(refreshTimer);
  firstRefreshTimer = null;
  refreshTimer = null;
}

/**
 * One refresh. Never throws: this runs on a timer, and an unhandled rejection
 * here would take the whole integration down. The failure is already recorded
 * on the device badge by the blueprint.
 */
async function runRefresh() {
  if (refreshInFlight) {
    // A slow portal must not let refreshes pile up on top of each other.
    logger.info('Refresh skipped: the previous one is still running');
    return;
  }
  refreshInFlight = true;
  try {
    await refreshAllDevices(gladys, config);
  } catch (err) {
    logger.error('Refresh failed', err);
  } finally {
    refreshInFlight = false;
    await publishDeviceTransports().catch(() => {});
  }
}

/**
 * Application-level status shown in the Configuration screen. Being connected
 * to Gladys says nothing about being able to reach the portal, and an
 * integration waiting for credentials should say so rather than look healthy.
 */
async function reportConfigurationStatus() {
  if (!isConfigured(config)) {
    await gladys.setConnectionStatus(false, {
      en: 'Waiting for your leaudiledefrance.fr email address and password.',
      fr: 'En attente de votre adresse e-mail et de votre mot de passe leaudiledefrance.fr.',
    });
    return;
  }
  await gladys.setConnectionStatus(true);
}

async function publishDeviceTransports() {
  const entries = buildTransportEntries(gladys, config);
  if (entries.length > 0) {
    await gladys.publishTransports(entries);
  }
}

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopRefreshLoop();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the SEDIF integration...');
await ensureStateDir();
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
