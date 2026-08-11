// -----------------------------------------------------------------------------
// Device registry.
//
// This integration exposes a single device type — the water meter of a SEDIF
// contract — but keeps the template's registry shape: the wiring in index.js
// stays generic, and a second device type (a second contract, a leak alert
// sensor) is one file plus one line here.
//
// Every blueprint exposes:
//   - key                                : short identifier, used in the logs
//   - deviceExternalId(gladys, config)   : the device external_id, for dispatch
//   - buildDevice(gladys, config)        : the discovery payload sent to Gladys
//   - refresh(gladys, config)  (optional): read the source and publish states
//   - transport(gladys, config)(optional): effective transport, shown as a badge
//   - actions                  (optional): manifest action handlers, keyed by
//     the action `key` declared in gladys-assistant-integration.json
//
// Two departures from the template, both forced by what a SEDIF meter is:
//   - `deviceExternalId` takes the config, because the identity of the device
//     comes from the contract the user configured, not from a device
//     enumerated on a bus;
//   - `refresh` replaces `onPoll`, because the core's polling only accepts
//     intervals up to one minute (see waterMeter.buildDevice) while this meter
//     is published once a day. index.js runs the schedule instead.
// -----------------------------------------------------------------------------

import { waterMeter } from './waterMeter.js';

export const DEVICE_BLUEPRINTS = [waterMeter];

/** Build the discovery payload for Gladys (all devices). */
export function buildDiscoveredDevices(gladys, config) {
  return DEVICE_BLUEPRINTS.map((bp) => bp.buildDevice(gladys, config));
}

/**
 * Refresh every device that knows how to refresh itself.
 * @returns {Promise<number>} number of days published across all devices
 */
export async function refreshAllDevices(gladys, config, deps = {}) {
  let published = 0;
  for (const blueprint of DEVICE_BLUEPRINTS) {
    if (typeof blueprint.refresh === 'function') {
      published += (await blueprint.refresh(gladys, config, deps)) ?? 0;
    }
  }
  return published;
}

/**
 * Build the `publishTransports` payload: one entry per blueprint that reports
 * its transport. An entry can carry `{ degraded: true, message }` to flag "it
 * works, but not nominally" — here, a history the portal stopped updating.
 */
export function buildTransportEntries(gladys, config) {
  return DEVICE_BLUEPRINTS.filter((bp) => typeof bp.transport === 'function').map((bp) => {
    const reported = bp.transport(gladys, config);
    const entry = typeof reported === 'string' ? { transport: reported } : reported;
    return { external_id: bp.deviceExternalId(gladys, config), ...entry };
  });
}
