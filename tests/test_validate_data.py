import datetime

import pytest

from semerg import main
from semerg.main import ValidationError

UTC = datetime.timezone.utc


def series(start, count, step_minutes=15):
    """A dense price series of `count` points starting at `start` (UTC)."""
    return [
        {"startTime": (start + datetime.timedelta(
            minutes=step_minutes * i)).isoformat(), "price": 5.0}
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

    assert main.validate_data(data_covering_until(end_of_day), now=now)


def test_rejects_data_falling_short_of_the_end_of_the_finnish_day():
    now = datetime.datetime(2025, 12, 1, 10, 0, tzinfo=UTC)
    short = main.end_of_helsinki_day(now) - datetime.timedelta(minutes=15)

    with pytest.raises(ValidationError, match="short of the end"):
        main.validate_data(data_covering_until(short), now=now)


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

    assert main.validate_data(data_covering_until(winter_cet_day_end), now=now)


def test_rejects_a_series_shorter_than_what_is_already_published():
    now = datetime.datetime(2025, 12, 1, 10, 0, tzinfo=UTC)
    end_of_day = main.end_of_helsinki_day(now)
    published = data_covering_until(end_of_day + datetime.timedelta(days=1))
    regressed = data_covering_until(end_of_day)

    with pytest.raises(ValidationError, match="Refusing to regress"):
        main.validate_data(regressed, previous=published, now=now)


def test_accepts_a_series_that_extends_what_is_already_published():
    now = datetime.datetime(2025, 12, 1, 10, 0, tzinfo=UTC)
    end_of_day = main.end_of_helsinki_day(now)
    published = data_covering_until(end_of_day)
    extended = data_covering_until(end_of_day + datetime.timedelta(days=1))

    assert main.validate_data(extended, previous=published, now=now)


def test_a_corrupt_published_file_does_not_block_a_good_one():
    now = datetime.datetime(2025, 12, 1, 10, 0, tzinfo=UTC)
    good = data_covering_until(main.end_of_helsinki_day(now))

    assert main.validate_data(good, previous={"basePrices": []}, now=now)


@pytest.mark.parametrize("data", [
    {},
    {"basePrices": []},
], ids=["missing", "empty"])
def test_rejects_data_without_prices(data):
    with pytest.raises(ValidationError, match="basePrices"):
        main.validate_data(data)


def test_infers_the_step_from_the_series():
    start = datetime.datetime(2025, 12, 1, tzinfo=UTC)

    assert main.infer_step(series(start, 4, 15)) == datetime.timedelta(
        minutes=15)
    assert main.infer_step(series(start, 4, 60)) == datetime.timedelta(
        minutes=60)


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

    assert end.astimezone(UTC) == datetime.datetime(
        2025, 12, 1, 22, 0, tzinfo=UTC)


def test_end_of_finnish_day_handles_summer_time():
    now = datetime.datetime(2025, 7, 1, 12, 0, tzinfo=UTC)

    end = main.end_of_helsinki_day(now)

    assert end.astimezone(UTC) == datetime.datetime(
        2025, 7, 1, 21, 0, tzinfo=UTC)
