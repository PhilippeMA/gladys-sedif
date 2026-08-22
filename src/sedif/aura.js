// -----------------------------------------------------------------------------
// Transport for the Salesforce Aura endpoint of the customer portal.
//
// This is the layer the whole integration used to need a headless Chromium
// for. The portal is a Salesforce Experience Cloud site, and its Lightning
// pages talk to `/s/sfsites/aura` — an endpoint that speaks plain
// form-encoded HTTP once you carry the three things a browser carries:
//
//   1. `fwuid` and the app descriptor, scraped from the page HTML. They
//      identify the exact build of the Lightning app and change with every
//      Salesforce release, which is why they are read at runtime and never
//      hard-coded;
//   2. the session cookies, kept across requests (there is no login token to
//      pass around: the frontdoor redirect sets cookies, like in a browser);
//   3. the CSRF token, which the portal hands back in a cookie whose name
//      contains `ERIC`, and which every later call must echo in `aura.token`.
//
// Credit where it is due: the protocol was reverse-engineered by TimoPtr in
// pyeauidf (https://github.com/TimoPtr/pyeauidf, Apache-2.0). This is an
// independent JavaScript implementation of the same, documented exchange.
//
// TLS NOTE — this is not paranoia, it is the reason a plain `fetch()` fails:
// the portal serves an INCOMPLETE certificate chain. It sends its leaf without
// the Gandi intermediate that signs it. Browsers repair that themselves by
// fetching the missing certificate (AIA); Node does not, and reports
// UNABLE_TO_VERIFY_LEAF_SIGNATURE on a perfectly healthy connection. So we
// hand Node the missing intermediate alongside its own root store — which
// keeps full verification on, rather than turning it off.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@gladysassistant/integration-sdk';
import { PortalError } from './errors.js';

const logger = createLogger({ name: 'aura' });

export const BASE_URL = 'https://connexion.leaudiledefrance.fr';

/** Overridable so the tests can point the client at a stand-in portal. */
export function baseUrl() {
  return process.env.SEDIF_BASE_URL || BASE_URL;
}

const AURA_PATH = '/s/sfsites/aura';

// The Lightning app that serves the login form, and the one that serves the
// signed-in community. The context must name the right one or the endpoint
// rejects the call.
export const LOGIN_APP = 'siteforce:loginApp2';
export const COMMUNITY_APP = 'siteforce:communityApp';

// Where a signed-in individual customer lands. Also the `startUrl` the login
// action is asked to redirect to.
export const CUSTOMER_SPACE = '/espace-particuliers/s/';

const FWUID_RE = /"fwuid"\s*:\s*"([^"]+)"/;
const appDescriptorRe = (app) =>
  new RegExp(`"APPLICATION@markup://${app.replace(':', ':')}"\\s*:\\s*"([^"]+)"`);

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Node's own roots PLUS the intermediate the portal forgets to send, PLUS
 * anything `SEDIF_EXTRA_CA_FILE` points at (a company proxy's CA, or the
 * stand-in portal in the tests).
 *
 * Memoized on that variable so the common case costs nothing and a test can
 * still change it.
 */
let caCache = { key: undefined, bundle: null };

export function caBundle() {
  const extraPath = process.env.SEDIF_EXTRA_CA_FILE || '';
  if (caCache.key === extraPath && caCache.bundle) {
    return caCache.bundle;
  }

  const bundle = [...tls.rootCertificates];
  const here = path.dirname(fileURLToPath(import.meta.url));

  for (const [file, required] of [
    [path.join(here, '../../certs/gandi_intermediate.pem'), true],
    [extraPath, false],
  ]) {
    if (!file) {
      continue;
    }
    try {
      bundle.push(readFileSync(file, 'utf8'));
    } catch (err) {
      if (required) {
        logger.warn(
          `Could not load the portal's intermediate certificate (${err.message}); ` +
            'TLS verification may fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE.',
        );
      } else {
        logger.warn(`SEDIF_EXTRA_CA_FILE could not be read: ${err.message}`);
      }
    }
  }

  caCache = { key: extraPath, bundle };
  return bundle;
}

/**
 * One session against the portal: cookies, Lightning app context, CSRF token.
 * Cheap enough to build per refresh — there is no browser behind it.
 */
export class AuraSession {
  constructor() {
    /** @type {Map<string, string>} cookie name -> value */
    this.cookies = new Map();
    this.fwuid = null;
    this.appLoaded = {};
    this.token = null;
  }

  /** The `aura.context` field: which app build the caller is speaking for. */
  buildContext(app) {
    return {
      mode: 'PROD',
      fwuid: this.fwuid,
      app,
      loaded: this.appLoaded,
      dn: [],
      globals: {},
      uad: true,
    };
  }

  /** Read `fwuid` and the app descriptor out of a Lightning page. */
  absorbPage(html, app) {
    const fwuid = html.match(FWUID_RE);
    if (fwuid) {
      this.fwuid = fwuid[1];
    }
    const descriptor = html.match(appDescriptorRe(app));
    if (descriptor) {
      this.appLoaded = { [`APPLICATION@markup://${app}`]: descriptor[1] };
    }
    return Boolean(fwuid);
  }

  /**
   * The CSRF token the portal expects back in `aura.token`. It arrives as a
   * cookie whose name contains `ERIC` (today `__Host-ERIC`); matching on the
   * substring survives the prefix changing.
   */
  captureToken() {
    for (const [name, value] of this.cookies) {
      if (name.includes('ERIC')) {
        this.token = value;
        return true;
      }
    }
    return false;
  }

  storeCookies(setCookieHeaders = []) {
    for (const header of setCookieHeaders) {
      const [pair] = header.split(';');
      const separator = pair.indexOf('=');
      if (separator > 0) {
        this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
    }
  }

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

/**
 * One HTTPS request, with the repaired certificate chain and the session
 * cookies. Deliberately `node:https` rather than `fetch`: it is the only way
 * to hand Node an extra CA without touching global state or adding a
 * dependency.
 *
 * @returns {Promise<{ status: number, body: string, headers: object }>}
 */
export function httpRequest(session, { method, url, body, headers = {}, redirect = 'follow' }) {
  const target = new URL(url);

  return new Promise((resolve, reject) => {
    const req = request(
      {
        method,
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        ca: caBundle(),
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          ...(session.cookieHeader() ? { Cookie: session.cookieHeader() } : {}),
          ...headers,
        },
      },
      (res) => {
        session.storeCookies(res.headers['set-cookie'] ?? []);

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', async () => {
          const text = Buffer.concat(chunks).toString('utf8');

          // The login flow ends on a `frontdoor.jsp` redirect chain whose whole
          // purpose is to set cookies: follow it, or there is no session.
          const location = res.headers.location;
          if (redirect === 'follow' && res.statusCode >= 300 && res.statusCode < 400 && location) {
            try {
              resolve(
                await httpRequest(session, {
                  method: 'GET',
                  url: new URL(location, url).toString(),
                  headers,
                }),
              );
            } catch (err) {
              reject(err);
            }
            return;
          }

          resolve({ status: res.statusCode, body: text, headers: res.headers });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new PortalError('PORTAL_TIMEOUT', `No answer from ${target.host} in 30 s`));
    });
    req.on('error', (err) => reject(translateTransportError(err, target)));

    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

/** Turn Node's transport codes into something a user can act on. */
function translateTransportError(err, target) {
  if (err instanceof PortalError) {
    return err;
  }
  switch (err.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new PortalError(
        'PORTAL_UNREACHABLE',
        `DNS cannot resolve ${target.hostname} from the integration container (${err.code}).`,
      );
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'ECONNRESET':
      return new PortalError(
        'PORTAL_UNREACHABLE',
        `Cannot reach ${target.host} (${err.code}) — check the container's network access.`,
      );
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return new PortalError(
        'PORTAL_TLS_FAILED',
        `The portal's certificate chain could not be verified (${err.code}). ` +
          'It serves an incomplete chain; the intermediate shipped in certs/ should repair it.',
      );
    default:
      return new PortalError(
        'PORTAL_REQUEST_FAILED',
        `${err.code ?? 'Request failed'}: ${err.message}`,
      );
  }
}

/** GET a page and feed its Lightning context into the session. */
export async function loadPage(session, pathname, app) {
  const url = `${baseUrl()}${pathname}`;
  logger.debug(`GET ${url}`);
  const { status, body } = await httpRequest(session, { method: 'GET', url });

  if (status !== 200) {
    throw new PortalError('PORTAL_HTTP_ERROR', `${pathname} answered HTTP ${status}`);
  }
  return { html: body, gotContext: session.absorbPage(body, app) };
}

/**
 * The query-string marker Salesforce expects for one action, e.g.
 * `apex://LightningLoginFormController/ACTION$login` ->
 * `other.LightningLoginFormController.login=1`.
 *
 * A browser announces every action this way on top of the POST body. The
 * controller name lives in the segment BEFORE `/ACTION$`, so splitting on `/`
 * and keeping the last piece — as the reference Python client does — silently
 * produces `other..login=1`. The endpoint tolerates that; there is no reason to
 * ship the malformed version.
 */
export function auraMarker(descriptor) {
  if (descriptor.includes('ApexActionController')) {
    return 'aura.ApexAction.execute=1';
  }
  const match = descriptor.match(/^[a-z]+:\/\/(.+)\/ACTION\$(.+)$/);
  return match ? `other.${match[1]}.${match[2]}=1` : 'other.unknown=1';
}

/**
 * Aura wraps its JSON in an anti-CSRF prefix (and sometimes a suffix). The
 * payload is everything between the first `{` and the last `}`.
 */
export function stripAuraWrapper(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end !== -1 ? text.slice(start, end + 1) : text;
}

/**
 * Post one or more Aura actions.
 *
 * The query string is not decoration: Salesforce expects each action to be
 * announced there (`aura.ApexAction.execute=1`, `other.<Controller>.<method>=1`)
 * on top of the POST body.
 */
export async function callAura(session, actions, { app = COMMUNITY_APP, pageUri } = {}) {
  const markers = new Set(actions.map((action) => auraMarker(action.descriptor ?? '')));

  const url = `${baseUrl()}${AURA_PATH}?${['r=0', ...markers].join('&')}`;
  const body = new URLSearchParams({
    message: JSON.stringify({ actions }),
    'aura.context': JSON.stringify(session.buildContext(app)),
    'aura.pageURI': pageUri ?? CUSTOMER_SPACE,
    'aura.token': session.token ?? 'undefined',
  }).toString();

  const { status, body: text } = await httpRequest(session, {
    method: 'POST',
    url,
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
  });

  if (status !== 200) {
    throw new PortalError(
      'AURA_HTTP_ERROR',
      `The Aura endpoint answered HTTP ${status}` +
        (status === 401 || status === 403 ? ' — the session or CSRF token was refused' : ''),
    );
  }

  let payload;
  try {
    payload = JSON.parse(stripAuraWrapper(text));
  } catch {
    throw new PortalError(
      'AURA_BAD_RESPONSE',
      `The Aura endpoint did not answer JSON (${text.slice(0, 120)}...)`,
    );
  }

  // Salesforce hands back a refreshed context on almost every call; carrying it
  // forward is what keeps a long session from drifting out of date.
  const context = payload.context ?? {};
  if (context.fwuid) {
    session.fwuid = context.fwuid;
  }
  if (context.loaded) {
    session.appLoaded = context.loaded;
  }

  return payload;
}
