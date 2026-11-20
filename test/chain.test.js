// -----------------------------------------------------------------------------
// The chain repair, against a portal that reproduces the production failure:
// an HTTPS server sending its leaf certificate without the intermediate.
//
// This is the regression test for the outage of 2026-11-20. Version 1.0.2
// shipped one intermediate in certs/; the site rotated its certificate and
// every refresh died on UNABLE_TO_VERIFY_LEAF_SIGNATURE until a new release.
//
// The storage module reads its directory from the environment at import time,
// so the variable is set BEFORE the dynamic imports below.
// -----------------------------------------------------------------------------

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startIncompleteChainPortal } from './helpers/incompleteChainPortal.js';

const stateDir = await mkdtemp(path.join(tmpdir(), 'gladys-sedif-chain-'));
process.env.GLADYS_SEDIF_STATE_DIR = stateDir;

const { AuraSession, caBundle, httpRequest, resetChainState } =
  await import('../src/sedif/aura.js');

after(() => rm(stateDir, { recursive: true, force: true }));

beforeEach(async () => {
  resetChainState();
  await rm(path.join(stateDir, 'chain.pem'), { force: true });
});

/** Trust the test root only; the intermediate must be fetched, not given. */
function trustOnly(rootCertFile) {
  process.env.SEDIF_EXTRA_CA_FILE = rootCertFile;
  resetChainState();
}

test('an incomplete chain is repaired from the address the leaf names', async () => {
  const portal = await startIncompleteChainPortal();
  trustOnly(portal.rootCertFile);

  try {
    const { status } = await httpRequest(new AuraSession(), {
      method: 'GET',
      url: `${portal.baseUrl}/s/login/`,
    });

    // The connection succeeded although the server never sent the
    // intermediate: the client went and got it.
    assert.equal(status, 200);
    assert.deepEqual(portal.aiaHits, ['/intermediate.der']);
  } finally {
    await portal.close();
    delete process.env.SEDIF_EXTRA_CA_FILE;
  }
});

test('the fetched certificate is kept, and not downloaded twice', async () => {
  const portal = await startIncompleteChainPortal();
  trustOnly(portal.rootCertFile);

  try {
    await httpRequest(new AuraSession(), { method: 'GET', url: `${portal.baseUrl}/one` });
    await httpRequest(new AuraSession(), { method: 'GET', url: `${portal.baseUrl}/two` });

    // One download, whatever the number of requests.
    assert.equal(portal.aiaHits.length, 1);

    // And it survives a restart: the certificate is on the volume.
    const saved = await readFile(path.join(stateDir, 'chain.pem'), 'utf8');
    const expected = await readFile(portal.intermediateFile, 'utf8');
    assert.ok(
      saved.includes(expected.trim()),
      'the fetched intermediate should be persisted on /data',
    );

    // It is in the CA bundle handed to Node, on top of its own roots.
    assert.ok(caBundle().some((pem) => pem.trim() === expected.trim()));
  } finally {
    await portal.close();
    delete process.env.SEDIF_EXTRA_CA_FILE;
  }
});

test('a chain that cannot be repaired fails with an actionable message', async () => {
  // The address the leaf names answers 404: nothing can complete the chain,
  // and the user must be told what to do rather than read a Node error code.
  const portal = await startIncompleteChainPortal({ serveIntermediate: false });
  trustOnly(portal.rootCertFile);

  try {
    await assert.rejects(
      () => httpRequest(new AuraSession(), { method: 'GET', url: `${portal.baseUrl}/s/login/` }),
      (err) => {
        assert.equal(err.code, 'PORTAL_TLS_FAILED');
        assert.match(err.message, /incomplete chain/);
        assert.match(err.message, /SEDIF_EXTRA_CA_FILE/);
        return true;
      },
    );
    assert.equal(portal.aiaHits.length, 1, 'the fetch should have been attempted once');
  } finally {
    await portal.close();
    delete process.env.SEDIF_EXTRA_CA_FILE;
  }
});

test('the repair is not retried on every request', async () => {
  // A portal broken for some other reason must not turn each request into a
  // certificate download.
  const portal = await startIncompleteChainPortal({ serveIntermediate: false });
  trustOnly(portal.rootCertFile);

  try {
    for (const path_ of ['/a', '/b', '/c']) {
      await assert.rejects(() =>
        httpRequest(new AuraSession(), { method: 'GET', url: `${portal.baseUrl}${path_}` }),
      );
    }
    assert.equal(portal.aiaHits.length, 1, 'only the first failure should fetch');
  } finally {
    await portal.close();
    delete process.env.SEDIF_EXTRA_CA_FILE;
  }
});
