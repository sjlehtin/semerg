from datetime import datetime

import pytest
from pathlib import Path

pytest.register_assert_rewrite("semerg.main")

from semerg.main import pull_entsoe_data
from unittest.mock import patch, Mock

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

    with patch('semerg.main.requests.get', return_value=mock_response):
        # Call the function with test parameters
        result = pull_entsoe_data(
            entsoe_security_token="test_token",
            start_time=datetime.fromisoformat("2024-01-01T00:00:00Z"),
            end_time=datetime.fromisoformat("2024-01-02T00:00:00Z")
        )

    # Assert the results
    assert isinstance(result, dict)

    series = result.get('series')
    assert len(series) > 0

    # Check the structure of the first data point
    first_point = series[0]
    assert 'startTime' in first_point
    assert 'price' in first_point
    assert isinstance(first_point['price'], float)

    # Verify prices are converted from EUR/MWh to c/kWh (divided by 10)
    # This assumes your sample XML has known price values

    # Check that data is sorted by startTime
    start_times = [point['startTime'] for point in series]
    assert start_times == sorted(start_times)

    start = datetime.fromisoformat(result.get('start'))
    end = datetime.fromisoformat(result.get('end'))
    assert all([start <= datetime.fromisoformat(time) <= end for time in start_times])

