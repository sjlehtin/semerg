## Introduction

This tool fetches the Finnish day-ahead prices of the Nord Pool power market.

The tool aggregates data from several sources to one data endpoint to allow a rich UI to be built to use the data.

Currently, the tool fetches electricity prices from the Entso-E transparency platform and wind power production and forecasts from Fingrid.

## Installation

You need API keys from Entsoe and Fingrid.

### Entso-E Transparency Platform

Obtain a user account to https://transparency.entsoe.eu/. After that you need
to apply for the API keys as per the instructions. This is a manual process,
and takes a couple of days. After you have the 
privileges, you can generate the Web API token under the account settings.

Entso-E also has an open source dedicated Python client available in [Github](https://github.com/EnergieID/entsoe-py).

### Fingrid

See instructions in [Fingrid's web page](https://data.fingrid.fi/en/instructions).

### Supply the tokens

Tokens are read from the environment first:

```shell
export SEMERG_ENTSOE_TOKEN="YOUR-SECURITY-TOKEN-HERE"
export SEMERG_FINGRID_TOKEN="YOUR-AUTHENTICATION-TOKEN-HERE"
```

falling back to a config file at `~/.semerg/config`:

```toml
[entsoe]
security-token = "YOUR-SECURITY-TOKEN-HERE"

[fingrid]
authentication-token = "YOUR-AUTHENTICATION-TOKEN-HERE"
```

Each token is looked up independently, so you can override just one. CI uses
the environment; the config file exists so that local development does not
need secrets exported into the shell.

### Install this package

I recommend using a virtual environment

```shell
python -m venv ve
. ve/bin/activate
pip install -e .
```

## Update `data.json`

The page fetches `data.json` at runtime rather than having it compiled into the
bundle, so it lives in `front/public/` and refreshing prices does not require a
rebuild.

```shell
semerg gather-data --output front/public/data.json
```

`--output` truncates its target as soon as it opens it, so a failed fetch
leaves a partial file behind. Before publishing, check it:

```shell
semerg validate-data front/public/data.json
```

`--compare-to` additionally refuses a series shorter than the one already
published, which is what stops a degraded fetch from replacing good data:

```shell
semerg validate-data data.json --compare-to published.json
```

## Run it locally

In the `front` directory:

```shell
npm ci
npm run dev
```

This needs no API tokens. `front/public/data.json` is gitignored and seeded from
a committed sample, with its timestamps shifted onto today so the page has a
present and a next day to show. Seeded files are tagged and regenerated once
stale; a real fetch into that path is never overwritten.

```shell
npm test
```

## Make bundle

```shell
npm run build
```

Output lands in `front/dist/`. Note that the build does *not* fetch data — run
`gather-data` into `front/public/` first if you want `data.json` in the output,
or upload it separately.

## Host elsewhere

The deliverables are the contents of `front/dist/`: `index.html`, the
content-hashed files under `assets/`, and `data.json`. (`data.sample.json` is
the development fixture and does not need uploading.)

Two consequences of the runtime fetch are worth knowing before hosting it:

- **The data and the bundle are independent.** Refreshing prices replaces one
  file; deploying code replaces the rest. Neither needs the other, and neither
  invalidates the other.
- **They need different cache lifetimes.** Everything under `assets/` is
  content-hashed and can be cached indefinitely — the name changes whenever the
  content does. `index.html` and `data.json` need a short TTL, or the page will
  keep serving prices it already has.

Upload the hashed assets *before* `index.html`, so a freshly cached page never
references a bundle that is not up yet, and do not delete old assets on
deploy — a page still open in a browser continues to request the bundle it was
served with.

The deployment used for <https://github.com/sjlehtin/semerg> itself — S3 behind
CloudFront, driven by GitHub Actions, with the AWS side described in Terraform
under [`infra/`](infra/) — is documented in
[docs/deployment.md](docs/deployment.md).
