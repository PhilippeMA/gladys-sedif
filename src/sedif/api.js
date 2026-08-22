// -----------------------------------------------------------------------------
// The customer portal, read over its own API. No browser.
//
// Four exchanges, all of them plain HTTP against the Salesforce Aura endpoint
// (see aura.js for the transport and the credit):
//
//   1. sign in                     -> LightningLoginFormController.login
//   2. list the active contracts   -> LTN009_ICL_ContratsGroupements
//   3. read the meter of one       -> LTN008_ICL_ContratDetails
//   4. read its daily history      -> LTN015_ICL_ContratConsoHisto
//
// The Apex class names are the fragile part now — a Salesforce release can
// rename them. That is a much better failure than the browser path had: the
// endpoint answers with a named error immediately, instead of a selector
// quietly timing out forty-five seconds later.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  AuraSession,
  COMMUNITY_APP,
  CUSTOMER_SPACE,
  LOGIN_APP,
  callAura,
  httpRequest,
  loadPage,
} from './aura.js';
import { PortalError } from './errors.js';

const logger = createLogger({ name: 'api' });

// Apex classes behind the Historique screen. Grouped here because they are
// what a portal release is most likely to break.
const APEX = {
  CONTRACTS: {
    classname: 'LTN009_ICL_ContratsGroupements',
    method: 'listCurrentUserActiveContrats',
  },
  CONTRACT_DETAILS: { classname: 'LTN008_ICL_ContratDetails', method: 'getContratDetails' },
  CONSUMPTION: { classname: 'LTN015_ICL_ContratConsoHisto', method: 'getData' },
};

/** Granularity of the history. Daily is the only one this integration wants. */
const TIME_STEP_DAILY = 'JOURNEE';

/**
 * Sign in and bring back the daily history of one contract.
 *
 * @param {object} config normalized integration configuration
 * @param {object} [deps] injection seam for the tests
 * @returns {Promise<{ readings: Reading[], pricePerCubicMeter: number|null, contract: string }>}
 */
export async function fetchConsumption(config, deps = {}) {
  const session = deps.session ?? new AuraSession();
  const started = Date.now();

  await login(session, config);

  const contractId = await resolveContract(session, config);
  const meter = await fetchMeter(session, contractId);

  const end = deps.now ?? new Date();
  const start = new Date(end.getTime() - config.history_days * 86_400_000);

  logger.info(`Reading ${config.history_days} days of history for contract ${contractId}`);
  const payload = await apexAction(
    session,
    APEX.CONSUMPTION,
    {
      contractId,
      TYPE_PAS: TIME_STEP_DAILY,
      DATE_DEBUT: isoDay(start),
      DATE_FIN: isoDay(end),
      NUMERO_COMPTEUR: meter.number,
      ID_PDS: meter.pdsId,
    },
    `${CUSTOMER_SPACE}historique`,
  );

  const rows = payload?.data?.CONSOMMATION ?? [];
  const readings = rows.map(toReading).filter(Boolean);
  readings.sort((a, b) => a.date.localeCompare(b.date));

  logger.info(
    `${readings.length} readings in ${Math.round((Date.now() - started) / 1000)} s` +
      (readings.length ? `, last day ${readings[readings.length - 1].date}` : ''),
  );

  return {
    readings,
    pricePerCubicMeter: toNumber(payload?.prixMoyenEau) ?? null,
    contract: contractId,
  };
}

/**
 * The login exchange.
 *
 * Unlike a browser, nothing here is implicit: the login page is fetched only
 * to read the app build it was compiled for, the credentials go to a standard
 * Salesforce controller, and the session exists only once the frontdoor
 * redirect has set its cookies.
 */
async function login(session, config) {
  logger.info('Signing in');

  const { gotContext } = await loadPage(session, '/s/login/', LOGIN_APP);
  if (!gotContext) {
    throw new PortalError(
      'LOGIN_PAGE_UNRECOGNISED',
      'The login page carried no Lightning build id (fwuid) — the portal has probably changed.',
    );
  }

  const response = await callAura(
    session,
    [
      {
        id: '1;a',
        descriptor: 'apex://LightningLoginFormController/ACTION$login',
        callingDescriptor: 'UNKNOWN',
        params: {
          username: config.email,
          password: config.password,
          startUrl: CUSTOMER_SPACE,
        },
      },
    ],
    { app: LOGIN_APP, pageUri: `${CUSTOMER_SPACE}login` },
  );

  const [action] = response.actions ?? [];
  if (action?.state !== 'SUCCESS') {
    throw new PortalError(
      'LOGIN_REFUSED',
      describeAuraError(action?.error) ?? 'The portal refused the sign-in',
    );
  }
  // A wrong password does not fail the ACTION: it succeeds and returns the
  // error text as its value. Silent failure if you only check the state.
  if (typeof action.returnValue === 'string' && action.returnValue.trim() !== '') {
    throw new PortalError('LOGIN_REFUSED', action.returnValue.trim());
  }

  await followFrontdoor(session, response);
  logger.info('Signed in');
}

/**
 * The login answers with a `clientRedirect` event to a one-shot frontdoor URL.
 * Following it is what turns the exchange into a session; the community page
 * fetched right after carries the app build and the CSRF cookie every later
 * call needs.
 */
async function followFrontdoor(session, loginResponse) {
  const redirect = (loginResponse.events ?? []).find(
    (event) => event.descriptor === 'markup://aura:clientRedirect',
  );
  const url = redirect?.attributes?.values?.url;
  if (!url) {
    throw new PortalError(
      'LOGIN_NO_REDIRECT',
      'The portal accepted the credentials but issued no session redirect.',
    );
  }

  await httpRequest(session, { method: 'GET', url });
  await loadPage(session, '/s/', COMMUNITY_APP);

  if (!session.captureToken()) {
    throw new PortalError(
      'LOGIN_NO_TOKEN',
      'No CSRF token in the session cookies after signing in.',
    );
  }
}

/** The contract to read: the configured one, or the only active one. */
async function resolveContract(session, config) {
  const contracts = await apexAction(session, APEX.CONTRACTS);
  const ids = Array.isArray(contracts) ? contracts.map(String) : [];

  if (config.contract) {
    // The configured value may be the contract number rather than the id the
    // API uses, so accept a partial match before giving up.
    const match = ids.find((id) => id === config.contract || id.includes(config.contract));
    if (match) {
      return match;
    }
    if (ids.length === 0) {
      throw new PortalError('NO_CONTRACT', 'The account has no active contract.');
    }
    throw new PortalError(
      'CONTRACT_NOT_FOUND',
      `Contract "${config.contract}" is not among the active ones (${ids.join(', ')}).`,
    );
  }

  if (ids.length === 0) {
    throw new PortalError('NO_CONTRACT', 'The account has no active contract.');
  }
  if (ids.length > 1) {
    logger.info(
      `Account holds ${ids.length} contracts, using ${ids[0]} — set one in the configuration to choose`,
    );
  }
  return ids[0];
}

/** The meter identifiers the consumption call needs. */
async function fetchMeter(session, contractId) {
  const details = await apexAction(session, APEX.CONTRACT_DETAILS, { contratId: contractId });
  const [meter] = details?.compteInfo ?? [];

  if (!meter?.ELEMB || !meter?.ELEMA) {
    throw new PortalError(
      'METER_NOT_FOUND',
      `No meter attached to contract ${contractId} — a meter that is not remotely read publishes no history.`,
    );
  }
  return { number: meter.ELEMB, pdsId: meter.ELEMA };
}

/** Call one Apex method and unwrap its return value. */
async function apexAction(session, { classname, method }, params, pageUri) {
  const response = await callAura(
    session,
    [
      {
        id: '1;a',
        descriptor: 'aura://ApexActionController/ACTION$execute',
        callingDescriptor: 'UNKNOWN',
        params: {
          namespace: '',
          classname,
          method,
          cacheable: false,
          isContinuation: false,
          ...(params ? { params } : {}),
        },
      },
    ],
    { pageUri },
  );

  const [action] = response.actions ?? [];
  if (!action) {
    throw new PortalError('APEX_NO_RESPONSE', `${classname}.${method} returned nothing`);
  }
  if (action.state !== 'SUCCESS') {
    throw new PortalError(
      'APEX_FAILED',
      `${classname}.${method} failed: ${describeAuraError(action.error) ?? action.state}`,
    );
  }

  // Apex results arrive either bare or wrapped in a second `returnValue`.
  const value = action.returnValue;
  return value && typeof value === 'object' && 'returnValue' in value ? value.returnValue : value;
}

/**
 * One row of the history.
 *
 * Units matter here and differ from the CSV export the portal offers to
 * humans: `CONSOMMATION` is in CUBIC METERS (0.150 = 150 L) and `VALEUR_INDEX`
 * is the meter index, also in cubic meters — where the CSV gives both in
 * litres. Getting this backwards puts a household meter at a million m³.
 *
 * @returns {Reading|null}
 */
function toReading(raw) {
  const day = String(raw?.DATE_INDEX ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return null;
  }

  const consumptionCubicMeters = toNumber(raw.CONSOMMATION);
  const indexCubicMeters = toNumber(raw.VALEUR_INDEX);
  if (consumptionCubicMeters === null || indexCubicMeters === null) {
    return null;
  }

  return {
    date: day,
    // Noon UTC: readings are days, not instants, and a timezone must not be
    // able to shift a whole history by one.
    at: new Date(`${day}T12:00:00.000Z`),
    indexCubicMeters,
    consumptionLiters: Math.round(consumptionCubicMeters * 1000),
    estimated: ['true', '1', 'yes'].includes(String(raw.FLAG_ESTIMATION ?? '').toLowerCase()),
  };
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function describeAuraError(error) {
  if (!error) {
    return null;
  }
  const list = Array.isArray(error) ? error : [error];
  const message = list
    .map((entry) => entry?.message ?? entry?.event ?? '')
    .filter(Boolean)
    .join('; ');
  return message || null;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}
