import datetime

import pytest

from semerg import main
from semerg.main import ValidationError

UTC = datetime.UTC


def series(start, count, step_minutes=15):
    """A dense price series of `count` points starting at `start` (UTC)."""
    return [
        {
            "startTime": (
                start + datetime.timedelta(minutes=step_minutes * i)
            ).isoformat(),
            "price": 5.0,
        }
        for i in range(count)
    ]


def production(count, start=datetime.datetime(2025, 12, 1, tzinfo=UTC)):
    """A production series of `count` 15-minute readings."""
    return [
        {
            "startTime": (start + datetime.timedelta(minutes=15 * i)).isoformat(),
            "energy": 100.0,
        }
        for i in range(count)
    ]


def data_covering_until(end, step_minutes=15):
    """Data whose last price slot ends exactly at `end`."""
    count = 8
    start = end - datetime.timedelta(minutes=step_minutes * count)
    return {"basePrices": series(start, count, step_minutes)}


def test_accepts_data_reaching_the_end_of_the_finnish_day():
    now = datetime.datetime(2025, 12, 1, 10, 0, tzinfo=UTC)
    end_of_day = main.end_of_helsinki_day(now)

    assert main.check_price_coverage(data_covering_until(end_of_day), now=now)


def test_rejects_data_falling_short_of_the_end_of_the_finnish_day():
    now = datetime.datetime(2025, 12, 1, 10, 0, tzinfo=UTC)
    short = main.end_of_helsinki_day(now) - datetime.timedelta(minutes=15)

    with pytest.raises(ValidationError, match="short of the end"):
        main.check_price_coverage(data_covering_until(short), now=now)


def test_short_prices_still_publish():
    """The coverage alarm must not gate a publish.

    An Entso-E outage leaves the prices standing still while the production
    series keep arriving. Refusing to publish then would spread one source's
    outage across the whole page.
    """
    now = datetime.datetime(2025, 12, 1, 10, 0, tzinfo=UTC)
    short = main.end_of_helsinki_day(now) - datetime.timedelta(hours=6)

    assert main.validate_data(data_covering_until(short))


@pytest.mark.parametrize("hour", [9, 10, 11, 12, 13])
def test_accepts_entsoe_coverage_at_every_hour_before_publication(hour):
    """Entso-E publishes on CET day boundaries, so coverage runs to 23:00Z in
    winter -- an hour past the end of the Finnish day, and no further.

    A fixed "must cover the next N hours" rule fails once every day just before
    Nord Pool publishes the following day. This is the regression test for that:
    the same, entirely healthy data must validate at every hour of the morning.
    """
    now = datetime.datetime(2025, 12, 1, hour, 7, tzinfo=UTC)
    winter_cet_day_end = datetime.datetime(2025, 12, 1, 23, 0, tzinfo=UTC)

    assert main.check_price_coverage(data_covering_until(winter_cet_day_end), now=now)


def test_rejects_a_series_shorter_than_what_is_already_published():
    now = datetime.datetime(2025, 12, 1, 10, 0, tzinfo=UTC)
    end_of_day = main.end_of_helsinki_day(now)
    published = data_covering_until(end_of_day + datetime.timedelta(days=1))
    regressed = data_covering_until(end_of_day)

    with pytest.raises(ValidationError, match="Refusing to regress"):
        main.validate_data(regressed, previous=published)


def test_accepts_a_series_that_extends_what_is_already_published():
    now = datetime.datetime(2025, 12, 1, 10, 0, tzinfo=UTC)
    end_of_day = main.end_of_helsinki_day(now)
    published = data_covering_until(end_of_day)
    extended = data_covering_until(end_of_day + datetime.timedelta(days=1))

    assert main.validate_data(extended, previous=published)


def test_a_corrupt_published_file_does_not_block_a_good_one():
    now = datetime.datetime(2025, 12, 1, 10, 0, tzinfo=UTC)
    good = data_covering_until(main.end_of_helsinki_day(now))

    assert main.validate_data(good, previous={"basePrices": []})


@pytest.mark.parametrize(
    "data",
    [
        {},
        {"basePrices": [], "windProduction": []},
    ],
    ids=["missing", "empty"],
)
def test_rejects_data_with_no_series_at_all(data):
    with pytest.raises(ValidationError, match="nothing here to publish"):
        main.validate_data(data)


def test_accepts_production_data_without_prices():
    """An Entso-E outage must not take the production series off the page."""
    assert main.validate_data({"windProduction": production(2)}) is None


def test_the_coverage_alarm_fires_when_there_are_no_prices_at_all():
    with pytest.raises(ValidationError, match="basePrices"):
        main.check_price_coverage({"windProduction": production(2)})


def test_rejects_dropping_a_published_series():
    """Publishing a fetch that lost a source would blank a live series."""
    now = datetime.datetime(2025, 12, 1, 10, 0, tzinfo=UTC)
    published = data_covering_until(main.end_of_helsinki_day(now))
    published["solarProductionForecast"] = production(2)

    with pytest.raises(ValidationError, match="solarProductionForecast"):
        main.validate_data(
            dict(published, solarProductionForecast=[]), previous=published
        )


def test_carries_forward_the_series_a_fetch_is_missing():
    now = datetime.datetime(2025, 12, 1, 10, 0, tzinfo=UTC)
    published = data_covering_until(main.end_of_helsinki_day(now))
    published["priceResolutionMinutes"] = 15
    published["windProduction"] = production(2)
    fresh = {"windProduction": production(4)}

    merged = main.merge_data(fresh, published)

    # Prices and the resolution that describes them travel together.
    assert merged["basePrices"] == published["basePrices"]
    assert merged["priceResolutionMinutes"] == 15
    # What the fetch did get is left alone.
    assert merged["windProduction"] == fresh["windProduction"]
    assert main.validate_data(merged, previous=published)


def test_merging_leaves_a_complete_fetch_untouched():
    now = datetime.datetime(2025, 12, 1, 10, 0, tzinfo=UTC)
    published = data_covering_until(main.end_of_helsinki_day(now))
    fresh = data_covering_until(
        main.end_of_helsinki_day(now) + datetime.timedelta(days=1)
    )

    assert main.merge_data(fresh, published) == fresh


def test_infers_the_step_from_the_series():
    start = datetime.datetime(2025, 12, 1, tzinfo=UTC)

    assert main.infer_step(series(start, 4, 15)) == datetime.timedelta(minutes=15)
    assert main.infer_step(series(start, 4, 60)) == datetime.timedelta(minutes=60)


def test_infers_the_smallest_step_from_a_sparse_series():
    """Entso-E omits repeated prices, so gaps are wider than the resolution."""
    points = [
        {"startTime": "2025-12-01T00:00:00+00:00", "price": 5.0},
        {"startTime": "2025-12-01T00:15:00+00:00", "price": 6.0},
        {"startTime": "2025-12-01T02:15:00+00:00", "price": 7.0},
    ]

    assert main.infer_step(points) == datetime.timedelta(minutes=15)


def test_end_of_finnish_day_follows_finnish_time_not_the_runners_clock():
    """23:30 Helsinki on 1 Dec is 21:30Z; the day still ends at 22:00Z."""
    now = datetime.datetime(2025, 12, 1, 21, 30, tzinfo=UTC)

    end = main.end_of_helsinki_day(now)

    assert end.astimezone(UTC) == datetime.datetime(2025, 12, 1, 22, 0, tzinfo=UTC)


def test_end_of_finnish_day_handles_summer_time():
    now = datetime.datetime(2025, 7, 1, 12, 0, tzinfo=UTC)

    end = main.end_of_helsinki_day(now)

    assert end.astimezone(UTC) == datetime.datetime(2025, 7, 1, 21, 0, tzinfo=UTC)
