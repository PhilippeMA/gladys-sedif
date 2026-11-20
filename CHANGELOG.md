# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.1.1] - 2026-11-20

### Fixed

- Every refresh failed with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` after the portal
  rotated its TLS certificate to another certificate authority in November 2026. The portal sends its leaf certificate without the intermediate that
  signs it, and version 1.0.2 repaired that with one certificate pinned in
  `certs/`: the day the issuer changed, the pinned file no longer fitted and
  the integration stopped dead, with nothing the user could do about it.

  The missing certificate is now fetched from the address the leaf itself
  names, which is what a browser does (`src/sedif/chain.js`), and kept on
  `/data` so a restart does not download it again. The pinned certificate is
  still tried first, and `SEDIF_EXTRA_CA_FILE` still overrides everything for a
  proxy that re-signs HTTPS. This survives the next rotation without a release.

  Verification stays fully on: a fetched certificate is accepted only if it
  really issued the certificate below it, and the connection still has to lead
  to a root in Node's own store, so a hostile answer at that address changes
  nothing.

### Removed

- The `/data/chromium` and `/data/diagnostics` directories, and the `TMPDIR`
  override that pointed at them. They were left over from the browser era and
  were created at every start for nothing.

## [1.1.0] - 2026-11-18

### Changed

- Updated to version 0.16.1 of the Gladys integration SDK, and realigned the
  repository with the current official template. Nothing in 0.16 changes how
  this integration behaves: the polling contract it relaxes is one this
  integration does not use (a water meter read once a day cannot live on the
  core's one-minute clock, so the refresh is scheduled here), and
  `DEVICE_POLL_FREQUENCIES` still stops at one minute.
- The tests now publish through the SDK's own fake Gladys, which validates a
  payload the way the host API does: the `ext:sedif:` prefix, known categories,
  types and units, an accepted `poll_frequency`, and the columns Gladys stores
  NOT NULL on a feature. The device's two features already declared all of
  them, so nothing in the integration changed — but a `400` on discovery or a
  `422` when adding the device is now a failing test instead of a bug report.

## [1.0.2] - 2026-10-22

### Changed

- Updated to version 0.15.0 of the Gladys integration SDK, and realigned the
  repository with the current official template: CI runs on Node 22 and 24 and
  builds the Docker image, a `CHANGELOG.md` is rolled by the Release workflow,
  every version gets a GitHub Release, and Dependabot watches the dependencies.
- Node 22 or later is now required (was 20), matching the template and the SDK.

### Fixed

- Readings corrected by the operator after publication are picked up again.
  Every refresh now re-publishes the last 14 days: the portal revises the
  recent past, and an import cursor that only moved forward kept the first
  value for ever. Gladys updates a day it already stored instead of duplicating
  it, so the chart follows the corrections without a manual re-import.
- A day skipped because it was estimated, and later measured, is no longer lost
  behind the cursor.
- Selecting a contract on a multi-contract account. The portal identifies
  contracts with tokens it regenerates on every request, so the number printed
  on the bill could never match: the setting is now a position (1 = first), and
  a single-contract account ignores it instead of failing on it.

## [1.0.1] - 2026-10-21

### Fixed

- Documentation: the credentials are stored in clear text in the Gladys
  database, not encrypted. The `secret` field type only keeps the value from
  being sent back to the web interface.

## [1.0.0] - 2026-08-22

### Added

- Water consumption of a SEDIF contract (L'Eau d'Île-de-France / Veolia) as a
  Gladys device: meter index in m³ and daily consumption in litres, both kept
  in history and dated by the day of the reading.
- Two interchangeable sources: the portal's own Salesforce Aura API (default,
  no browser), and a CSV exported by hand and dropped in `/data/import`.
- An import cursor on the `/data` volume, batched publication, and estimated
  readings skipped by default.

[Unreleased]: https://github.com/PhilippeMA/gladys-sedif/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/PhilippeMA/gladys-sedif/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/PhilippeMA/gladys-sedif/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/PhilippeMA/gladys-sedif/compare/v1.0.1...v1.0.2
