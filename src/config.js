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
  // 'api': sign in and read the portal's own Aura API (src/sedif/api.js).
  // 'file': read the CSV the user dropped in the import folder, for people who
  // would rather nothing signed in on their behalf (src/sedif/file.js).
  source: 'api',
  email: '',
  password: '',
  contract: '',
  poll_frequency: 21600, // 6 h — the meter is only read once a day
  history_days: 30, // how far back the first import goes
  include_estimated: false, // estimated readings can make the index go backwards
};

/**
 * Merge the user config with the defaults and force the types.
 * @param {Record<string, unknown>} raw configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    source: raw.source === 'file' ? 'file' : DEFAULT_CONFIG.source,
    email: String(raw.email ?? DEFAULT_CONFIG.email).trim(),
    password: String(raw.password ?? DEFAULT_CONFIG.password),
    contract: String(raw.contract ?? DEFAULT_CONFIG.contract).trim(),
    poll_frequency: toBoundedNumber(raw.poll_frequency, DEFAULT_CONFIG.poll_frequency, 3600, 86400),
    history_days: toBoundedNumber(raw.history_days, DEFAULT_CONFIG.history_days, 1, 1095),
    // A checkbox arrives as a boolean, but a hand-written variable may be a
    // string: only an explicit truthy value enables estimated readings.
    include_estimated: raw.include_estimated === true || raw.include_estimated === 'true',
  };
}

/**
 * True when the integration has everything it needs to reach the portal.
 * Until the user fills the form in, polling would only produce failed logins.
 */
export function isConfigured(config) {
  // The dropped-file source needs no account at all: the user already did the
  // signing in, by hand, in their own browser.
  if (config.source === 'file') {
    return true;
  }
  return config.email.length > 0 && config.password.length > 0;
}

function toBoundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}
