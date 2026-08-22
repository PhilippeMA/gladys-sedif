// -----------------------------------------------------------------------------
// The Aura protocol, end to end, against a stand-in portal served over real
// HTTPS (see test/helpers/fakeAuraPortal.js).
//
// This does NOT prove the Apex class names still match the live portal — only
// a run against the real site can. It proves everything around them: the login
// handshake, the frontdoor redirect that creates the session, the CSRF token
// echoed on every later call, the Apex return-value unwrapping, the anti-CSRF
// prefix, and the units — which differ from the CSV export and are the easiest
// thing to get catastrophically wrong.
// -----------------------------------------------------------------------------

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFakeAuraPortal } from './helpers/fakeAuraPortal.js';
import { normalizeConfig } from '../src/config.js';

const RECORDS = [
  {
    DATE_INDEX: '2026-08-05 00:00:00',
    CONSOMMATION: '0.120',
    VALEUR_INDEX: '1234.000',
    FLAG_ESTIMATION: 'false',
  },
  {
    DATE_INDEX: '2026-08-06 00:00:00',
    CONSOMMATION: '0.150',
    VALEUR_INDEX: '1234.150',
    FLAG_ESTIMATION: 'false',
  },
  {
    DATE_INDEX: '2026-08-07 00:00:00',
    CONSOMMATION: '0.150',
    VALEUR_INDEX: '1234.300',
    FLAG_ESTIMATION: 'true',
  },
];

const CONFIG = normalizeConfig({
  email: 'user@example.com',
  password: 'secret',
  history_days: 90,
});

let workDir;

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'sedif-api-'));
});

after(() => {
  delete process.env.SEDIF_BASE_URL;
  delete process.env.SEDIF_EXTRA_CA_FILE;
});

/** Point the client at a stand-in portal, trusting its certificate. */
async function withPortal(options, run) {
  const portal = await startFakeAuraPortal(options);
  const caFile = path.join(workDir, `ca-${Date.now()}-${Math.random()}.pem`);
  await writeFile(caFile, portal.ca, 'utf8');

  process.env.SEDIF_BASE_URL = portal.origin;
  process.env.SEDIF_EXTRA_CA_FILE = caFile;

  const { fetchConsumption } = await import('../src/sedif/api.js');
  try {
    return await run(portal, fetchConsumption);
  } finally {
    await portal.close();
  }
}

test('signs in and brings back the daily history', async () => {
  await withPortal({ records: RECORDS }, async (portal, fetchConsumption) => {
    const result = await fetchConsumption(CONFIG);

    assert.equal(result.contract, 'CTR-001');
    assert.equal(result.pricePerCubicMeter, 4.2345);
    assert.deepEqual(
      result.readings.map((r) => r.date),
      ['2026-08-05', '2026-08-06', '2026-08-07'],
    );
  });
});

test('reads the units the API uses, not the ones the CSV uses', async () => {
  // CONSOMMATION is in CUBIC METERS (0.150 = 150 L) and VALEUR_INDEX is the
  // index, also in cubic meters. The CSV export gives both in litres. Getting
  // this backwards puts a household meter at a million m³.
  await withPortal({ records: RECORDS }, async (portal, fetchConsumption) => {
    const [first] = (await fetchConsumption(CONFIG)).readings;
    assert.equal(first.indexCubicMeters, 1234);
    assert.equal(first.consumptionLiters, 120);
    assert.equal(first.at.toISOString(), '2026-08-05T12:00:00.000Z');
  });
});

test('carries the estimated flag through', async () => {
  await withPortal({ records: RECORDS }, async (portal, fetchConsumption) => {
    const { readings } = await fetchConsumption(CONFIG);
    assert.deepEqual(
      readings.map((r) => r.estimated),
      [false, false, true],
    );
  });
});

test('speaks the handshake the portal expects', async () => {
  await withPortal({ records: RECORDS }, async (portal, fetchConsumption) => {
    await fetchConsumption(CONFIG);

    const [login, ...rest] = portal.calls;

    // The login is announced in the query string, posted against the LOGIN app,
    // and carries no token yet.
    assert.match(login.query, /other\.LightningLoginFormController\.login=1/);
    assert.equal(login.context.app, 'siteforce:loginApp2');
    assert.equal(login.context.fwuid, 'FWUID-LOGIN-1');
    assert.equal(login.token, 'undefined');
    assert.equal(login.params.username, CONFIG.email);

    // Everything after it runs as the COMMUNITY app, with the CSRF token the
    // frontdoor handed out and the session cookie.
    for (const call of rest) {
      assert.equal(call.context.app, 'siteforce:communityApp');
      assert.equal(call.token, 'CSRF-TOKEN-XYZ');
      assert.match(call.cookie, /sid=SESSION-ID/);
      assert.match(call.query, /aura\.ApexAction\.execute=1/);
    }

    // ...and in the documented order.
    assert.deepEqual(
      rest.map((call) => call.params.classname),
      [
        'LTN009_ICL_ContratsGroupements',
        'LTN008_ICL_ContratDetails',
        'LTN015_ICL_ContratConsoHisto',
      ],
    );
  });
});

test('asks for the meter of the contract, over the configured window', async () => {
  await withPortal({ records: RECORDS }, async (portal, fetchConsumption) => {
    await fetchConsumption(
      { ...CONFIG, history_days: 30 },
      { now: new Date('2026-08-08T09:00:00Z') },
    );

    const history = portal.calls.at(-1);
    assert.deepEqual(history.params.params, {
      contractId: 'CTR-001',
      TYPE_PAS: 'JOURNEE',
      DATE_DEBUT: '2026-07-09',
      DATE_FIN: '2026-08-08',
      NUMERO_COMPTEUR: 'METER-CTR-001',
      ID_PDS: 'PDS-CTR-001',
    });
    assert.equal(history.pageUri, '/espace-particuliers/s/historique');
  });
});

test('a wrong password is reported, not silently swallowed', async () => {
  // The real portal answers a SUCCESSFUL action whose value is the error text:
  // checking only the action state would treat this as a good login.
  await withPortal(
    { loginError: 'Votre identifiant ou votre mot de passe est incorrect.' },
    async (portal, fetchConsumption) => {
      await assert.rejects(
        () => fetchConsumption(CONFIG),
        (err) => {
          assert.equal(err.code, 'LOGIN_REFUSED');
          assert.match(err.message, /identifiant ou votre mot de passe/);
          return true;
        },
      );
    },
  );
});

test('picks the configured contract, and says so when it does not exist', async () => {
  await withPortal(
    { records: RECORDS, contracts: ['CTR-001', 'CTR-999'] },
    async (portal, fetchConsumption) => {
      const chosen = await fetchConsumption({ ...CONFIG, contract: 'CTR-999' });
      assert.equal(chosen.contract, 'CTR-999');

      await assert.rejects(
        () => fetchConsumption({ ...CONFIG, contract: 'CTR-404' }),
        (err) => {
          assert.equal(err.code, 'CONTRACT_NOT_FOUND');
          assert.match(err.message, /CTR-001, CTR-999/);
          return true;
        },
      );
    },
  );
});

test('a contract without a meter is explained, not left as a crash', async () => {
  await withPortal({ noMeter: true }, async (portal, fetchConsumption) => {
    await assert.rejects(
      () => fetchConsumption(CONFIG),
      (err) => {
        assert.equal(err.code, 'METER_NOT_FOUND');
        assert.match(err.message, /remotely read/);
        return true;
      },
    );
  });
});

test('an empty history is not an error', async () => {
  // A meter installed yesterday, or a portal that has not published yet.
  await withPortal({ records: [] }, async (portal, fetchConsumption) => {
    const { readings } = await fetchConsumption(CONFIG);
    assert.deepEqual(readings, []);
  });
});

test('the anti-CSRF prefix is stripped before parsing', async () => {
  const { stripAuraWrapper } = await import('../src/sedif/aura.js');
  assert.equal(stripAuraWrapper('while(1);\n{"a":1}'), '{"a":1}');
  assert.equal(stripAuraWrapper('{"a":1}'), '{"a":1}');
});

test('the shipped intermediate certificate is in the trust bundle', async () => {
  // Without it, the real portal fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE on a
  // perfectly good connection — the bug that cost a whole round of debugging.
  delete process.env.SEDIF_EXTRA_CA_FILE;
  const { caBundle } = await import('../src/sedif/aura.js');
  const bundle = caBundle();
  assert.ok(bundle.length > 100, 'the default root store should still be there');
  assert.ok(
    bundle.some((pem) => typeof pem === 'string' && pem.includes('BEGIN CERTIFICATE')),
    'the extra PEM should be loaded as text',
  );
});
