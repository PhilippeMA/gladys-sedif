# Gladys SEDIF — suivi de consommation d'eau

External integration for [Gladys Assistant](https://gladysassistant.com) that
tracks the drinking water consumption of a **SEDIF** contract (Syndicat des Eaux
d'Île-de-France, operated by Veolia under the _L'Eau d'Île-de-France_ brand).

Built on the official [JavaScript integration
template](https://github.com/GladysAssistant/integration-template-js) and the
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

User documentation: [`docs/fr.md`](./docs/fr.md) · [`docs/en.md`](./docs/en.md).

## The device

One device per contract, `Compteur d'eau SEDIF`, with two read-only features:

| Feature                  | Category        | Type    | Unit |
| ------------------------ | --------------- | ------- | ---- |
| Index du compteur        | `volume-sensor` | decimal | m³   |
| Consommation quotidienne | `volume-sensor` | integer | L    |

Both keep history. Readings are published with their **own `created_at`**, so
the chart is dated by the day of the reading rather than by the day of the
import — including the backfill done on the first run.

The device is published **without `poll_frequency`**, and the integration runs
its own refresh loop (`index.js`). That is not a stylistic choice: the Gladys
core validates `poll_frequency` against its six `DEVICE_POLL_FREQUENCIES`
values — 1 s to 1 minute, in **milliseconds** — and rejects the whole publish
with `invalid poll frequency` otherwise. A meter the operator reads once a day,
where every refresh costs a browser session, has no business on that clock.

## How it gets the data, and why

Neither the SEDIF nor Veolia publishes an API for consumption data. The customer
portal (`connexion.leaudiledefrance.fr`) is a Salesforce Experience Cloud site:
the Historique page is rendered by Lightning components and fed by opaque,
signed Aura payloads whose descriptors change with each release of the site.
Every working community tool ([MetersToHA](https://github.com/mdeweerd/MetersToHA),
[veolia-idf](https://github.com/s0nik42/veolia-idf),
[PyVeoliaIDF](https://github.com/ssenart/PyVeoliaIDF)) drives a real browser for
that reason, and so does this integration.

The flow, all of it in [`src/sedif/portal.js`](./src/sedif/portal.js):

1. sign in on `/s/login/` (Chromium, headless, via `playwright-core`);
2. open the Historique page, derived from wherever the login landed
   (`/particuliers/s/`, `/espace-bailleurs-syndics/s/`…);
3. select the _Litres_ / _Jours_ view;
4. press _Télécharger la période_ — the portal builds `historique_jours_litres.csv`
   **client-side** and exposes it as a `data:` URI on a hidden `<a download>`;
5. read that attribute and decode it. Nothing is ever written to disk, which is
   what makes this work under the read-only rootfs of the Gladys sandbox.

The CSV itself (`date;index;consommation;méthode`, litres) is parsed by
[`src/sedif/csv.js`](./src/sedif/csv.js) — pure, no I/O, and the place where all
format assumptions are pinned down by tests.

**This is the fragile part.** The selectors live in one file, `history_url`
lets a user pin the history page from the Gladys UI, and `SEDIF_LOGIN_URL`
overrides the login page — the portal has already moved twice
(`espace-client.vedif.eau.veolia.fr` → `rock-vedif.my.site.com` →
`connexion.leaudiledefrance.fr`).

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no portal logic)
├─ src/
│  ├─ devices/
│  │  ├─ index.js                    #   device registry
│  │  └─ waterMeter.js               #   the meter: features, import, badge
│  ├─ sedif/
│  │  ├─ index.js                    #   the driver boundary (fetchHistory)
│  │  ├─ portal.js                   #   browser session + selectors
│  │  └─ csv.js                      #   pure parser + reading selection
│  ├─ storage.js                     # import cursor + scratch dir on /data
│  └─ config.js                      # config defaults + normalization
├─ scripts/check-browser.js          # build-time guard: right browser, right path
├─ docs/{en,fr}.md                   # user documentation, re-hosted by Gladys
├─ gladys-assistant-integration.json # manifest
└─ Dockerfile                        # Debian + Playwright's Chromium, multi-arch
```

## Import semantics

Each poll downloads the whole exported period and publishes only what Gladys
does not have yet:

- an **import cursor** on `/data` (the one writable mount) records the last
  published day, so a restart does not duplicate the chart;
- the cursor advances **batch by batch**, so a failure halfway through an import
  does not replay the days that already made it;
- batches are capped at 100 states, the SDK limit;
- **estimated** readings are skipped by default: they can make the index go
  backwards once the real measurement lands.

## Run it locally

```bash
npm install
npx playwright-core install --no-shell chromium   # NOT the distro Chromium
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="sedif" \
GLADYS_SEDIF_STATE_DIR="./.state" \
LOG_LEVEL=debug \
npm start
```

`GLADYS_SEDIF_STATE_DIR` replaces `/data` outside the sandbox. `CHROMIUM_PATH`
overrides the browser binary — but only ever point it at a build matching the
`playwright-core` version in `package.json`. A distro Chromium is a different
major version and fails at launch (see the Dockerfile).

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # node --test
npm run check:browser  # is the browser the code asks for actually installed?
```

The suite covers the CSV parser, the configuration, the manifest/code
consistency and the full import path (cursor, batching, badge) with a canned
export. It also drives **a real Chromium** against a stand-in portal
([`test/helpers/fakePortal.js`](./test/helpers/fakePortal.js)) to exercise the
browser plumbing — those tests skip when no Chromium is installed; CI installs
one so they always run.

`check:browser` also runs inside the Docker build, so an image that ships the
wrong browser fails to build instead of failing hours later on the user's box.
Browser packaging is the one thing here that unit tests cannot see: the code
asks for `channel: 'chromium'` (the full browser, new headless mode) and the
image installs it with `--no-shell`. **Change one and you must change the
other** — mismatch them and Playwright hunts for a binary that is not there.

What no test can cover: whether the selectors still match the live portal. Only
a run against the real site, with real credentials, tells you that — the
**Tester la connexion** button in the Gladys Configuration screen is there for
exactly that.

## Publish

1. Add the GitHub topic `gladys-assistant-integration` to the repository.
2. **Actions → Release → Run workflow**, pick `patch`, `minor` or `major`. It
   bumps `package.json` and the manifest, pushes the `vX.Y.Z` tag and builds the
   `linux/amd64` + `linux/arm64` image to `ghcr.io`.
3. The decentralized indexer picks up the new manifest version.

Validate the manifest before tagging:

```bash
npx github:GladysAssistant/integration-store .
```

## License

Apache-2.0
