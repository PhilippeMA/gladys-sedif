// -----------------------------------------------------------------------------
// Entry point of the SEDIF integration.
//
// Role of this file: wire the SDK to the device catalog (src/devices/). It
// holds NO portal logic — the browser session, the selectors and the CSV all
// live behind src/sedif/. This file only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects and publishes the discovered devices.
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
  findBlueprintByDevice,
} from './src/devices/index.js';
import { ensureStateDir } from './src/storage.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing the configured meter');
  await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, config));
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// This is the only data path of the integration: the meter is read once a day
// by the operator, and every poll imports the days Gladys does not have yet.
gladys.onPoll(async (device) => {
  const blueprint = findBlueprintByDevice(gladys, device, config);
  if (!blueprint || typeof blueprint.onPoll !== 'function') {
    logger.debug(`onPoll ignored (unknown device) for ${device.external_id}`);
    return;
  }
  try {
    await blueprint.onPoll(gladys, config);
    await publishDeviceTransports();
  } catch (err) {
    // Report the badge before re-throwing, so the failure is visible on the
    // device card and not only in `docker logs`.
    await publishDeviceTransports().catch(() => {});
    throw err;
  }
});

// --- Manifest actions: buttons in the Configuration screen -------------------
for (const blueprint of DEVICE_BLUEPRINTS) {
  for (const [actionKey, handler] of Object.entries(blueprint.actions ?? {})) {
    gladys.onAction(actionKey, (fields) => handler(gladys, { fields, config }));
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
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the SEDIF integration...');
await ensureStateDir();
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
