// -----------------------------------------------------------------------------
// The browser session itself cannot be unit tested without a portal, but its
// one piece of pure decoding can: the `data:` URI the portal builds in the DOM
// is the only thing standing between the export and the parser.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOGIN_URL,
  DOWNLOAD_FILENAME,
  PortalError,
  decodeDataUri,
  historyUrlFrom,
} from '../src/sedif/portal.js';

const CSV = 'Date;Index;Consommation;Methode\n2026-08-08 00:00:00;1234414;114;Mesuré\n';

test('decodes the base64 form of the export link', () => {
  const href = `data:text/csv;charset=utf-8;base64,${Buffer.from(CSV, 'utf8').toString('base64')}`;
  assert.equal(decodeDataUri(href), CSV);
});

test('decodes the percent-encoded form of the export link', () => {
  const href = `data:text/csv;charset=utf-8,${encodeURIComponent(CSV)}`;
  assert.equal(decodeDataUri(href), CSV);
});

test('keeps the accents of the "Mesuré" column intact', () => {
  const href = `data:text/csv;base64,${Buffer.from(CSV, 'utf8').toString('base64')}`;
  assert.match(decodeDataUri(href), /Mesuré/);
});

test('an href that is not a data URI is reported, not silently parsed', () => {
  assert.throws(() => decodeDataUri('/s/historique'), PortalError);
  assert.throws(() => decodeDataUri('/s/historique'), /not a data URI/);
});

test('the portal entry points are the ones documented for users', () => {
  assert.equal(DEFAULT_LOGIN_URL, 'https://connexion.leaudiledefrance.fr/s/login/');
  assert.equal(DOWNLOAD_FILENAME, 'historique_jours_litres.csv');
});

test('the history page is derived from wherever the login landed', () => {
  assert.equal(
    historyUrlFrom('https://connexion.leaudiledefrance.fr/particuliers/s/'),
    'https://connexion.leaudiledefrance.fr/particuliers/s/historique',
  );
  // Missing trailing slash: the last segment must not be swallowed.
  assert.equal(
    historyUrlFrom('https://connexion.leaudiledefrance.fr/espace-bailleurs-syndics/s'),
    'https://connexion.leaudiledefrance.fr/espace-bailleurs-syndics/s/historique',
  );
  // Session noise in the query string must not end up glued to the path.
  assert.equal(
    historyUrlFrom('https://connexion.leaudiledefrance.fr/s/?tab=accueil#top'),
    'https://connexion.leaudiledefrance.fr/s/historique',
  );
});
