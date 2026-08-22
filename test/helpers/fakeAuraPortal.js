// -----------------------------------------------------------------------------
// A stand-in for the portal's Salesforce Aura endpoint, over real HTTPS.
//
// It is not a Salesforce emulator: it is the exact set of exchanges the client
// depends on, answering the shapes the real portal answers. That makes the
// whole protocol testable without an account — the login handshake, the
// frontdoor redirect that sets the session cookies, the CSRF token, the Apex
// calls and their return-value wrapping.
//
// It runs over TLS with a self-signed certificate on purpose: the client uses
// `node:https` with an explicit CA list precisely because the real portal
// serves an incomplete chain, and that code path deserves to be exercised.
// -----------------------------------------------------------------------------

import { createServer } from 'node:https';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FWUID_LOGIN = 'FWUID-LOGIN-1';
const FWUID_COMMUNITY = 'FWUID-COMMUNITY-2';

const loginPageHtml = `<!doctype html><html><head><script>
window.Aura = {"fwuid":"${FWUID_LOGIN}","APPLICATION@markup://siteforce:loginApp2":"LOGINAPP-DESCRIPTOR"};
</script></head><body><h1>Connexion</h1></body></html>`;

const communityPageHtml = `<!doctype html><html><head><script>
window.Aura = {"fwuid":"${FWUID_COMMUNITY}","APPLICATION@markup://siteforce:communityApp":"COMMUNITYAPP-DESCRIPTOR"};
</script></head><body><h1>Espace client</h1></body></html>`;

/** Aura prefixes its JSON with an anti-CSRF guard; the client must strip it. */
const auraBody = (payload) => `while(1);\n${JSON.stringify(payload)}`;

/**
 * A throw-away certificate for 127.0.0.1. Generated with the `openssl` CLI —
 * Node has no certificate-signing API — and handed to the client as its extra
 * CA, which is exactly the shape of the real "missing intermediate" fix.
 */
function selfSignedCert() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sedif-cert-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '2',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);
  const key = readFileSync(keyPath, 'utf8');
  const cert = readFileSync(certPath, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  // Prove the pair is usable before a test blames the server for it.
  createPrivateKey(key);
  new X509Certificate(cert);
  return { key, cert };
}

/**
 * Start the stand-in portal.
 *
 * @param {object} [options]
 * @param {Array} [options.records]      CONSOMMATION rows to serve
 * @param {string[]} [options.contracts] active contract ids
 * @param {string} [options.loginError]  make the login answer this error text
 * @param {number} [options.price]       prixMoyenEau
 * @param {boolean} [options.noMeter]    answer a contract with no meter
 */
export async function startFakeAuraPortal({
  records = [],
  contracts = ['CTR-001'],
  loginError = null,
  price = 4.2345,
  noMeter = false,
} = {}) {
  const { key, cert } = selfSignedCert();
  /** Every Aura call the client made, for assertions. */
  const calls = [];

  const server = createServer({ key, cert }, (req, res) => {
    const url = new URL(req.url, 'https://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/s/login/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(loginPageHtml);
      return;
    }

    // The frontdoor: its whole job is to set the session cookies, including
    // the one carrying the CSRF token.
    if (req.method === 'GET' && url.pathname === '/secur/frontdoor.jsp') {
      res.setHeader('set-cookie', [
        'sid=SESSION-ID; Path=/; HttpOnly',
        '__Host-ERIC=CSRF-TOKEN-XYZ; Path=/; Secure',
      ]);
      res.statusCode = 302;
      res.setHeader('location', '/s/');
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/s/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(communityPageHtml);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/s/sfsites/aura') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const message = JSON.parse(form.get('message'));
        const [action] = message.actions;
        const call = {
          query: url.search,
          descriptor: action.descriptor,
          params: action.params,
          context: JSON.parse(form.get('aura.context')),
          token: form.get('aura.token'),
          pageUri: form.get('aura.pageURI'),
          cookie: req.headers.cookie ?? '',
        };
        calls.push(call);

        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(auraBody(respond(call)));
      });
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  function respond(call) {
    const context = { fwuid: FWUID_COMMUNITY, loaded: {} };

    if (call.descriptor.includes('LightningLoginFormController')) {
      if (loginError) {
        // The real portal answers a SUCCESSFUL action carrying the error text.
        return {
          actions: [{ id: '1;a', state: 'SUCCESS', returnValue: loginError }],
          context,
        };
      }
      return {
        actions: [{ id: '1;a', state: 'SUCCESS', returnValue: null }],
        events: [
          {
            descriptor: 'markup://aura:clientRedirect',
            attributes: { values: { url: `${origin()}/secur/frontdoor.jsp?sid=SESSION-ID` } },
          },
        ],
        context,
      };
    }

    const { classname, params } = call.params;

    if (classname === 'LTN009_ICL_ContratsGroupements') {
      return { actions: [{ state: 'SUCCESS', returnValue: { returnValue: contracts } }], context };
    }

    if (classname === 'LTN008_ICL_ContratDetails') {
      if (noMeter) {
        return { actions: [{ state: 'SUCCESS', returnValue: { compteInfo: [] } }], context };
      }
      return {
        actions: [
          {
            state: 'SUCCESS',
            returnValue: {
              returnValue: {
                compteInfo: [
                  { ELEMB: `METER-${params.contratId}`, ELEMA: `PDS-${params.contratId}` },
                ],
              },
            },
          },
        ],
        context,
      };
    }

    if (classname === 'LTN015_ICL_ContratConsoHisto') {
      return {
        actions: [
          {
            state: 'SUCCESS',
            returnValue: {
              returnValue: { prixMoyenEau: price, data: { CONSOMMATION: records } },
            },
          },
        ],
        context,
      };
    }

    return {
      actions: [{ state: 'ERROR', error: [{ message: `Unknown Apex class ${classname}` }] }],
      context,
    };
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = () => `https://127.0.0.1:${port}`;

  return {
    origin: origin(),
    ca: cert,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Write the server's certificate where the client looks for its extra CA. */
export function writeExtraCa(cert, targetPath) {
  writeFileSync(targetPath, cert, 'utf8');
}
