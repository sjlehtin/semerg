"""The parser must hand downstream code one uniform 15-minute grid.

Entso-E does not provide one. Price documents use curveType A03, where a point
stays valid until the next one, so repeated prices are omitted; a document may
also mix resolutions between periods. Everything downstream -- the chart, and
the search for the cheapest window to run an appliance -- depends on the grid
being uniform, so these are the tests that make that guarantee real.
"""

import datetime

import pytest

from semerg import main
from semerg.main import APIError, pull_entsoe_data

UTC = datetime.timezone.utc

NS = "urn:iec62325.351:tc57wg16:451-3:publicationdocument:7:3"


def period(start, end, resolution, points):
    rows = "".join(
        f"<Point><position>{pos}</position><price.amount>{price}</price.amount></Point>"
        for pos, price in points
    )
    return (
        f"<TimeSeries><Period>"
        f"<timeInterval><start>{start}</start><end>{end}</end>"
        f"</timeInterval>"
        f"<resolution>{resolution}</resolution>{rows}"
        f"</Period></TimeSeries>"
    )


def document(*periods):
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<Publication_MarketDocument xmlns="{NS}">'
        f"{''.join(periods)}</Publication_MarketDocument>"
    ).encode()


class FakeResponse:
    def __init__(self, content, status_code=200):
        self.content = content
        self.status_code = status_code
        self.text = content.decode() if isinstance(content, bytes) else content


@pytest.fixture
def fetch(monkeypatch):
    """Return a callable that parses a canned document."""

    def run(content, status_code=200):
        monkeypatch.setattr(
            main.requests, "get", lambda *a, **kw: FakeResponse(content, status_code)
        )
        return pull_entsoe_data(
            "token",
            datetime.datetime(2025, 12, 1, tzinfo=UTC),
            datetime.datetime(2025, 12, 3, tzinfo=UTC),
        )

    return run


def times(result):
    return [datetime.datetime.fromisoformat(p["startTime"]) for p in result["series"]]


def gaps(result):
    stamps = times(result)
    return {later - earlier for earlier, later in zip(stamps, stamps[1:])}


def test_fills_gaps_left_by_omitted_repeated_prices(fetch):
    """Positions 2 and 3 are omitted: their price repeats position 1."""
    result = fetch(
        document(
            period(
                "2025-12-01T00:00Z",
                "2025-12-01T01:00Z",
                "PT15M",
                [(1, 100.0), (4, 200.0)],
            )
        )
    )

    assert [p["price"] for p in result["series"]] == [10.0, 10.0, 10.0, 20.0]
    assert gaps(result) == {datetime.timedelta(minutes=15)}


def test_last_point_holds_until_the_end_of_the_period(fetch):
    """The branch the committed sample never exercises.

    Every period in tests/sample_entsoe_response.xml runs right up to position
    96, so nothing there covers a period whose final point stops short of its
    own timeInterval end.
    """
    result = fetch(
        document(
            period("2025-12-01T00:00Z", "2025-12-01T01:00Z", "PT15M", [(1, 100.0)])
        )
    )

    assert len(result["series"]) == 4
    assert {p["price"] for p in result["series"]} == {10.0}
    assert times(result)[-1] == datetime.datetime(2025, 12, 1, 0, 45, tzinfo=UTC)


def test_expands_hourly_resolution_onto_the_quarter_hour_grid(fetch):
    result = fetch(
        document(
            period(
                "2025-12-01T00:00Z",
                "2025-12-01T02:00Z",
                "PT60M",
                [(1, 100.0), (2, 200.0)],
            )
        )
    )

    assert len(result["series"]) == 8
    assert gaps(result) == {datetime.timedelta(minutes=15)}
    assert [p["price"] for p in result["series"]] == [10.0] * 4 + [20.0] * 4


def test_expands_daily_resolution(fetch):
    result = fetch(
        document(period("2025-12-01T00:00Z", "2025-12-02T00:00Z", "P1D", [(1, 100.0)]))
    )

    assert len(result["series"]) == 96
    assert gaps(result) == {datetime.timedelta(minutes=15)}


def test_mixed_resolutions_produce_one_uniform_grid(fetch):
    """A resolution change mid-document is exactly why a single top-level
    resolution figure has to be true by construction rather than reported."""
    result = fetch(
        document(
            period(
                "2025-12-01T00:00Z",
                "2025-12-01T02:00Z",
                "PT60M",
                [(1, 100.0), (2, 200.0)],
            ),
            period(
                "2025-12-01T02:00Z",
                "2025-12-01T03:00Z",
                "PT15M",
                [(1, 300.0), (2, 400.0), (3, 500.0), (4, 600.0)],
            ),
        )
    )

    assert gaps(result) == {datetime.timedelta(minutes=15)}
    assert len(result["series"]) == 12


def test_periods_out_of_order_are_sorted(fetch):
    result = fetch(
        document(
            period("2025-12-01T01:00Z", "2025-12-01T02:00Z", "PT60M", [(1, 200.0)]),
            period("2025-12-01T00:00Z", "2025-12-01T01:00Z", "PT60M", [(1, 100.0)]),
        )
    )

    assert times(result) == sorted(times(result))
    assert result["series"][0]["price"] == 10.0


def test_unknown_resolution_raises_rather_than_asserting(fetch):
    """This was a bare `assert`, which disappears under `python -O`."""
    with pytest.raises(APIError, match="PT5M"):
        fetch(
            document(
                period("2025-12-01T00:00Z", "2025-12-01T01:00Z", "PT5M", [(1, 100.0)])
            )
        )


def test_non_200_raises_rather_than_returning_an_empty_dict(fetch):
    """Previously returned {}, so the caller died on a KeyError instead."""
    with pytest.raises(APIError, match="503"):
        fetch(b"<html>upstream is unwell</html>", status_code=503)


def test_error_response_does_not_leak_the_token(fetch, caplog):
    with caplog.at_level("ERROR"):
        with pytest.raises(APIError):
            fetch(b"denied for token=token", status_code=401)

    assert "token" not in caplog.text.replace("<redacted>", "")


def test_empty_document_raises_rather_than_publishing_nothing(fetch):
    with pytest.raises(APIError, match="no price points"):
        fetch(document())


def test_prices_are_converted_to_cents_per_kilowatt_hour(fetch):
    """The API reports EUR/MWh."""
    result = fetch(
        document(
            period("2025-12-01T00:00Z", "2025-12-01T00:15Z", "PT15M", [(1, 45.67)])
        )
    )

    assert result["series"][0]["price"] == pytest.approx(4.567)
