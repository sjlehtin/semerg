import datetime
import json
import logging
import os
import time
import tomllib
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from zoneinfo import ZoneInfo

import click
import requests
from requests.adapters import HTTPAdapter
from urllib3.util import Retry

logger = logging.getLogger(__name__)

CONFIG_PATH = Path("~/.semerg/config")

ENTSOE_TOKEN_ENV = "SEMERG_ENTSOE_TOKEN"
FINGRID_TOKEN_ENV = "SEMERG_FINGRID_TOKEN"

# The tariffs and the publication schedule this tool reports on are Finnish, so
# "today" always means a day in this zone, never the runner's local time.
HELSINKI = ZoneInfo("Europe/Helsinki")

# Everything downstream -- the chart, and the search for the cheapest window to
# run an appliance -- wants one uniform grid. Entso-E does not provide one: a
# document may mix resolutions between periods, and within a period it omits
# points whose price repeats. So the parser expands everything to this spacing
# and the rest of the system may rely on that.
PRICE_RESOLUTION = datetime.timedelta(minutes=15)


class SemergGroup(click.Group):
    """Turn our own exceptions into clean CLI errors.

    Unattended runs need a non-zero exit and a readable message, not a
    traceback.
    """

    def invoke(self, ctx):
        try:
            return super().invoke(ctx)
        except (APIError, ConfigError) as e:
            raise click.ClickException(str(e)) from e


@click.group(cls=SemergGroup)
def cli():
    pass


@dataclass
class Config:
    entsoe_security_token: str
    fingrid_authentication_token: str


class ConfigError(Exception):
    pass


def read_config_file():
    """Read tokens from the TOML config file, or return an empty dict."""
    try:
        with open(CONFIG_PATH.expanduser(), "rb") as fp:
            return tomllib.load(fp)
    except FileNotFoundError:
        return {}


def read_config():
    """Collect API tokens, preferring the environment over the config file.

    CI passes tokens in the environment; local development keeps them in
    ``~/.semerg/config`` so they need not be exported into the shell. Both
    mechanisms are supported for each token independently.
    """
    entsoe_token = os.environ.get(ENTSOE_TOKEN_ENV)
    fingrid_token = os.environ.get(FINGRID_TOKEN_ENV)

    if not entsoe_token or not fingrid_token:
        data = read_config_file()
        if not entsoe_token:
            entsoe_token = data.get("entsoe", {}).get("security-token")
        if not fingrid_token:
            fingrid_token = data.get("fingrid", {}).get("authentication-token")

    missing = []
    if not entsoe_token:
        missing.append(f"Entso-E ({ENTSOE_TOKEN_ENV} or [entsoe] security-token)")
    if not fingrid_token:
        missing.append(
            f"Fingrid ({FINGRID_TOKEN_ENV} or [fingrid] authentication-token)"
        )
    if missing:
        raise ConfigError(
            "No token found for: " + ", ".join(missing) + ". Set the "
            f"environment variable, or add it to {CONFIG_PATH}."
        )

    return Config(
        entsoe_security_token=entsoe_token, fingrid_authentication_token=fingrid_token
    )


def to_iso8601(cap):
    start = f"{cap.strftime('%Y-%m-%d %H:%M:%S')}Z".replace(" ", "T")
    return start


class APIError(Exception):
    pass


# Values that must never reach a log. This repository is public, so its CI
# logs are world readable, and the Entso-E token travels as a query parameter --
# which means it appears in any URL that gets logged.
_SECRETS = []


def register_secret(*values):
    for value in values:
        if value and value not in _SECRETS:
            _SECRETS.append(value)


def redact(text):
    """Replace every registered secret in `text`."""
    if text is None:
        return text
    text = str(text)
    for secret in _SECRETS:
        text = text.replace(secret, "<redacted>")
    return text


def _redacting_record_factory(inner):
    def factory(*args, **kwargs):
        record = inner(*args, **kwargs)
        if isinstance(record.msg, str):
            record.msg = redact(record.msg)
        if record.args:
            record.args = tuple(
                redact(arg) if isinstance(arg, str) else arg for arg in record.args
            )
        return record

    return factory


def install_log_redaction(config):
    """Redact secrets from every log record, wherever it comes from.

    This hooks the record factory rather than adding a logging.Filter, because
    a filter attached to a logger only sees records emitted through that logger
    -- it is NOT applied to records propagating up from child loggers. urllib3
    logs its retry warnings, complete with the full request URL, from
    `urllib3.connectionpool`, so filtering `urllib3` misses exactly the case
    this exists to catch. The record factory runs for every record created
    anywhere in the process.
    """
    register_secret(config.entsoe_security_token, config.fingrid_authentication_token)
    logging.setLogRecordFactory(
        _redacting_record_factory(logging.getLogRecordFactory())
    )


def make_session(retries=0):
    """A requests session that backs off on rate limits and server errors.

    Running on shared CI runners makes transient 429s and 5xx more likely than
    they were from a single app server.
    """
    session = requests.Session()
    if retries:
        retry = Retry(
            total=retries,
            backoff_factor=1.0,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=("GET",),
            raise_on_status=False,
        )
        session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


@cli.command
@click.option("--include-overhead", default=True, help="Calculate overhead")
@click.option("--date", metavar="DATE", help="Start fetch from DATE, default to today")
@click.option(
    "--wait-between-requests",
    "--throttle",
    "delay",
    type=float,
    metavar="DELAY",
    help="Pause for DELAY seconds between requests to allow API endpoint to cooldown",
)
@click.option(
    "--retries",
    type=int,
    default=0,
    metavar="N",
    help="Retry a failed request up to N times, backing off between attempts",
)
@click.option("--output", type=click.File("w"))
def gather_data(include_overhead, date, delay, retries, output):
    """
    Write energy prices and production timeseries to the specified
    output file.
    """
    config = read_config()
    install_log_redaction(config)
    session = make_session(retries)

    if not date or date == "today":
        dt = datetime.datetime.now().astimezone()
    else:
        dt = datetime.datetime.strptime(date, "%Y-%m-%d").astimezone()

    start_time = datetime.datetime(
        year=dt.year, month=dt.month, day=dt.day, tzinfo=dt.tzinfo
    ).astimezone(datetime.UTC)
    start_time_stamp = to_iso8601(start_time)

    end_time = start_time + datetime.timedelta(days=2)
    end_time_stamp = to_iso8601(end_time)

    # DocumentType A44: price document
    # In_Domain Used, same as Out domain
    # Out_Domain Used, same as In domain
    # TimeInterval Used

    entsoe_security_token = config.entsoe_security_token

    try:
        series = pull_entsoe_data(
            entsoe_security_token, start_time, end_time, session=session
        )["series"]
    except APIError as e:
        # Entso-E outages are tolerated the same way Fingrid's are. The two
        # sources fail independently, and the production series stand on their
        # own, so publish what we have rather than nothing. The price keys are
        # simply absent; the frontend says so, and the publish step carries
        # forward the prices that are already live.
        click.echo(f"Warning: no price data. {e}")
        series = []

    fetched_data = {
        "fetchTime": datetime.datetime.now(tz=datetime.UTC).isoformat(),
        "startTime": start_time_stamp,
        "endTime": end_time_stamp,
    }
    if series:
        fetched_data["priceResolutionMinutes"] = int(
            PRICE_RESOLUTION.total_seconds() // 60
        )
        fetched_data["basePrices"] = series

    # Entso-E might return more than we asked for, so production data is
    # re-based on the first price point to match. With no prices there is
    # nothing to match, and the requested window stands.
    production_start = series[0]["startTime"] if series else start_time_stamp
    click.echo(
        f"Fetching production data from Fingrid between {production_start} and "
        f"{end_time_stamp}"
    )

    try:
        wind_production, wind_production_times = get_production_data(
            config, 75, production_start, end_time_stamp, session=session
        )

        fetched_data["windProduction"] = [
            {"startTime": ts.isoformat(), "energy": pr}
            for ts, pr in zip(wind_production_times, wind_production)
        ]

        if delay:
            time.sleep(delay)

        wind_production_forecast, wind_production_forecast_times = get_production_data(
            config, 245, production_start, end_time_stamp, session=session
        )

        fetched_data["windProductionForecast"] = [
            {"startTime": ts.isoformat(), "energy": pr}
            for ts, pr in zip(wind_production_forecast_times, wind_production_forecast)
        ]

        if delay:
            time.sleep(delay)

        solar_production_forecast, solar_production_forecast_times = (
            get_production_data(
                config, 247, production_start, end_time_stamp, session=session
            )
        )

        fetched_data["solarProductionForecast"] = [
            {"startTime": ts.isoformat(), "energy": pr}
            for ts, pr in zip(
                solar_production_forecast_times, solar_production_forecast
            )
        ]
    except APIError as e:
        # Fingrid outages are tolerated the same way: the page renders without
        # production data. The keys are simply absent, which the frontend
        # handles and the publish step fills in from what is already live.
        click.echo(f"Warning: no production data. {e}")

    if output:
        json.dump(fetched_data, output)


resolutions = {
    "PT15M": datetime.timedelta(minutes=15),
    "PT30M": datetime.timedelta(minutes=30),
    "PT60M": datetime.timedelta(minutes=60),
    "P1D": datetime.timedelta(days=1),
}


def parse_period(period):
    """Expand one <Period> onto the uniform price grid.

    Entso-E price documents use curveType A03: a point stays valid until the
    next one, so repeated prices are simply omitted, and the final point holds
    until the period's own end. Reconstructing that needs the period's declared
    resolution and timeInterval, neither of which survives further down, so it
    happens here.
    """
    interval_start = datetime.datetime.fromisoformat(
        period.find("{*}timeInterval/{*}start").text
    )
    interval_end = datetime.datetime.fromisoformat(
        period.find("{*}timeInterval/{*}end").text
    )

    received_resolution = period.find("{*}resolution").text
    if received_resolution not in resolutions:
        raise APIError(
            f"Unsupported resolution {received_resolution!r} in Entso-E "
            f"response; known resolutions are "
            f"{', '.join(sorted(resolutions))}."
        )
    resolution = resolutions[received_resolution]

    points = sorted(
        (
            (int(pt.find("{*}position").text), float(pt.find("{*}price.amount").text))
            for pt in period.findall("{*}Point")
        ),
        key=lambda item: item[0],
    )

    expanded = {}
    for index, (position, price) in enumerate(points):
        block_start = interval_start + resolution * (position - 1)
        if index + 1 < len(points):
            block_end = interval_start + resolution * (points[index + 1][0] - 1)
        else:
            # The last point holds until the end of the period.
            block_end = interval_end
        block_end = min(block_end, interval_end)

        slot = block_start
        while slot < block_end:
            expanded[slot] = price
            slot += PRICE_RESOLUTION

    return expanded, interval_start, interval_end


def pull_entsoe_data(
    entsoe_security_token: str, start_time: datetime, end_time: datetime, session=None
):
    start_time_stamp = start_time.strftime("%Y-%m-%dT%H:%MZ")
    end_time_stamp = end_time.strftime("%Y-%m-%dT%H:%MZ")
    params = {
        "documentType": "A44",
        "securityToken": entsoe_security_token,
        "timeInterval": f"{start_time_stamp}/{end_time_stamp}",
        "in_domain": "10YFI-1--------U",
        "out_domain": "10YFI-1--------U",
    }
    click.echo(
        f"Fetching pricing data from Entso-E between {start_time} and {end_time}"
    )
    getter = session.get if session is not None else requests.get
    try:
        response = getter("https://web-api.tp.entsoe.eu/api", params=params)
    except requests.RequestException as e:
        # The token rides in the query string, so it is in the URL that
        # requests puts in its exception message.
        register_secret(entsoe_security_token)
        raise APIError(f"Failed to reach Entso-E: {redact(e)}") from e

    if response.status_code != 200:
        register_secret(entsoe_security_token)
        logger.error(
            f"Failed to fetch Entso-E data, code: {response.status_code}, "
            f"data: {redact(response.text)}"
        )
        raise APIError(f"Failed to fetch Entso-E data, code: {response.status_code}.")

    series_start_time = None
    series_end_time = None

    xml_data = response.content.decode("utf-8", "replace")
    try:
        root = ET.fromstring(xml_data)
    except ET.ParseError as e:
        raise APIError(f"Entso-E returned a body that is not XML: {e}") from e

    prices = {}
    for period in root.findall("./{*}TimeSeries/{*}Period"):
        expanded, interval_start, interval_end = parse_period(period)
        if not series_start_time or interval_start < series_start_time:
            series_start_time = interval_start
        if not series_end_time or interval_end > series_end_time:
            series_end_time = interval_end
        prices.update(expanded)

    processed = [
        {
            "startTime": slot.isoformat(),
            # Price in response is EUR/MWh -> we want c/kWh
            "price": price / 10,
        }
        for slot, price in sorted(prices.items())
    ]

    if not processed:
        raise APIError(
            "Entso-E returned no price points. Refusing to continue rather "
            "than publish an empty series."
        )

    click.echo(
        f"Got {len(processed)} data points from Entso-E, from "
        f"{processed[0]['startTime']} to {processed[-1]['startTime']}."
    )
    return {
        "series": processed,
        "start": series_start_time.isoformat(),
        "end": series_end_time.isoformat(),
    }


def get_production_data(config, dataset_id, start_time, end_time, session=None):
    headers = {"x-api-key": config.fingrid_authentication_token}
    params = {
        "startTime": start_time,
        "endTime": end_time,
        "format": "json",
        "pageSize": 1000,
        "locale": "en",
        "sortBy": "startTime",
        "sortOrder": "asc",
    }
    getter = session.get if session is not None else requests.get
    try:
        response = getter(
            f"https://data.fingrid.fi/api/datasets/{dataset_id}/data",
            headers=headers,
            params=params,
        )
    except requests.RequestException as e:
        raise APIError(f"Failed to reach Fingrid for dataset {dataset_id}: {e}") from e
    if response.status_code != 200:
        raise APIError(
            f"Failed to get data from endpoint for dataset {dataset_id}, status {response.status_code}: {response.text} "
        )
    try:
        production_raw_data = json.loads(response.content)
    except json.JSONDecodeError as e:
        raise APIError(
            f"Fingrid returned a body that is not JSON for dataset {dataset_id}: {e}"
        ) from e
    production_times = [
        datetime.datetime.fromisoformat(val["startTime"])
        for val in production_raw_data["data"]
    ]
    production = [val["value"] for val in production_raw_data["data"]]
    return production, production_times


class ValidationError(Exception):
    pass


def infer_step(points):
    """Smallest positive gap between consecutive points, as a timedelta."""
    gaps = []
    for earlier, later in pairwise(points):
        gap = datetime.datetime.fromisoformat(
            later["startTime"]
        ) - datetime.datetime.fromisoformat(earlier["startTime"])
        if gap > datetime.timedelta(0):
            gaps.append(gap)
    if not gaps:
        return datetime.timedelta(minutes=60)
    return min(gaps)


def coverage_end(data):
    """The instant up to which a data file has prices."""
    prices = data.get("basePrices") or []
    if not prices:
        raise ValidationError("basePrices is missing or empty.")
    last = datetime.datetime.fromisoformat(prices[-1]["startTime"])
    return last + infer_step(prices)


def end_of_helsinki_day(now=None):
    """Midnight at the end of the current Finnish day, as an aware datetime."""
    now = (now or datetime.datetime.now(tz=datetime.UTC)).astimezone(HELSINKI)
    tomorrow = now.date() + datetime.timedelta(days=1)
    return datetime.datetime.combine(tomorrow, datetime.time(0, 0), tzinfo=HELSINKI)


PRODUCTION_KEYS = (
    "windProduction",
    "windProductionForecast",
    "solarProductionForecast",
)

# Everything a fetch can be missing because a source was down, and that the
# already published file can therefore supply. `priceResolutionMinutes`
# describes `basePrices`, so it travels with it.
SERIES_KEYS = ("basePrices", *PRODUCTION_KEYS)
CARRIED_FORWARD_KEYS = ("priceResolutionMinutes", *SERIES_KEYS)


def merge_data(data, previous):
    """Fill series a fresh fetch is missing from the previously published data.

    Entso-E and Fingrid fail independently, and the page draws both. Publishing
    a fetch that lost one source as it stands would blank a series that is still
    perfectly good on the page, so what is already live is carried forward
    instead. Carried-forward prices are stale rather than wrong -- they are the
    same points the page is already showing -- and `check_price_coverage` is
    what says so out loud.
    """
    merged = dict(data)
    for key in CARRIED_FORWARD_KEYS:
        if not merged.get(key) and previous.get(key):
            merged[key] = previous[key]
    return merged


def validate_data(data, previous=None):
    """Raise ValidationError unless this data is fit to publish.

    Fit to publish means it carries something worth showing and takes nothing
    away from what is already published. How far ahead the prices reach is a
    separate question, asked by `check_price_coverage`, because the answer must
    not gate a publish: during an Entso-E outage the prices stand still while
    the production series keep arriving, and holding those back would spread one
    source's outage across the whole page.
    """
    prices = data.get("basePrices") or []
    if not prices and not any(data.get(key) for key in PRODUCTION_KEYS):
        raise ValidationError(
            "Neither prices nor production data: there is nothing here to publish."
        )

    end = coverage_end(data) if prices else None

    if previous is not None:
        dropped = [
            key for key in SERIES_KEYS if previous.get(key) and not data.get(key)
        ]
        if dropped:
            raise ValidationError(
                f"{', '.join(dropped)} is published but missing here. Refusing "
                f"to take a live series off the page; carry it forward with "
                f"merge-data first."
            )

        if prices:
            try:
                previous_end = coverage_end(previous)
            except ValidationError:
                previous_end = None
            if previous_end is not None and end < previous_end:
                raise ValidationError(
                    f"Prices cover up to {end}, which is less than the "
                    f"{previous_end} already published. Refusing to regress."
                )

    return end


def check_price_coverage(data, now=None):
    """Raise ValidationError unless prices reach the end of the Finnish day.

    Deliberately does *not* check for a fixed number of hours of remaining
    coverage. Entso-E publishes on CET day boundaries and Nord Pool releases the
    next day around midday, so any fixed horizon is violated once every day just
    before publication -- which would train everyone to ignore the alert.

    An alarm, not a gate: prices that stop short are still the prices the page
    has, so this is asked after publishing rather than before.
    """
    end = coverage_end(data)

    required = end_of_helsinki_day(now)
    if end < required:
        raise ValidationError(
            f"Prices only cover up to {end.astimezone(HELSINKI)}, which is "
            f"short of the end of the current Finnish day ({required})."
        )

    return end


def load_json(fp):
    try:
        return json.load(fp)
    except json.JSONDecodeError as e:
        raise click.ClickException(f"{fp.name} is not valid JSON: {e}")


@cli.command("merge-data")
@click.option(
    "--previous",
    type=click.File("r"),
    required=True,
    metavar="FILE",
    help="Take series the new data is missing from FILE, the currently published data",
)
@click.option("--output", type=click.File("w"), required=True)
@click.argument("path", type=click.File("r"))
def merge_data_command(path, previous, output):
    """Carry published series forward into a fetch that is missing them.

    A source that was down leaves its keys absent. Publishing that file as it
    stands would take a working series off the page, so run this before
    validating against what is live -- validate-data refuses a file that drops
    a published series.
    """
    data = load_json(path)

    try:
        published = json.load(previous)
    except json.JSONDecodeError:
        # A corrupt published file is nothing to carry forward from, and no
        # reason to block a good fetch.
        click.echo(f"Ignoring {previous.name}: not valid JSON.")
        published = {}

    merged = merge_data(data, published)

    carried = [
        key for key in CARRIED_FORWARD_KEYS if not data.get(key) and merged.get(key)
    ]
    click.echo(
        f"Carried forward from {previous.name}: {', '.join(carried)}."
        if carried
        else "Nothing to carry forward."
    )

    json.dump(merged, output)


@cli.command("validate-data")
@click.option(
    "--compare-to",
    type=click.File("r"),
    metavar="FILE",
    help="Refuse to publish if FILE (the currently published data) has series "
    "the new data lacks, or prices covering a longer period",
)
@click.argument("path", type=click.File("r"))
def validate_data_command(path, compare_to):
    """Check that a gathered data file is fit to publish.

    Exits non-zero when it is not, so that a broken fetch cannot overwrite good
    data. `gather-data --output` truncates its target file as soon as it opens
    it, so a failed run leaves a partial file behind that looks plausible.
    """
    data = load_json(path)

    previous = None
    if compare_to:
        try:
            previous = json.load(compare_to)
        except json.JSONDecodeError:
            # A corrupt published file is not a reason to block a good one.
            click.echo(f"Ignoring {compare_to.name}: not valid JSON.")

    try:
        end = validate_data(data, previous=previous)
    except ValidationError as e:
        raise click.ClickException(str(e))

    missing = [key for key in PRODUCTION_KEYS if not data.get(key)]
    if missing:
        # Fingrid failures are tolerated by design; the page renders without
        # them. Worth reporting, not worth blocking a price update for.
        click.echo(f"Warning: no production data for {', '.join(missing)}.")

    if end is None:
        # Likewise an Entso-E failure. check-coverage is what raises the alarm.
        click.echo("OK: production data only, no prices.")
    else:
        click.echo(
            f"OK: {len(data['basePrices'])} price points, covering up to "
            f"{end.astimezone(HELSINKI)}."
        )


@cli.command("check-coverage")
@click.argument("path", type=click.File("r"))
def check_coverage_command(path):
    """Check that the prices in a data file reach far enough ahead.

    Exits non-zero when they do not. Run this *after* publishing: prices that
    stop short mean Entso-E is behind, which is worth a failed run, but the
    production data in the same file is fresh and must not be held back for it.
    """
    data = load_json(path)

    try:
        end = check_price_coverage(data)
    except ValidationError as e:
        raise click.ClickException(str(e))

    click.echo(f"OK: prices cover up to {end.astimezone(HELSINKI)}.")
