// -----------------------------------------------------------------------------
// The CSV exported by the portal is the contract this integration depends on.
// These tests pin down every assumption made about it, including the ones we
// only know from the field (accents, decimal comma, estimated rows).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  latestReading,
  litersToCubicMeters,
  parseHistoryCsv,
  selectNewReadings,
  toIsoDay,
} from '../src/sedif/csv.js';

const SAMPLE = [
  'Date;Index;Consommation;Methode',
  '2026-08-05 00:00:00;1234000;120;Mesuré',
  '2026-08-06 00:00:00;1234150;150;Mesuré',
  '2026-08-07 00:00:00;1234300;150;Estimé',
  '2026-08-08 00:00:00;1234414;114;Mesuré',
  '',
].join('\n');

test('parses the daily export', () => {
  const readings = parseHistoryCsv(SAMPLE);

  assert.equal(readings.length, 4);
  assert.deepEqual(
    readings.map((r) => r.date),
    ['2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'],
  );
  // The CSV gives litres; the shared Reading shape carries m³ so the API and
  // the file source feed the same device.
  assert.equal(readings[0].indexCubicMeters, 1234);
  assert.equal(readings[0].consumptionLiters, 120);
  assert.equal(readings[0].estimated, false);
  assert.equal(readings[2].estimated, true);
});

test('anchors each reading at noon UTC, so a timezone cannot shift a day', () => {
  const [first] = parseHistoryCsv(SAMPLE);
  assert.equal(first.at.toISOString(), '2026-08-05T12:00:00.000Z');
  assert.equal(toIsoDay(first.at), first.date);
});

test('skips the header, blank lines and any free-text footer', () => {
  const readings = parseHistoryCsv(
    ['Date;Index;Consommation;Methode', '', '2026-08-08 00:00:00;10;5;Mesuré', 'Total;;;'].join(
      '\n',
    ),
  );
  assert.equal(readings.length, 1);
});

test('accepts the DD/MM/YYYY dates of the monthly export', () => {
  const [reading] = parseHistoryCsv('Date;Index;Conso;M\n09/08/2026;42;7;Mesuré');
  assert.equal(reading.date, '2026-08-09');
});

test('tolerates thousand separators and a decimal comma', () => {
  const [reading] = parseHistoryCsv('2026-08-08 00:00:00;1 234 414;114,0;Mesuré');
  assert.equal(reading.indexCubicMeters, 1234.414);
  assert.equal(reading.consumptionLiters, 114);
});

test('recognises every spelling of an estimated reading', () => {
  for (const spelling of ['Estimé', 'Estime', 'Estimée', 'E', 'estimé']) {
    const [reading] = parseHistoryCsv(`2026-08-08 00:00:00;10;5;${spelling}`);
    assert.equal(reading.estimated, true, `"${spelling}" should be estimated`);
  }
  for (const spelling of ['Mesuré', 'Mesure', 'M', '']) {
    const [reading] = parseHistoryCsv(`2026-08-08 00:00:00;10;5;${spelling}`);
    assert.equal(reading.estimated, false, `"${spelling}" should be measured`);
  }
});

test('sorts the readings chronologically whatever the export order', () => {
  const readings = parseHistoryCsv(
    ['2026-08-08 00:00:00;20;10;Mesuré', '2026-08-05 00:00:00;10;5;Mesuré'].join('\n'),
  );
  assert.deepEqual(
    readings.map((r) => r.date),
    ['2026-08-05', '2026-08-08'],
  );
});

test('rejects an export with nothing usable in it', () => {
  assert.throws(() => parseHistoryCsv(''), /Empty consumption export/);
  assert.throws(
    () => parseHistoryCsv('Date;Index;Conso;M\n<html>oops</html>'),
    /No usable reading/,
  );
});

test('rejects an impossible day rather than inventing one', () => {
  assert.throws(() => parseHistoryCsv('2026-02-31 00:00:00;10;5;Mesuré'), /No usable reading/);
});

test('selectNewReadings drops the estimated rows by default', () => {
  const readings = parseHistoryCsv(SAMPLE);
  const selected = selectNewReadings(readings, {
    historyDays: 365,
    includeEstimated: false,
    since: null,
    now: new Date('2026-08-09T06:00:00Z'),
  });
  assert.deepEqual(
    selected.map((r) => r.date),
    ['2026-08-05', '2026-08-06', '2026-08-08'],
  );
});

test('selectNewReadings keeps the estimated rows when the user asked for them', () => {
  const readings = parseHistoryCsv(SAMPLE);
  const selected = selectNewReadings(readings, {
    historyDays: 365,
    includeEstimated: true,
    since: null,
    now: new Date('2026-08-09T06:00:00Z'),
  });
  assert.equal(selected.length, 4);
});

test('selectNewReadings publishes nothing twice', () => {
  const readings = parseHistoryCsv(SAMPLE);
  const selected = selectNewReadings(readings, {
    historyDays: 365,
    includeEstimated: false,
    since: '2026-08-06',
    now: new Date('2026-08-09T06:00:00Z'),
  });
  assert.deepEqual(
    selected.map((r) => r.date),
    ['2026-08-08'],
  );
});

test('selectNewReadings honours the history window on a first import', () => {
  const readings = parseHistoryCsv(SAMPLE);
  const selected = selectNewReadings(readings, {
    historyDays: 2,
    includeEstimated: false,
    since: null,
    now: new Date('2026-08-09T06:00:00Z'),
  });
  assert.deepEqual(
    selected.map((r) => r.date),
    ['2026-08-08'],
  );
});

test('the history window does not re-bound later imports', () => {
  // A Gladys that was off for a while must catch up entirely: once a cursor
  // exists, "history to import" has done its job and must not carve a
  // permanent hole between the cursor and the window.
  const readings = parseHistoryCsv(SAMPLE);
  const selected = selectNewReadings(readings, {
    historyDays: 1,
    includeEstimated: false,
    since: '2026-08-05',
    now: new Date('2026-09-30T06:00:00Z'),
  });
  assert.deepEqual(
    selected.map((r) => r.date),
    ['2026-08-06', '2026-08-08'],
  );
});

test('latestReading skips the trailing estimated days', () => {
  const readings = parseHistoryCsv(
    ['2026-08-05 00:00:00;10;5;Mesuré', '2026-08-06 00:00:00;20;10;Estimé'].join('\n'),
  );
  assert.equal(latestReading(readings).date, '2026-08-05');
  assert.equal(latestReading(readings, true).date, '2026-08-06');
});

test('latestReading returns null when the export holds only estimates', () => {
  const readings = parseHistoryCsv('2026-08-06 00:00:00;20;10;Estimé');
  assert.equal(latestReading(readings), null);
});

test('the meter index is published in cubic meters', () => {
  assert.equal(litersToCubicMeters(1234414), 1234.414);
  assert.equal(litersToCubicMeters(0), 0);
});
