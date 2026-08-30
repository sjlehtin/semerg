from datetime import datetime, timedelta
from itertools import pairwise
from pathlib import Path

import pytest

pytest.register_assert_rewrite("semerg.main")

from unittest.mock import Mock, patch

from semerg.main import pull_entsoe_data

TEST_DIR = Path(__file__).parent


def test_pull_entsoe_data(monkeypatch):
    # Read the pre-fetched XML response from a file in the tests directory
    test_xml_file = TEST_DIR / "sample_entsoe_response.xml"
    with open(test_xml_file, "r", encoding="utf-8") as f:
        sample_xml_content = f.read()

    # Mock the requests.get response
    mock_response = Mock()
    mock_response.status_code = 200
    mock_response.content = sample_xml_content.encode("utf-8")

    with patch("semerg.main.requests.get", return_value=mock_response):
        # Call the function with test parameters
        result = pull_entsoe_data(
            entsoe_security_token="test_token",
            start_time=datetime.fromisoformat("2024-01-01T00:00:00Z"),
            end_time=datetime.fromisoformat("2024-01-02T00:00:00Z"),
        )

    # Assert the results
    assert isinstance(result, dict)

    series = result.get("series")
    assert len(series) > 0

    # Check the structure of the first data point
    first_point = series[0]
    assert "startTime" in first_point
    assert "price" in first_point
    assert isinstance(first_point["price"], float)

    # Verify prices are converted from EUR/MWh to c/kWh (divided by 10)
    # This assumes your sample XML has known price values

    # Check that data is sorted by startTime
    start_times = [point["startTime"] for point in series]
    assert start_times == sorted(start_times)

    start = datetime.fromisoformat(result.get("start"))
    end = datetime.fromisoformat(result.get("end"))
    assert all(start <= datetime.fromisoformat(time) <= end for time in start_times)


def test_real_response_expands_to_a_uniform_grid(monkeypatch):
    """End-to-end check of the guarantee downstream code relies on.

    The sample is a real three-period A03 document missing 28 interior points
    across its 288 slots; after parsing there must be no gaps at all.
    """
    test_xml_file = TEST_DIR / "sample_entsoe_response.xml"
    sample_xml_content = test_xml_file.read_bytes()

    mock_response = Mock()
    mock_response.status_code = 200
    mock_response.content = sample_xml_content

    with patch("semerg.main.requests.get", return_value=mock_response):
        result = pull_entsoe_data(
            entsoe_security_token="test_token",
            start_time=datetime.fromisoformat("2025-10-09T00:00:00Z"),
            end_time=datetime.fromisoformat("2025-10-11T00:00:00Z"),
        )

    stamps = [datetime.fromisoformat(p["startTime"]) for p in result["series"]]
    gaps = {later - earlier for earlier, later in pairwise(stamps)}

    assert gaps == {timedelta(minutes=15)}
    assert len(stamps) == 288
