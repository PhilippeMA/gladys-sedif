// -----------------------------------------------------------------------------
// Parser of the consumption history exported by the customer portal.
//
// The "Telechargement" button of the Historique page produces a semicolon
// separated file named `historique_jours_litres.csv`, one line per day:
//
//   Date;Index;Consommation;Methode
//   2026-08-08 00:00:00;1234414;153;Mesure
//   2026-08-09 00:00:00;1234567;153;Estime
//
//   - column 0: the day of the reading (`YYYY-MM-DD HH:MM:SS`; the monthly
//     export uses `DD/MM/YYYY`, which we also accept);
//   - column 1: the meter index — total litres since the meter was installed;
//   - column 2: the consumption of that day, in litres;
//   - column 3: how the value was obtained, "Mesure" or "Estime" (accents and
//     one-letter forms vary between exports, so we match loosely).
//
// This module is deliberately pure: no network, no browser. It is where the
// format assumptions live, and where the tests can pin them down.
// -----------------------------------------------------------------------------

/**
 * @typedef {object} Reading
 * @property {string} date       day of the reading, `YYYY-MM-DD`
 * @property {Date}   at         the same day as a Date (noon UTC, see below)
 * @property {number} indexCubicMeters  meter index, in cubic meters
 * @property {number} consumptionLiters consumption of that day, in litres
 * @property {boolean} estimated true when the operator estimated the value
 */

/**
 * Parse the CSV exported by the portal.
 *
 * Unparseable lines are skipped rather than fatal: a single malformed row (a
 * footer, a partially written export) must not cost us the whole history.
 *
 * @param {string} csv raw file content
 * @returns {Reading[]} readings, oldest first
 */
export function parseHistoryCsv(csv) {
  if (typeof csv !== 'string' || csv.trim() === '') {
    throw new Error('Empty consumption export');
  }

  const readings = [];

  for (const rawLine of csv.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }

    const columns = line.split(';');
    if (columns.length < 3) {
      continue;
    }

    const date = parseDate(columns[0]);
    if (date === null) {
      // The header row and any free-text footer land here.
      continue;
    }

    const indexLiters = parseInteger(columns[1]);
    const consumptionLiters = parseInteger(columns[2]);
    if (indexLiters === null || consumptionLiters === null) {
      continue;
    }

    readings.push({
      date,
      at: new Date(`${date}T12:00:00.000Z`),
      // The CSV gives the index in LITRES, where the API gives cubic meters.
      // Converting here is what lets both sources feed the same device.
      indexCubicMeters: litersToCubicMeters(indexLiters),
      consumptionLiters,
      estimated: isEstimated(columns[3]),
    });
  }

  if (readings.length === 0) {
    throw new Error('No usable reading in the consumption export');
  }

  // The portal already exports in chronological order, but nothing in the file
  // guarantees it — and the whole publication logic assumes it.
  readings.sort((a, b) => a.date.localeCompare(b.date));

  return readings;
}

/**
 * Keep the readings that still have to be published.
 *
 * @param {Reading[]} readings parsed history, oldest first
 * @param {object} options
 * @param {number} options.historyDays  how far back the FIRST import goes
 * @param {boolean} options.includeEstimated keep the estimated readings
 * @param {string|null} options.since   last published day (`YYYY-MM-DD`), or
 *                                      null when nothing was ever published
 * @param {Date} [options.now]          injectable clock, for the tests
 * @returns {Reading[]}
 */
export function selectNewReadings(readings, { historyDays, includeEstimated, since, now }) {
  // The history window bounds the FIRST import only. Once a cursor exists,
  // everything the portal published after it is imported — a Gladys that was
  // off for six weeks must not end up with a permanent hole in its chart.
  const today = now ?? new Date();
  const floor =
    since === null ? toIsoDay(new Date(today.getTime() - historyDays * 86_400_000)) : since;

  return readings.filter((reading) => {
    // Estimated readings are not measurements: the operator fills the gap
    // between two real reads, and the resulting index can go backwards.
    if (reading.estimated && !includeEstimated) {
      return false;
    }
    // `since` is the last day already in Gladys: publishing it again would
    // duplicate the point in the history.
    return since === null ? reading.date >= floor : reading.date > since;
  });
}

/**
 * The last measured reading of a history — what "the meter reads X right now"
 * means for a device whose index only moves once a day.
 *
 * @param {Reading[]} readings parsed history, oldest first
 * @param {boolean} includeEstimated
 * @returns {Reading|null}
 */
export function latestReading(readings, includeEstimated = false) {
  for (let i = readings.length - 1; i >= 0; i -= 1) {
    if (includeEstimated || !readings[i].estimated) {
      return readings[i];
    }
  }
  return null;
}

/** Litres to cubic meters, the unit of a French water bill. */
export function litersToCubicMeters(liters) {
  return Math.round(liters) / 1000;
}

/**
 * `YYYY-MM-DD` of a Date, in UTC. Readings are days, not instants: using the
 * local timezone here would shift a whole history by one day depending on
 * where the Gladys box happens to run.
 */
export function toIsoDay(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  const raw = (value ?? '').trim().replace(/^\ufeff/, '');

  // `2026-08-09 00:00:00` or `2026-08-09`
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return isRealDay(iso[1], iso[2], iso[3]) ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  }

  // `09/08/2026` — the monthly export of the same portal.
  const french = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (french) {
    return isRealDay(french[3], french[2], french[1])
      ? `${french[3]}-${french[2]}-${french[1]}`
      : null;
  }

  return null;
}

function isRealDay(year, month, day) {
  const date = new Date(`${year}-${month}-${day}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && toIsoDay(date) === `${year}-${month}-${day}`;
}

function parseInteger(value) {
  // Exports have been seen with thin spaces as thousand separators, and with a
  // decimal comma on the consumption column.
  const cleaned = (value ?? '')
    .trim()
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(',', '.');
  if (cleaned === '') {
    return null;
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function isEstimated(value) {
  // "Estime", "Estimé", "Estimée", "E" — and "Mesure"/"M" for the other side.
  const normalized = (value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return normalized === 'e' || normalized.startsWith('estim');
}
