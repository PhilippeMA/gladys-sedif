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
//   - onPoll(gladys, config)   (optional): periodic read
//   - transport(gladys, config)(optional): effective transport, shown as a badge
//   - actions                  (optional): manifest action handlers, keyed by
//     the action `key` declared in gladys-assistant-integration.json
//
// Unlike the template, `deviceExternalId` takes the config: the identity of a
// SEDIF device comes from the contract the user configured, not from a device
// enumerated on a bus.
// -----------------------------------------------------------------------------

import { waterMeter } from './waterMeter.js';

export const DEVICE_BLUEPRINTS = [waterMeter];

/** Build the discovery payload for Gladys (all devices). */
export function buildDiscoveredDevices(gladys, config) {
  return DEVICE_BLUEPRINTS.map((bp) => bp.buildDevice(gladys, config));
}

/**
 * Find the blueprint that owns a device, from its external_id — this is what
 * routes an incoming onPoll to the right module.
 */
export function findBlueprintByDevice(gladys, device, config) {
  return DEVICE_BLUEPRINTS.find((bp) => bp.deviceExternalId(gladys, config) === device.external_id);
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
