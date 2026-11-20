// -----------------------------------------------------------------------------
// Chain repair: fetch the intermediate certificate the portal does not send.
//
// WHY THIS EXISTS. The portal serves an INCOMPLETE chain: the leaf alone,
// without the intermediate that signs it. A browser repairs that by itself —
// it reads the `authorityInfoAccess` extension of the leaf, which names the
// URL of the issuing certificate, downloads it and completes the chain. Node
// does not, and reports UNABLE_TO_VERIFY_LEAF_SIGNATURE on a connection that
// is in fact perfectly healthy.
//
// Version 1.0 shipped the one intermediate in use at the time
// (certs/gandi_intermediate.pem). That works until the day the site rotates
// its certificate to another CA — and then the integration stops dead, with a
// message the user cannot act on, until a new release ships a new file. This
// module removes that failure mode: the missing certificate is fetched the way
// a browser fetches it, from the URL the leaf itself names.
//
// WHY THIS IS NOT A HOLE IN THE VERIFICATION. Nothing here is trusted on its
// own:
//
//   - the AIA URL is read from the leaf over a connection opened with
//     `rejectUnauthorized: false`, but that connection carries NO request and
//     NO data: it is opened to look at the certificate and closed at once;
//   - a downloaded certificate is accepted as a candidate only if it is a CA
//     certificate that really issued the certificate below it, which
//     `checkIssued` verifies by signature;
//   - the candidate is then handed to the REAL request as one more possible
//     intermediate, with verification fully on. It still has to chain to a
//     root in Node's own store. An attacker who controlled the AIA URL could
//     therefore only serve a certificate that changes nothing: a forged chain
//     has no trusted root at its end, and the retry fails exactly as it did
//     before.
//
// In other words: this completes a chain, it never decides to trust one.
// -----------------------------------------------------------------------------

import { X509Certificate } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'chain' });

// A chain this deep is already unusual for a public web site; the loop is
// bounded so a certificate pointing at itself cannot spin forever.
const MAX_HOPS = 3;

const PEEK_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;

// A certificate is a couple of kilobytes. This is a ceiling against a URL
// that answers with something else entirely, not a tuned value.
const MAX_CERT_BYTES = 64 * 1024;

/**
 * Walk up from the server's leaf certificate, following the `CA Issuers` URL
 * of each certificate, and return the intermediates that were missing.
 *
 * @param {object} target - `{ hostname, port }` of the portal.
 * @returns {Promise<string[]>} the fetched certificates, in PEM form, leaf-most
 *   first. Empty when the chain needs no repair, names no issuer URL, or the
 *   download does not produce a usable certificate.
 */
export async function fetchMissingIntermediates({ hostname, port = 443, trustedCas = [] }) {
  const trustedSubjects = subjectsOf(trustedCas);
  const fetched = [];

  let current = await peekLeafCertificate({ hostname, port });
  if (!current) {
    return fetched;
  }

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    // Stop as soon as the certificate above is one the client already trusts:
    // from there the chain is complete and nothing more needs downloading.
    if (trustedSubjects.has(current.issuer) || current.subject === current.issuer) {
      break;
    }

    const url = caIssuersUrl(current);
    if (!url) {
      // Only worth a warning while nothing has been repaired yet: once a
      // certificate has been fetched, the retry decides whether it was enough.
      if (fetched.length === 0) {
        logger.warn(
          `The certificate of ${current.subject} names no CA Issuers URL, ` +
            'so the missing intermediate cannot be fetched automatically.',
        );
      }
      break;
    }

    let candidate;
    try {
      candidate = parseCertificate(await download(url));
    } catch (err) {
      logger.warn(`Could not use the certificate at ${url}: ${err.message}`);
      break;
    }

    // It must be a CA certificate, and it must really be the one that signed
    // the certificate below it — verified by signature, not by name.
    if (!candidate.ca) {
      logger.warn(`${url} did not serve a CA certificate; ignoring it.`);
      break;
    }
    if (!current.checkIssued(candidate)) {
      logger.warn(`The certificate at ${url} did not issue ${current.subject}; ignoring it.`);
      break;
    }

    logger.info(`Fetched the missing intermediate from ${url}: ${candidate.subject}`);
    fetched.push(candidate.toString());
    current = candidate;
  }

  return fetched;
}

/**
 * Open a TLS connection for the sole purpose of reading the certificate the
 * server presents, and close it immediately. Verification is off BECAUSE the
 * chain is known to be broken — that is the thing being diagnosed — and this
 * connection is never used to send or read anything.
 *
 * @returns {Promise<X509Certificate|null>}
 */
function peekLeafCertificate({ hostname, port }) {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: hostname,
        port,
        // RFC 6066 forbids an IP literal as the SNI name, and Node warns about
        // it. Only a real host name is sent — the tests connect to 127.0.0.1.
        ...(isIpLiteral(hostname) ? {} : { servername: hostname }),
        rejectUnauthorized: false,
      },
      () => {
        // `raw` is the DER of the leaf; the detailed form also carries the
        // chain, which is exactly what this server does not send.
        const peer = socket.getPeerCertificate(false);
        socket.destroy();
        if (!peer?.raw) {
          resolve(null);
          return;
        }
        try {
          resolve(new X509Certificate(peer.raw));
        } catch {
          resolve(null);
        }
      },
    );

    socket.setTimeout(PEEK_TIMEOUT_MS, () => socket.destroy());
    socket.on('timeout', () => socket.destroy());
    socket.on('error', (err) => {
      logger.warn(`Could not read the portal's certificate: ${err.message}`);
      resolve(null);
    });
    socket.on('close', () => resolve(null));
  });
}

/** True for an IPv4 or IPv6 literal, which must not be sent as an SNI name. */
function isIpLiteral(hostname) {
  return isIP(hostname) !== 0;
}

/** The first usable `CA Issuers - URI` of a certificate's AIA extension. */
function caIssuersUrl(certificate) {
  // Node exposes the extension as free text, one entry per line, e.g.
  //   OCSP - URI:http://ocsp.example.net
  //   CA Issuers - URI:http://crt.example.net/issuer.crt
  const lines = (certificate.infoAccess ?? '').split('\n');
  for (const line of lines) {
    const match = /^CA Issuers - URI:(.+)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const url = match[1].trim();
    // Certificates are signed objects, so plain HTTP is normal here and is
    // what CAs publish; anything that is not HTTP(S) is not followed.
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
  }
  return null;
}

/** GET a URL and return at most MAX_CERT_BYTES of body. */
function download(url) {
  const get = url.startsWith('https://') ? httpsGet : httpGet;

  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_CERT_BYTES) {
          req.destroy();
          reject(new Error(`the answer exceeds ${MAX_CERT_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });

    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/**
 * Read a certificate served either as PEM (text) or as DER (binary, which is
 * what `.crt` URLs of most CAs return).
 */
function parseCertificate(buffer) {
  const asText = buffer.toString('latin1');
  if (asText.includes('-----BEGIN CERTIFICATE-----')) {
    return new X509Certificate(buffer.toString('utf8'));
  }
  return new X509Certificate(buffer);
}

/**
 * The subjects of the certificates the client already trusts, so the walk
 * stops as soon as it reaches one. Memoized on the array itself: the bundle is
 * rebuilt rarely and parsing ~150 roots is not free.
 */
let subjectCache = { cas: null, subjects: null };

function subjectsOf(cas) {
  if (subjectCache.cas === cas) {
    return subjectCache.subjects;
  }
  const subjects = new Set();
  for (const pem of cas) {
    try {
      subjects.add(new X509Certificate(pem).subject);
    } catch {
      // A certificate that cannot be parsed is simply not a stopping point.
    }
  }
  subjectCache = { cas, subjects };
  return subjects;
}
