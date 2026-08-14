// -----------------------------------------------------------------------------
// The dropped-file source: the path that needs no browser at all.
// -----------------------------------------------------------------------------

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDroppedCsv } from '../src/sedif/file.js';
import { parseHistoryCsv } from '../src/sedif/csv.js';
import { normalizeConfig } from '../src/config.js';

const root = await mkdtemp(path.join(tmpdir(), 'gladys-sedif-import-'));
const importDir = path.join(root, 'import');

after(() => rm(root, { recursive: true, force: true }));

beforeEach(async () => {
  await rm(importDir, { recursive: true, force: true });
  await mkdir(importDir, { recursive: true });
});

test('reads the CSV dropped in the import folder', async () => {
  const csv = 'Date;Index;Consommation;Methode\n2026-08-08 00:00:00;1234414;114;Mesuré\n';
  await writeFile(path.join(importDir, 'historique_jours_litres.csv'), csv, 'utf8');

  const content = await readDroppedCsv(normalizeConfig({ source: 'file' }), { importDir });
  assert.equal(content.trim(), csv.trim());
});

test('several exports extend the history instead of competing', async () => {
  // Overlapping monthly exports are the normal way a user builds up history:
  // the parser sorts, the cursor skips what Gladys already has.
  await writeFile(
    path.join(importDir, '01-juillet.csv'),
    'Date;Index;Conso;M\n2026-07-31 00:00:00;1230000;100;Mesuré\n',
    'utf8',
  );
  await writeFile(
    path.join(importDir, '02-aout.csv'),
    'Date;Index;Conso;M\n2026-08-01 00:00:00;1230100;100;Mesuré\n',
    'utf8',
  );

  const readings = parseHistoryCsv(
    await readDroppedCsv(normalizeConfig({ source: 'file' }), { importDir }),
  );
  assert.deepEqual(
    readings.map((r) => r.date),
    ['2026-07-31', '2026-08-01'],
  );
});

test('ignores files that are not CSV', async () => {
  await writeFile(path.join(importDir, 'notes.txt'), 'not a csv', 'utf8');
  await writeFile(
    path.join(importDir, 'export.csv'),
    'Date;Index;Conso;M\n2026-08-08 00:00:00;10;5;Mesuré\n',
    'utf8',
  );

  const content = await readDroppedCsv(normalizeConfig({ source: 'file' }), { importDir });
  assert.ok(!content.includes('not a csv'));
});

test('an empty folder says what to do, it does not just fail', async () => {
  await assert.rejects(
    () => readDroppedCsv(normalizeConfig({ source: 'file' }), { importDir }),
    (err) => {
      assert.equal(err.code, 'NO_IMPORT_FILE');
      assert.match(err.message, /Download the daily history/);
      assert.match(err.message, new RegExp(importDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
});

test('a missing folder is reported as such', async () => {
  await assert.rejects(
    () =>
      readDroppedCsv(normalizeConfig({ source: 'file' }), {
        importDir: path.join(root, 'nowhere'),
      }),
    (err) => {
      assert.equal(err.code, 'IMPORT_DIR_MISSING');
      return true;
    },
  );
});

test('the dropped-file source needs no account', async () => {
  const { isConfigured } = await import('../src/config.js');
  // The user already signed in by hand, in their own browser.
  assert.equal(isConfigured(normalizeConfig({ source: 'file' })), true);
  assert.equal(isConfigured(normalizeConfig({ source: 'portal' })), false);
});

test('an unknown source falls back to the portal, never to nothing', () => {
  assert.equal(normalizeConfig({ source: 'carrier-pigeon' }).source, 'portal');
  assert.equal(normalizeConfig({}).source, 'portal');
  assert.equal(normalizeConfig({ source: 'file' }).source, 'file');
});
