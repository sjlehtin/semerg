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

### Create config file

The tool looks for the config file in `~/.semerg/config`.

```toml
[entsoe]
security-token = "YOUR-SECURITY-TOKEN-HERE"

[fingrid]
authentication-token = "YOUR-AUTHENTICATION-TOKEN-HERE"
```

Currently, I do not need to read these from environment variables, but that
would be a good idea if this was run, e.g., in a micro-service.

### Install this package

I recommend using a virtual environment

```shell
python -m venv ve
. ve/bin/activate
pip install -e .
```

## Update `data.json`

```shell
semerg gather-data --output front/src/data.json
```

## Make bundle

In `front` directory

```shell
npm run build
```

You can then host the file in localhost with

```shell
npm run dev
```

## Host elsewhere

The deliverables are the `index.html` and the accompanying `index.*.js` file in the `front/dist` directory. Host them where you wish.
