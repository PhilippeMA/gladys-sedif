// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device modules rely on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates   -> record calls so tests can assert them
//   - publishTransports              -> record calls so tests can assert them
//   - setConnectionStatus            -> record calls so tests can assert them
// This lets us test the wiring (discovery payloads, dispatch, import cursor)
// without a running Gladys server and without a browser.
// -----------------------------------------------------------------------------

export function createFakeGladys() {
  const published = [];
  const batches = [];
  const transports = [];
  const connectionStatuses = [];

  return {
    published,
    batches,
    transports,
    connectionStatuses,

    externalIds(type, platformId) {
      const device = `ext:sedif:${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
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
      transports.push(...entries);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },
  };
}
