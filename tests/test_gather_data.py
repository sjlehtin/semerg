"""What a gather run does when one of the two sources is down.

Entso-E and Fingrid fail independently and the page draws both, so an outage at
either must leave the other's series intact.
"""

import datetime
import json
from unittest.mock import patch

import pytest
import requests
from click.testing import CliRunner

from semerg import main
from semerg.main import APIError, cli

UTC = datetime.UTC


@pytest.fixture
def tokens(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "CONFIG_PATH", tmp_path / "config")
    monkeypatch.setattr(main, "_SECRETS", [])
    monkeypatch.setenv(main.ENTSOE_TOKEN_ENV, "entsoe-token")
    monkeypatch.setenv(main.FINGRID_TOKEN_ENV, "fingrid-token")


def recording_production(calls):
    def get_production_data(config, dataset_id, start_time, end_time, session=None):
        calls.append((dataset_id, start_time))
        return [100.0], [datetime.datetime(2025, 12, 1, tzinfo=UTC)]

    return get_production_data


def gather(tmp_path):
    output = tmp_path / "data.json"
    result = CliRunner().invoke(
        cli, ["gather-data", "--date", "2025-12-01", "--output", str(output)]
    )
    return result, output


def test_an_entsoe_outage_leaves_the_production_data_intact(tokens, tmp_path):
    calls = []

    with (
        patch.object(main, "pull_entsoe_data", side_effect=APIError("Entso-E is down")),
        patch.object(main, "get_production_data", recording_production(calls)),
    ):
        result, output = gather(tmp_path)

    assert result.exit_code == 0, result.output
    data = json.loads(output.read_text())

    assert "basePrices" not in data
    assert data["windProduction"]
    assert data["windProductionForecast"]
    assert data["solarProductionForecast"]

    # With no prices to re-base on, Fingrid is asked for the window we asked for.
    assert [dataset for dataset, _ in calls] == [75, 245, 247]
    assert all(start == data["startTime"] for _, start in calls)


def test_the_reason_a_series_is_absent_is_recorded_for_the_page(tokens, tmp_path):
    """A missing key alone does not tell the reader why it is missing."""
    with (
        patch.object(main, "pull_entsoe_data", side_effect=APIError("Entso-E: 503")),
        patch.object(main, "get_production_data", recording_production([])),
    ):
        result, output = gather(tmp_path)

    assert result.exit_code == 0, result.output
    notices = json.loads(output.read_text())["notices"]

    assert notices == [
        {"series": "basePrices", "state": "missing", "detail": "Entso-E: 503"}
    ]


def test_a_fingrid_failure_is_recorded_for_every_series_it_lost(tokens, tmp_path):
    def one_dataset_then_failure(
        config, dataset_id, start_time, end_time, session=None
    ):
        if dataset_id != 75:
            raise APIError("Fingrid: 429")
        return [100.0], [datetime.datetime(2025, 12, 1, tzinfo=UTC)]

    with (
        patch.object(
            main,
            "pull_entsoe_data",
            return_value={
                "series": [{"startTime": "2025-12-01T00:00:00+00:00", "price": 5.0}]
            },
        ),
        patch.object(main, "get_production_data", one_dataset_then_failure),
    ):
        result, output = gather(tmp_path)

    assert result.exit_code == 0, result.output
    data = json.loads(output.read_text())

    # The series that did arrive is not reported as missing.
    assert data["windProduction"]
    assert [notice["series"] for notice in data["notices"]] == [
        "windProductionForecast",
        "solarProductionForecast",
    ]


def test_production_data_is_rebased_on_the_first_price_point(tokens, tmp_path):
    calls = []
    first = "2025-11-30T22:00:00+00:00"

    with (
        patch.object(
            main,
            "pull_entsoe_data",
            return_value={"series": [{"startTime": first, "price": 5.0}]},
        ),
        patch.object(main, "get_production_data", recording_production(calls)),
    ):
        result, output = gather(tmp_path)

    assert result.exit_code == 0, result.output
    data = json.loads(output.read_text())
    assert data["priceResolutionMinutes"] == 15
    assert "notices" not in data
    assert all(start == first for _, start in calls)


def test_an_unreachable_entsoe_is_an_api_error_without_the_token(tokens):
    """The token rides in the query string, so it is in the failure message."""
    failure = requests.ConnectionError(
        "HTTPSConnectionPool: /api?securityToken=entsoe-token"
    )

    with (
        patch("semerg.main.requests.get", side_effect=failure),
        pytest.raises(APIError) as raised,
    ):
        main.pull_entsoe_data(
            "entsoe-token",
            datetime.datetime(2025, 12, 1, tzinfo=UTC),
            datetime.datetime(2025, 12, 3, tzinfo=UTC),
        )

    assert "entsoe-token" not in str(raised.value)


def test_a_body_that_is_not_xml_is_an_api_error(tokens):
    """A gateway error page comes back with a 200 and an HTML body."""

    class Response:
        status_code = 200
        content = b"<html>502 Bad Gateway"

    with (
        patch("semerg.main.requests.get", return_value=Response()),
        pytest.raises(APIError, match="not XML"),
    ):
        main.pull_entsoe_data(
            "entsoe-token",
            datetime.datetime(2025, 12, 1, tzinfo=UTC),
            datetime.datetime(2025, 12, 3, tzinfo=UTC),
        )
