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
with `invalid poll frequency` otherwise. A meter the operator reads once a day
has no business on that clock.

## Two sources, one pipeline

`source` (config) picks where the readings come from:

- **`api`** (default) — the portal's own Salesforce Aura API, over plain HTTP
  ([`src/sedif/api.js`](./src/sedif/api.js));
- **`file`** — a CSV the user drops in `/data/import`, parsed by
  [`src/sedif/csv.js`](./src/sedif/csv.js) ([`src/sedif/file.js`](./src/sedif/file.js)).

They are interchangeable on purpose: both hand back the same `Reading` shape,
and everything after that — cursor, dated backfill, batching, the device — is
one piece of code.

## How the API source works

Neither the SEDIF nor Veolia publishes a documented API, but the portal's own
Lightning pages talk to a Salesforce Aura endpoint that speaks plain
form-encoded HTTP. Four exchanges:

1. `GET /s/login/` — scrape `fwuid` and the app descriptor (the Lightning build
   ids, which change with every Salesforce release, hence read at runtime);
2. `POST /s/sfsites/aura` — `apex://LightningLoginFormController/ACTION$login`,
   then follow the `clientRedirect` frontdoor URL that sets the session cookies.
   The CSRF token comes back in a cookie whose name contains `ERIC`, and every
   later call must echo it in `aura.token`;
3. Apex actions via `aura://ApexActionController/ACTION$execute`:
   `LTN009_ICL_ContratsGroupements` (contracts) →
   `LTN008_ICL_ContratDetails` (meter number + PDS id) →
   `LTN015_ICL_ContratConsoHisto` (the daily history);
4. Responses carry an anti-CSRF prefix; the payload is between the first `{`
   and the last `}`.

The transport lives in [`src/sedif/aura.js`](./src/sedif/aura.js), the four
exchanges in [`src/sedif/api.js`](./src/sedif/api.js).

**Two things that will bite anyone reading this later.**

_Units._ `CONSOMMATION` is in **cubic meters** (0.150 = 150 L) and
`VALEUR_INDEX` is the index, also in cubic meters — where the CSV export gives
both in **litres**. Getting it backwards puts a household meter at a million m³.

_TLS._ The portal serves an **incomplete certificate chain**: it sends its leaf
without the intermediate that signs it. Browsers repair that themselves by
fetching the missing certificate from the address the leaf names (AIA); Node
does not, and reports `UNABLE_TO_VERIFY_LEAF_SIGNATURE` on a perfectly healthy
connection. So [`src/sedif/chain.js`](./src/sedif/chain.js) does what the
browser does, and the certificate is kept on `/data` afterwards.

Pinning the intermediate instead is what broke version 1.0.2 in production: it
shipped the Gandi certificate in use at the time, the site moved to another CA
in November 2026, and every refresh died until a new release. The pinned file is
still tried first — it costs nothing and needs no network — but it is no longer
what the fix rests on. Verification stays **fully on** throughout: a fetched
certificate is only ever offered as a possible intermediate, and still has to
lead to a root in Node's own store. `SEDIF_EXTRA_CA_FILE` adds another CA when a
proxy re-signs HTTPS.

**Credit.** The protocol was reverse-engineered by TimoPtr in
[pyeauidf](https://github.com/TimoPtr/pyeauidf) / [ha_eauidf](https://github.com/TimoPtr/ha_eauidf)
(Apache-2.0), including the missing-intermediate diagnosis. This is an
independent JavaScript implementation of the same documented exchange.

**What is fragile now:** the Apex class names. A Salesforce release can rename
them — but the endpoint then answers with a named error immediately, which is a
far better failure than a selector timing out on a rendered page.

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
│  │  ├─ aura.js                     #   Salesforce Aura transport (HTTP + TLS)
│  │  ├─ api.js                      #   the four portal exchanges
│  │  ├─ file.js                     #   the dropped-CSV source
│  │  ├─ csv.js                      #   pure parser + reading selection
│  │  ├─ chain.js                    #   fetches the missing intermediate (AIA)
│  │  └─ errors.js                   #   PortalError
│  ├─ storage.js                     # import cursor + /data layout
│  └─ config.js                      # config defaults + normalization
├─ certs/gandi_intermediate.pem      # offline fast path; the chain is repaired
│                                    #   at runtime when this one no longer fits
├─ docs/{en,fr}.md                   # user documentation, re-hosted by Gladys
├─ gladys-assistant-integration.json # manifest
└─ Dockerfile                        # node:24-alpine, multi-arch
```

## Import semantics

Each poll downloads the whole exported period and publishes only what Gladys
does not have yet:

- an **import cursor** on `/data` (the one writable mount) records the last
  published day, so a restart does not re-import three years of history;
- the cursor advances **batch by batch**, so a failure halfway through an import
  does not replay the days that already made it;
- batches are capped at 100 states, the SDK limit;
- **estimated** readings are skipped by default: they can make the index go
  backwards once the real measurement lands;
- the last **14 days are re-published on every refresh**, cursor or not.

That last point is not belt and braces, it is a bug fix. The operator rewrites
the recent past: a day appears hours after it ends, provisional, and is revised
later. A cursor that only moves forward publishes the first version and never
looks again, so the chart keeps a value the portal has since corrected — until
someone re-imports by hand. Re-publishing is safe and is what repairs it:
Gladys matches a historical state on `(feature, created_at)`, skips it when the
value is identical and **updates it in place** when it differs
(`device.saveHistoricalState` in the core). It never duplicates the point.

The window also closes a second hole: an estimated day between two measured
ones is skipped while the cursor jumps over it, and would stay missing for ever
without a second look.

## Contract ids are per-request tokens

Worth knowing before touching `resolveContract`. What
`listCurrentUserActiveContrats` returns are **not** contract numbers: they are
opaque tokens regenerated on every single call — the same account answers
`9W89dqWJvCxLdcNx…` one minute and `UB8FcM3iB2WxOT9e…` the next. They are valid
only for the next call of the same session: never store one, compare it across
sessions, or show it to a user as something to copy. The `contract` setting is
therefore a **position** (1 = first), not the number printed on the bill.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="sedif" \
GLADYS_SEDIF_STATE_DIR="./.state" \
LOG_LEVEL=debug \
npm start
```

`GLADYS_SEDIF_STATE_DIR` replaces `/data` outside the sandbox. `SEDIF_BASE_URL`
points the client at another host (the tests use it), and `SEDIF_EXTRA_CA_FILE`
adds a CA to the trust bundle.

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # node --test
```

The suite runs in a couple of seconds and needs nothing installed. It covers the
CSV parser, the configuration, the manifest/code consistency, the whole import
path (cursor, batching, badge), and **the Aura protocol end to end** against a
stand-in portal served over real HTTPS with a self-signed certificate
([`test/helpers/fakeAuraPortal.js`](./test/helpers/fakeAuraPortal.js)) — which
exercises the login handshake, the frontdoor session, the CSRF echo, the Apex
unwrapping, the units, and the custom-CA code path.

Everything published goes through the **SDK's fake Gladys**
([`test/helpers/fakeGladys.js`](./test/helpers/fakeGladys.js) wraps it), which
validates a payload the way the host API does: the `ext:sedif:` prefix, known
categories, types and units, a `poll_frequency` among the six the core accepts,
the columns Gladys stores NOT NULL on a feature (`name`, `min`, `max`,
`read_only`, `has_feedback`). Those are the mistakes a hand-written stub waves
through and the user then meets as a `400` on discovery or a `422` when adding
the device.

What no test can cover: whether the Apex class names still match the live
portal. Only a run against the real site tells you that — the **Tester la
connexion** button in the Gladys Configuration screen is there for exactly that.

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
