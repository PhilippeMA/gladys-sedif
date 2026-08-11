// -----------------------------------------------------------------------------
// The import path, end to end, with a canned CSV instead of a browser session:
// discovery payload, cursor arithmetic, batching and the transport badge.
//
// The storage module reads its directory from the environment at import time,
// so the variable is set BEFORE the dynamic imports below.
// -----------------------------------------------------------------------------

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakeGladys } from './helpers/fakeGladys.js';

const stateDir = await mkdtemp(path.join(tmpdir(), 'gladys-sedif-'));
process.env.GLADYS_SEDIF_STATE_DIR = stateDir;

const { waterMeter, resetBadgeState } = await import('../src/devices/waterMeter.js');
const { buildDiscoveredDevices, buildTransportEntries, refreshAllDevices } =
  await import('../src/devices/index.js');
const { normalizeConfig } = await import('../src/config.js');
const { clearCursor, readCursor } = await import('../src/storage.js');
const { contractKey } = await import('../src/sedif/index.js');

after(() => rm(stateDir, { recursive: true, force: true }));

const CONFIG = normalizeConfig({
  email: 'user@example.com',
  password: 'secret',
  contract: '1234567',
  history_days: 3650,
});

const CSV = [
  'Date;Index;Consommation;Methode',
  '2026-08-05 00:00:00;1234000;120;Mesuré',
  '2026-08-06 00:00:00;1234150;150;Mesuré',
  '2026-08-07 00:00:00;1234300;150;Estimé',
  '2026-08-08 00:00:00;1234414;114;Mesuré',
].join('\n');

/** Replaces the browser session with a canned export. */
const fromCsv = (csv) => ({ download: async () => csv });

beforeEach(async () => {
  resetBadgeState();
  await clearCursor(contractKey(CONFIG));
});

test('the device carries an index in m3 and a daily volume in litres', () => {
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, CONFIG);

  assert.equal(device.external_id, 'ext:sedif:water-meter:1234567');
  assert.deepEqual(
    device.features.map((f) => [f.unit, f.type, f.read_only, f.keep_history]),
    [
      ['cubicmeter', 'decimal', true, true],
      ['liter', 'integer', true, true],
    ],
  );
});

test('a device identity survives an empty contract number', () => {
  const gladys = createFakeGladys();
  const config = normalizeConfig({ email: 'User@Example.com', password: 'x' });
  const [device] = buildDiscoveredDevices(gladys, config);
  assert.equal(device.external_id, 'ext:sedif:water-meter:user-example-com');
});

test('the device declares NO poll_frequency', () => {
  // The core only accepts its six DEVICE_POLL_FREQUENCIES values (1 s to 1 min,
  // in milliseconds) and rejects the whole publish with "invalid poll
  // frequency" otherwise. A meter read once a day is refreshed by the
  // integration's own scheduler instead — see index.js.
  const gladys = createFakeGladys();
  const [device] = buildDiscoveredDevices(gladys, CONFIG);
  assert.equal(device.poll_frequency, undefined);
  assert.ok(!('poll_frequency' in device), 'the key must be absent, not undefined');
});

test('refreshAllDevices drives every blueprint that can refresh', async () => {
  const gladys = createFakeGladys();
  const published = await refreshAllDevices(gladys, CONFIG, fromCsv(CSV));
  assert.equal(published, 3);
  assert.equal(gladys.published.length, 6);
});

test('a first poll imports the measured days, each with its own date', async () => {
  const gladys = createFakeGladys();
  await waterMeter.refresh(gladys, CONFIG, fromCsv(CSV));

  const index = gladys.published.filter((p) => p.featureExternalId.endsWith(':index'));
  const daily = gladys.published.filter((p) => p.featureExternalId.endsWith(':daily-volume'));

  // The estimated day (2026-08-07) is not published.
  assert.deepEqual(
    index.map((p) => p.state),
    [1234, 1234.15, 1234.414],
  );
  assert.deepEqual(
    daily.map((p) => p.state),
    [120, 150, 114],
  );
  assert.deepEqual(
    daily.map((p) => p.created_at.toISOString()),
    ['2026-08-05T12:00:00.000Z', '2026-08-06T12:00:00.000Z', '2026-08-08T12:00:00.000Z'],
  );
});

test('a second poll on the same export publishes nothing', async () => {
  const first = createFakeGladys();
  await waterMeter.refresh(first, CONFIG, fromCsv(CSV));
  assert.equal(await readCursor(contractKey(CONFIG)), '2026-08-08');

  const second = createFakeGladys();
  await waterMeter.refresh(second, CONFIG, fromCsv(CSV));
  assert.equal(second.published.length, 0);
});

test('a later export only publishes the days added since', async () => {
  const first = createFakeGladys();
  await waterMeter.refresh(first, CONFIG, fromCsv(CSV));

  const second = createFakeGladys();
  await waterMeter.refresh(
    second,
    CONFIG,
    fromCsv(`${CSV}\n2026-08-09 00:00:00;1234500;86;Mesuré`),
  );

  assert.deepEqual(
    second.published
      .filter((p) => p.featureExternalId.endsWith(':daily-volume'))
      .map((p) => p.state),
    [86],
  );
});

test('resync_history forgets the cursor and republishes everything', async () => {
  const first = createFakeGladys();
  await waterMeter.refresh(first, CONFIG, fromCsv(CSV));

  const second = createFakeGladys();
  const message = await waterMeter.actions.resync_history(second, {
    config: CONFIG,
    deps: fromCsv(CSV),
  });

  assert.match(message.fr, /3 jours publiés/);
  assert.equal(
    second.published.filter((p) => p.featureExternalId.endsWith(':daily-volume')).length,
    3,
  );
});

test('a long history is split into batches of at most 100 states', async () => {
  const rows = ['Date;Index;Consommation;Methode'];
  for (let day = 1; day <= 120; day += 1) {
    const date = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
    rows.push(`${date} 00:00:00;${1000 + day * 10};10;Mesuré`);
  }

  const gladys = createFakeGladys();
  await waterMeter.refresh(gladys, CONFIG, fromCsv(rows.join('\n')));

  assert.equal(gladys.published.length, 240);
  assert.ok(gladys.batches.length > 1, 'the import should be batched');
  for (const batch of gladys.batches) {
    assert.ok(batch.length <= 100, `a batch of ${batch.length} exceeds the 100 states per request`);
  }
});

test('the cursor advances batch by batch, so a crash does not replay a batch', async () => {
  const rows = ['Date;Index;Consommation;Methode'];
  for (let day = 1; day <= 120; day += 1) {
    const date = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
    rows.push(`${date} 00:00:00;${1000 + day * 10};10;Mesuré`);
  }

  const gladys = createFakeGladys();
  let call = 0;
  gladys.publishStates = async () => {
    call += 1;
    if (call === 2) {
      throw new Error('Gladys is down');
    }
  };

  await assert.rejects(() => waterMeter.refresh(gladys, CONFIG, fromCsv(rows.join('\n'))));
  // The first batch made it through, and only that one is behind the cursor.
  assert.equal(await readCursor(contractKey(CONFIG)), '2026-02-19');
});

test('nothing is polled while the credentials are missing', async () => {
  const gladys = createFakeGladys();
  await waterMeter.refresh(gladys, normalizeConfig({}), fromCsv(CSV));
  assert.equal(gladys.published.length, 0);
});

test('the badge is nominal after a successful, fresh import', async () => {
  const gladys = createFakeGladys();
  const fresh = new Date().toISOString().slice(0, 10);
  await waterMeter.refresh(
    gladys,
    CONFIG,
    fromCsv(`Date;Index;Conso;M\n${fresh} 00:00:00;10;5;Mesuré`),
  );

  const [entry] = buildTransportEntries(gladys, CONFIG);
  assert.equal(entry.external_id, 'ext:sedif:water-meter:1234567');
  assert.equal(entry.transport, 'cloud');
  assert.equal(entry.degraded, undefined);
});

test('a history the portal stopped updating shows up as degraded', async () => {
  const gladys = createFakeGladys();
  const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await waterMeter.refresh(
    gladys,
    CONFIG,
    fromCsv(`Date;Index;Conso;M\n${stale} 00:00:00;10;5;Mesuré`),
  );

  const [entry] = buildTransportEntries(gladys, CONFIG);
  assert.equal(entry.degraded, true);
  assert.match(entry.message.fr, new RegExp(`aucun relevé depuis le ${stale}`));
});

test('a failed poll surfaces its reason on the badge', async () => {
  const gladys = createFakeGladys();
  const failing = {
    download: async () => {
      throw new Error('The portal refused the credentials');
    },
  };

  await assert.rejects(() => waterMeter.refresh(gladys, CONFIG, failing));

  const [entry] = buildTransportEntries(gladys, CONFIG);
  assert.equal(entry.degraded, true);
  assert.match(entry.message.en, /The portal refused the credentials/);
});

test('test_connection reports the latest measured reading', async () => {
  const gladys = createFakeGladys();
  const message = await waterMeter.actions.test_connection(gladys, {
    config: CONFIG,
    deps: fromCsv(CSV),
  });
  assert.match(message.fr, /1234\.414 m³ le 2026-08-08/);
  assert.match(message.fr, /114 L/);
});

test('test_connection asks for the credentials instead of failing', async () => {
  const gladys = createFakeGladys();
  const message = await waterMeter.actions.test_connection(gladys, { config: normalizeConfig({}) });
  assert.match(message.en, /Fill in the email address/);
});
