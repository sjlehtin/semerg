import requests
import click
from pathlib import Path
import xml.etree.ElementTree as ET
import datetime
import json


__version__ = "0.1"


@click.group
def cli():
    pass


def get_entsoe_security_token():
    return open(Path("~/.entsoe-token").expanduser()).read().strip()


def get_fingrid_authentication_token():
    return open(Path("~/.fingrid-token").expanduser()).read().strip()


def to_interval(cap):
    start = f'{cap.strftime("%Y-%m-%d %H:%M:%S")}Z'.replace(" ", "T")
    return start


@cli.command
@click.option("--include-overhead", default=True, help="Calculate overhead")
@click.option("--date", metavar="DATE", help="Start fetch from DATE, default to today")
@click.option("--output", type=click.File('w'))
def day_ahead_prices(include_overhead, date, output):
    """
    Write energy prices and production timeseries to the specified
    output file.
    """
    if not date or date == "today":
        dt = datetime.datetime.now().astimezone()
    else:
        dt = datetime.datetime.strptime(date, "%Y-%m-%d").astimezone()

    cap = datetime.datetime(year=dt.year, month=dt.month, day=dt.day,
                            tzinfo=dt.tzinfo).astimezone(datetime.timezone.utc)
    start = to_interval(cap)
    end = to_interval(cap + datetime.timedelta(days=2))

    # DocumentType A44: price document
    # In_Domain Used, same as Out domain
    # Out_Domain Used, same as In domain
    # TimeInterval Used

    params = {"documentType": "A44",
              "securityToken": get_entsoe_security_token(),
              "timeInterval": f"{start}/{end}",
              "in_domain": "10YFI-1--------U",
              "out_domain": "10YFI-1--------U"
              }

    response = requests.get("https://web-api.tp.entsoe.eu/api", params=params)

    xml_data = response.content.decode("utf-8", "replace")
    root = ET.fromstring(xml_data)
    series = []

    for child in root.findall("./{*}TimeSeries/{*}Period"):
        interval_start = datetime.datetime.fromisoformat(child.find("{*}timeInterval/{*}start").text.replace("Z", "+00:00"))

        # TODO: verify resolution
        for pt in child.findall("{*}Point"):
            position = int(pt.find("{*}position").text)
            price = float(pt.find("{*}price.amount").text)
            series.append({"start": interval_start + datetime.timedelta(hours=position - 1), "price": price})

    # TODO: move overhead calculation to the Javascript
    # Addendums 0.50 c/kWh Vattenfall margin (incl. VAT 24%)
    # VAT 0%
    # 0.40323 c/kWh Vattenfall margin
    # tax 2.24 c/kWh
    # security of supply fee 0.01300 c/kWh
    base_overhead = 0.013 + 2.24 + 0.40323
    prices = []
    times = []
    for item in series:
        times.append(item["start"])
        hour = item["start"].astimezone().hour
        price = item["price"] / 10

        # transmission fee day 2.58 c/kWh
        # transmission fee night 1.13 c/kWh
        if 7 <= hour <= 22:
            transmission_fee = 2.58
        else:
            transmission_fee = 1.13
        overhead = base_overhead + transmission_fee

        total_price = price
        if total_price > 0:
            total_price *= 1.24
        if include_overhead:
            total_price += overhead * 1.24
        prices.append([price, total_price])

    # Fetch production data

    # 'variable/75' is Wind power production
    headers = {"x-api-key": get_fingrid_authentication_token()}
    params = {"start_time": to_interval(times[0]), "end_time": to_interval(times[-1])}
    response = requests.get("https://api.fingrid.fi/v1/variable/75/events/json", headers=headers, params=params)

    production_raw_data = json.loads(response.content)
    production_times = [datetime.datetime.fromisoformat(val["start_time"]) for val in production_raw_data]
    production = [val["value"] for val in production_raw_data]

    # 'variable/245' is Wind power production forecast
    response = requests.get(
        "https://api.fingrid.fi/v1/variable/245/events/json", headers=headers,
        params=params)
    production_raw_data = json.loads(response.content)
    forecast_production_times = [
        datetime.datetime.fromisoformat(val["start_time"]) for val in
        production_raw_data]
    forecast_production = [val["value"] for val in production_raw_data]

    if output:
        json.dump({
            'fetchTime': datetime.datetime.now(tz=datetime.timezone.utc).isoformat(),
            'startTime': start,
            'endTime': end,
            'basePrices':
                       [{'startTime': ts.isoformat(), 'price': pr}
                        for ts, pr in zip(times, [pr[0] for pr in prices])],
                   'adjustedPrices':
                       [{'startTime': ts.isoformat(), 'price': pr}
                        for ts, pr in zip(times, [pr[1] for pr in prices])],
                   'windProduction': [{'startTime': ts.isoformat(), 'energy': pr} for ts, pr in zip(production_times, production)],
                   'windProductionForecast': [
                       {'startTime': ts.isoformat(), 'energy': pr} for ts, pr
                       in zip(forecast_production_times, forecast_production)],
                   },
                  output)
