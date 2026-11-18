// -----------------------------------------------------------------------------
// The Gladys stand-in used by the tests.
//
// It wraps `createFakeGladys` from the SDK — the in-memory Gladys that checks
// a payload the way the host API does — and records what went through it in
// the flat shape the tests assert on:
//
//   - published[]          every state, one entry per feature value
//   - batches[]            the `publishStates` calls, to check the batching
//   - transports[]         the `publishTransports` entries
//   - connectionStatuses[] the `setConnectionStatus` calls
//
// Going through the SDK fake is the point: it refuses an external_id that does
// not start with `ext:sedif:`, an unknown category, type or unit, a
// `poll_frequency` outside DEVICE_POLL_FREQUENCIES, a feature missing one of
// the columns Gladys stores NOT NULL, a state that is neither numeric nor
// text. Those are exactly the mistakes a hand-written stub waves through and
// the user then meets as a 400 on discovery or a 422 when adding the device.
//
// `sdk` is kept on the object as an escape hatch: `gladys.sdk.fake` carries
// the SDK's own record (`requests`, `states`, `discoveredDevices`, `status`).
// -----------------------------------------------------------------------------

import { createFakeGladys as createSdkFakeGladys } from '@gladysassistant/integration-sdk/testing';

// Must match the integration's selector: it is what the `ext:` prefix of every
// external id is built from, and the fake checks that prefix.
const SELECTOR = 'sedif';

export function createFakeGladys() {
  const sdk = createSdkFakeGladys({ selector: SELECTOR });
  const published = [];
  const batches = [];
  const transports = [];
  const connectionStatuses = [];

  return {
    sdk,
    published,
    batches,
    transports,
    connectionStatuses,

    externalIds(type, platformId) {
      return sdk.externalIds(type, platformId);
    },

    async publishDiscoveredDevices(devices) {
      return sdk.publishDiscoveredDevices(devices);
    },

    async publishState(featureExternalId, state) {
      await sdk.publishState(featureExternalId, state);
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      await sdk.publishStates(states);
      batches.push(states);
      for (const s of states) {
        published.push({
          featureExternalId: s.device_feature_external_id,
          state: s.state,
          created_at: s.created_at,
        });
      }
    },

    async publishTransports(entries) {
      await sdk.publishTransports(entries);
      transports.push(...entries);
    },

    async setConnectionStatus(connected, message) {
      await sdk.setConnectionStatus(connected, message);
      connectionStatuses.push({ connected, message });
    },
  };
}
