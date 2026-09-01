# ChangeLog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Cheapest-time-to-run recommendations for common household loads: dishwasher,
  washing machine, sauna and EV charging at 11 kW. Each shows when to start,
  what it costs, and what waiting saves against starting now. Durations (and
  the EV charge target) are adjustable and persist in the browser.
- A visual redesign, with a responsive layout and light/dark themes. The chart
  reads its palette from the stylesheet, so page and canvas cannot drift apart.
- Frontend tests, run with Vitest.

- Read API tokens from `SEMERG_ENTSOE_TOKEN` and `SEMERG_FINGRID_TOKEN`,
  falling back to `~/.semerg/config` as before. Each token is looked up
  independently.
- `semerg validate-data`, which checks a gathered file is fit to publish. It
  requires something worth publishing and refuses a file that drops a series,
  or shortens the prices, against what is already published.
- `semerg merge-data`, which carries the published series forward into a fetch
  that is missing them, and `semerg check-coverage`, which reports whether the
  prices reach the end of the current Finnish day.
- `--retries` option, backing off on rate limits and server errors.
- Deploy from GitHub Actions to S3, documented in `docs/deployment.md`.
- Terraform for the AWS side — bucket, CloudFront distribution and the
  deployment role — in `infra/`.
- `AGENTS.md`.

### Changed

- `data.json` is fetched at runtime rather than bundled into the JavaScript.
  Refreshing the data no longer requires rebuilding, and the page updates in
  place every five minutes instead of reloading itself with a meta refresh.
- The frontend is built with Vite and styled with Tailwind, replacing Parcel.
- Tariff rates moved out of the chart code into `front/src/tariff.js`, which
  models the supplier, the network operator and national taxes separately.
- Prices are expanded onto a uniform 15-minute grid. Entso-E omits points whose
  price repeats (curveType A03) and may mix resolutions between periods; the
  gaps are now filled at parse time, where the period metadata needed to do it
  correctly is still available. Adds `priceResolutionMinutes` to the output.

### Fixed

- An Entso-E outage no longer takes the wind and solar series off the page.
  Prices and production come from two sources that fail independently, but a
  failed price fetch aborted the whole run, so nothing was published at all.
  Each source is now tolerated on its own: the fetch keeps whatever arrived,
  the publish step carries forward the series that did not, and the page names
  the source that is missing. Transport failures and unparseable bodies count
  as outages too, rather than escaping as a traceback.
- Whether the prices reach the end of the Finnish day is now checked after
  publishing rather than before. It is an alarm, not a gate: during an Entso-E
  outage the prices stand still while the production data keeps arriving, and
  blocking the publish held back fresh data over a stale series.
- Failing to fetch prices from Entso-E now raises rather than returning an
  empty result, which the caller then died on with a `KeyError`. An empty
  series and an unsupported resolution likewise raise instead of producing a
  `IndexError` or tripping a bare `assert` that disappears under `python -O`.
- Secret redaction in logs now uses the log record factory rather than a
  `logging.Filter`. A filter attached to a logger never sees records
  propagating up from child loggers, and urllib3 emits its retry warnings --
  which contain the full request URL, and the Entso-E token rides in the query
  string -- from `urllib3.connectionpool`. The redaction was therefore inert
  for the one case it existed to cover.
- Hovering the chart highlighted each series at a different time. Chart.js's
  "index" interaction mode aligns series by position in the array rather than
  by timestamp, and Entso-E omits repeated prices, so the price series carries
  gaps that the evenly sampled Fingrid series do not -- pushing the readings
  further apart the further right you hovered.
- The day/night transfer fee was chosen using the browser's timezone rather
  than Finland's, so the rate stepped at the wrong moment for anyone reading
  the page from another zone.
- Corrected the tariff rates, which had drifted in three separate ways. The
  electricity tax and the security-of-supply fee were still grossed up at 24%
  VAT: only the spot multiplier was updated when VAT rose to 25.5% in September
  2024. The security-of-supply fee itself rose from 0.013 to 0.085 c/kWh on
  2026-04-01. The transfer tariff had also moved. Together these understated
  the real price by 0.22 c/kWh during the day and 0.14 c/kWh at night.

### Removed

- `tox` and `tox-uv` from the dev extras. There has never been a tox config,
  so they could not run.

### Security

- Updated Vite to 8 and Vitest to 4, clearing five advisories in the frontend
  toolchain -- among them a critical one where the Vitest UI server, while
  listening, would read and execute an arbitrary file. Both are build-time
  dependencies only, so no shipped bundle carried the flaw. CI moves to Node
  22 with them: Vite 8 requires `^20.19 || >=22.12`, and Node 20 is past end of
  life.
- Floored `requests` at 2.32.4. Earlier releases leak `.netrc` credentials to
  the target of a redirect (CVE-2024-47081).

## 0.5.1 - [2024-10-04]

### Fixed

* Update VAT percentage.
* Entso-E might return data out of order. Sort internally before use.
* Allow storing of data and rendering the data even if Fingrid API does not work at the moment.

## 0.5.0 - [2024-05-16]

### Added

- Added `--wait-between-requests` option for the command. The API endpoint does not like being called immediately after a previous call.

## 0.4.0 - [2024-05-02]

### Added

- Added solar production forecast.

### Fixed

- Fixed to use https://data.fingrid.fi/api API endpoint, old one ceased to work just before May Day.

## 0.3.0 - [2024-01-29]

### Changed

- Move price adjustment to the client code.

## 0.2.0 - [2024-01-26]

### Added

- Host project as open source in GitHub.

### Changed

- Renamed command `semerg day-ahead-prices` to `semerg gather-data`.
