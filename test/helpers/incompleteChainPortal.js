// -----------------------------------------------------------------------------
// A stand-in portal that reproduces the real failure of November 2026: an HTTPS
// server serving a leaf certificate WITHOUT the intermediate that signs it.
//
// The shape is the real one, three levels deep:
//
//   root (trusted by the client, through SEDIF_EXTRA_CA_FILE)
//     └─ intermediate  ← NOT sent by the server; published over plain HTTP at
//                         the address the leaf names in its AIA extension,
//                         exactly as a certificate authority publishes it
//          └─ leaf     ← the only certificate the server sends
//
// With the intermediate missing, Node refuses the connection with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE — the production error. A client that chases
// the AIA URL completes the chain and connects, with verification on
// throughout: the fetched intermediate still has to lead to the trusted root.
//
// Certificates are generated with the `openssl` CLI (Node has no
// certificate-signing API), like the other portal helper here.
// -----------------------------------------------------------------------------

import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const openssl = (args) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Build root -> intermediate -> leaf, the leaf pointing at `aiaUrl`.
 * @param {string} dir - Directory to write the files in.
 * @param {string} aiaUrl - URL the leaf names as its CA Issuers address.
 */
function buildChain(dir, aiaUrl) {
  const file = (name) => path.join(dir, name);

  // Root: self-signed, the only thing the client will be told to trust.
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    file('root.key'),
    '-out',
    file('root.crt'),
    '-days',
    '2',
    '-subj',
    '/CN=SEDIF Test Root',
  ]);

  // Intermediate: a real CA certificate, signed by the root.
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    file('int.key'),
    '-out',
    file('int.csr'),
    '-subj',
    '/CN=SEDIF Test Intermediate',
  ]);
  writeFileSync(
    file('int.ext'),
    'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
  );
  openssl([
    'x509',
    '-req',
    '-in',
    file('int.csr'),
    '-CA',
    file('root.crt'),
    '-CAkey',
    file('root.key'),
    '-CAcreateserial',
    '-out',
    file('int.crt'),
    '-days',
    '2',
    '-extfile',
    file('int.ext'),
  ]);

  // Leaf: signed by the intermediate, and carrying the address where the
  // intermediate can be downloaded.
  openssl([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    file('leaf.key'),
    '-out',
    file('leaf.csr'),
    '-subj',
    '/CN=127.0.0.1',
  ]);
  writeFileSync(
    file('leaf.ext'),
    'subjectAltName=IP:127.0.0.1\n' +
      'basicConstraints=critical,CA:FALSE\n' +
      `authorityInfoAccess=caIssuers;URI:${aiaUrl}\n`,
  );
  openssl([
    'x509',
    '-req',
    '-in',
    file('leaf.csr'),
    '-CA',
    file('int.crt'),
    '-CAkey',
    file('int.key'),
    '-CAcreateserial',
    '-out',
    file('leaf.crt'),
    '-days',
    '2',
    '-extfile',
    file('leaf.ext'),
  ]);

  // CAs publish the DER form, which is what the client must also accept.
  openssl(['x509', '-in', file('int.crt'), '-outform', 'DER', '-out', file('int.der')]);
}

/**
 * Start the pair of servers.
 *
 * @param {object} [options] - Options.
 * @param {boolean} [options.serveIntermediate] - false makes the AIA address
 *   answer 404, which is the unrepairable case.
 * @returns {Promise<object>} `{ baseUrl, rootCertFile, aiaHits, close }`
 */
export async function startIncompleteChainPortal({ serveIntermediate = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sedif-chain-'));

  // The AIA address has to be baked into the leaf, so the server that answers
  // it must exist — and have its port — before the chain is built.
  const aiaHits = [];
  let derBody = null;
  const aiaServer = createHttpServer((req, res) => {
    aiaHits.push(req.url);
    if (!serveIntermediate || !derBody) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/pkix-cert' }).end(derBody);
  });
  await new Promise((resolve) => aiaServer.listen(0, '127.0.0.1', resolve));
  const aiaUrl = `http://127.0.0.1:${aiaServer.address().port}/intermediate.der`;

  buildChain(dir, aiaUrl);
  derBody = readFileSync(path.join(dir, 'int.der'));

  // The portal itself: it sends the LEAF ONLY, which is the whole point.
  const portal = createHttpsServer(
    {
      key: readFileSync(path.join(dir, 'leaf.key')),
      cert: readFileSync(path.join(dir, 'leaf.crt')),
    },
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>ok</html>');
    },
  );
  await new Promise((resolve) => portal.listen(0, '127.0.0.1', resolve));

  return {
    baseUrl: `https://127.0.0.1:${portal.address().port}`,
    rootCertFile: path.join(dir, 'root.crt'),
    intermediateFile: path.join(dir, 'int.crt'),
    aiaUrl,
    aiaHits,
    async close() {
      await new Promise((resolve) => portal.close(resolve));
      await new Promise((resolve) => aiaServer.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
