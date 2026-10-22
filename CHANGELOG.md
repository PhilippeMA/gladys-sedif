# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
