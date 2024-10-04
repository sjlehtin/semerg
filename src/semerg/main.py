import datetime
import json
import tomllib
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

import click
import requests
import time

__version__ = "0.2"


@click.group
def cli():
    pass


@dataclass
class Config:
    entsoe_security_token: str
    fingrid_authentication_token: str


def read_config_file():
    with open(Path("~/.semerg/config").expanduser(), "rb") as fp:
        data = tomllib.load(fp)
    return Config(entsoe_security_token=data["entsoe"]["security-token"],
                  fingrid_authentication_token=data["fingrid"][
                      "authentication-token"])


def to_iso8601(cap):
    start = f'{cap.strftime("%Y-%m-%d %H:%M:%S")}Z'.replace(" ", "T")
    return start


class APIError(Exception):
    pass


@cli.command
@click.option("--include-overhead", default=True, help="Calculate overhead")
@click.option("--date", metavar="DATE",
              help="Start fetch from DATE, default to today")
@click.option("--wait-between-requests", "delay", type=float, metavar="DELAY",
              help="Pause for DELAY seconds between requests to allow API endpoint to cooldown")
@click.option("--output", type=click.File('w'))
def gather_data(include_overhead, date, delay, output):
    """
    Write energy prices and production timeseries to the specified
    output file.
    """
    config = read_config_file()

    if not date or date == "today":
        dt = datetime.datetime.now().astimezone()
    else:
        dt = datetime.datetime.strptime(date, "%Y-%m-%d").astimezone()

    cap = datetime.datetime(year=dt.year, month=dt.month, day=dt.day,
                            tzinfo=dt.tzinfo).astimezone(
        datetime.timezone.utc)
    start_time = to_iso8601(cap)
    end_time = to_iso8601(cap + datetime.timedelta(days=2))

    # DocumentType A44: price document
    # In_Domain Used, same as Out domain
    # Out_Domain Used, same as In domain
    # TimeInterval Used

    entsoe_security_token = config.entsoe_security_token

    series = pull_entsoe_data(entsoe_security_token, start_time,
                              end_time)

    fetched_data = {
        'fetchTime': datetime.datetime.now(
            tz=datetime.timezone.utc).isoformat(),
        'startTime': start_time,
        'endTime': end_time,
        'basePrices': series
    }

    # Entsoe-E might return more than we asked, let's enrich the data with
    # production data up until that point.
    start_time = series[0]['startTime']
    click.echo(
        f"Fetching production data from Fingrid between {start_time} and "
        f"{end_time}")

    try:
        wind_production, wind_production_times = get_production_data(
            config, 75, start_time, end_time)

        fetched_data['windProduction'] = [
            {'startTime': ts.isoformat(), 'energy': pr}
            for ts, pr in zip(wind_production_times, wind_production)]

        if delay:
            time.sleep(delay)

        wind_production_forecast, wind_production_forecast_times = (
            get_production_data(
                config, 245, start_time, end_time))

        fetched_data['windProductionForecast'] = [
            {'startTime': ts.isoformat(), 'energy': pr}
            for ts, pr in zip(wind_production_forecast_times,
                              wind_production_forecast)]

        if delay:
            time.sleep(delay)

        solar_production_forecast, solar_production_forecast_times = (
            get_production_data(
                config, 247, start_time, end_time))

        fetched_data['solarProductionForecast'] = [
            {'startTime': ts.isoformat(), 'energy': pr}
            for ts, pr in zip(solar_production_forecast_times,
                              solar_production_forecast)]
    except APIError as e:
        click.echo(e)

    if output:
        json.dump(fetched_data, output)


def pull_entsoe_data(entsoe_security_token, start_time, end_time):
    params = {"documentType": "A44",
              "securityToken": entsoe_security_token,
              "timeInterval": f"{start_time}/{end_time}",
              "in_domain": "10YFI-1--------U",
              "out_domain": "10YFI-1--------U"
              }
    response = requests.get("https://web-api.tp.entsoe.eu/api", params=params)
    xml_data = response.content.decode("utf-8", "replace")
    root = ET.fromstring(xml_data)
    series = []
    for child in root.findall("./{*}TimeSeries/{*}Period"):
        interval_start = datetime.datetime.fromisoformat(
            child.find("{*}timeInterval/{*}start").text.replace("Z",
                                                                "+00:00"))

        # TODO: verify resolution
        for pt in child.findall("{*}Point"):
            position = int(pt.find("{*}position").text)
            price = float(pt.find("{*}price.amount").text)
            series.append({"start": interval_start + datetime.timedelta(
                hours=position - 1), "price": price})

    processed = []
    for item in series:
        processed.append({
            'startTime': item["start"].isoformat(),
            # Price in response is EUR/MWh -> we want c/kWh
            'price': item["price"] / 10
        })
    processed.sort(key=lambda x: x["startTime"])
    return processed


def get_production_data(config, dataset_id, start_time, end_time):
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
    response = requests.get(
        f"https://data.fingrid.fi/api/datasets/{dataset_id}/data",
        headers=headers,
        params=params)
    if response.status_code != 200:
        raise APIError(
            f"Failed to get data from endpoint for dataset {dataset_id}, status {response.status_code}: {response.text} ")
    production_raw_data = json.loads(response.content)
    production_times = [datetime.datetime.fromisoformat(val["startTime"])
                        for val in production_raw_data["data"]]
    production = [val["value"] for val in production_raw_data["data"]]
    return production, production_times
