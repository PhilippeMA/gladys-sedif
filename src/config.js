// -----------------------------------------------------------------------------
// Integration configuration.
//
// The values are filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches them
// (`gladys.getConfig()`) and notifies every change through
// `gladys.onConfigUpdated()`.
//
// This module holds the defaults and normalizes the received object, so the
// rest of the code never deals with `undefined` or with a number that arrived
// as a string from the form.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (a unit test enforces it).
export const DEFAULT_CONFIG = {
  email: '',
  password: '',
  contract: '',
  poll_frequency: 21600, // 6 h — the meter is only read once a day
  history_days: 30, // how far back the first import goes
  include_estimated: false, // estimated readings can make the index go backwards
  history_url: '', // advanced override, empty = auto-discovery
};

/**
 * Merge the user config with the defaults and force the types.
 * @param {Record<string, unknown>} raw configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    email: String(raw.email ?? DEFAULT_CONFIG.email).trim(),
    password: String(raw.password ?? DEFAULT_CONFIG.password),
    contract: String(raw.contract ?? DEFAULT_CONFIG.contract).trim(),
    poll_frequency: toBoundedNumber(raw.poll_frequency, DEFAULT_CONFIG.poll_frequency, 3600, 86400),
    history_days: toBoundedNumber(raw.history_days, DEFAULT_CONFIG.history_days, 1, 1095),
    // A checkbox arrives as a boolean, but a hand-written variable may be a
    // string: only an explicit truthy value enables estimated readings.
    include_estimated: raw.include_estimated === true || raw.include_estimated === 'true',
    history_url: String(raw.history_url ?? DEFAULT_CONFIG.history_url).trim(),
  };
}

/**
 * True when the integration has everything it needs to reach the portal.
 * Until the user fills the form in, polling would only produce failed logins.
 */
export function isConfigured(config) {
  return config.email.length > 0 && config.password.length > 0;
}

function toBoundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}
