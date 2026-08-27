import logging

import pytest

from semerg import main


@pytest.fixture
def no_config_file(monkeypatch, tmp_path):
    """Point the config file lookup at somewhere that does not exist."""
    monkeypatch.setattr(main, "CONFIG_PATH", tmp_path / "config")
    monkeypatch.delenv(main.ENTSOE_TOKEN_ENV, raising=False)
    monkeypatch.delenv(main.FINGRID_TOKEN_ENV, raising=False)


@pytest.fixture
def config_file(monkeypatch, tmp_path):
    path = tmp_path / "config"
    path.write_text(
        '[entsoe]\nsecurity-token = "file-entsoe"\n\n'
        '[fingrid]\nauthentication-token = "file-fingrid"\n')
    monkeypatch.setattr(main, "CONFIG_PATH", path)
    monkeypatch.delenv(main.ENTSOE_TOKEN_ENV, raising=False)
    monkeypatch.delenv(main.FINGRID_TOKEN_ENV, raising=False)
    return path


def test_reads_tokens_from_config_file(config_file):
    config = main.read_config()
    assert config.entsoe_security_token == "file-entsoe"
    assert config.fingrid_authentication_token == "file-fingrid"


def test_environment_takes_precedence_over_config_file(config_file,
                                                       monkeypatch):
    monkeypatch.setenv(main.ENTSOE_TOKEN_ENV, "env-entsoe")
    monkeypatch.setenv(main.FINGRID_TOKEN_ENV, "env-fingrid")

    config = main.read_config()

    assert config.entsoe_security_token == "env-entsoe"
    assert config.fingrid_authentication_token == "env-fingrid"


def test_tokens_can_come_from_different_sources(config_file, monkeypatch):
    """CI may override only one of the two."""
    monkeypatch.setenv(main.ENTSOE_TOKEN_ENV, "env-entsoe")

    config = main.read_config()

    assert config.entsoe_security_token == "env-entsoe"
    assert config.fingrid_authentication_token == "file-fingrid"


def test_works_without_a_config_file(no_config_file, monkeypatch):
    monkeypatch.setenv(main.ENTSOE_TOKEN_ENV, "env-entsoe")
    monkeypatch.setenv(main.FINGRID_TOKEN_ENV, "env-fingrid")

    config = main.read_config()

    assert config.entsoe_security_token == "env-entsoe"


def test_missing_tokens_name_both_mechanisms(no_config_file):
    with pytest.raises(main.ConfigError) as excinfo:
        main.read_config()

    message = str(excinfo.value)
    assert main.ENTSOE_TOKEN_ENV in message
    assert main.FINGRID_TOKEN_ENV in message
    assert "security-token" in message


@pytest.fixture
def redaction_installed(monkeypatch):
    """Install redaction, and undo the global changes afterwards."""
    monkeypatch.setattr(main, "_SECRETS", [])
    original_factory = logging.getLogRecordFactory()
    main.install_log_redaction(
        main.Config(entsoe_security_token="sekrit-entsoe",
                    fingrid_authentication_token="sekrit-fingrid"))
    yield
    logging.setLogRecordFactory(original_factory)


def test_redact_replaces_registered_secrets(redaction_installed):
    text = main.redact(
        "GET https://web-api.tp.entsoe.eu/api?securityToken=sekrit-entsoe "
        "x-api-key: sekrit-fingrid")

    assert "sekrit-entsoe" not in text
    assert "sekrit-fingrid" not in text
    assert text.count("<redacted>") == 2


def test_redaction_reaches_records_from_third_party_loggers(
        redaction_installed, caplog):
    """The case this exists for, and the one a logger-level filter misses.

    urllib3 logs its retry warnings -- including the full request URL, and the
    Entso-E token rides in the query string -- from `urllib3.connectionpool`.
    A logging.Filter attached to the `urllib3` logger never sees that record,
    because filters do not run on records propagating up from child loggers.
    """
    with caplog.at_level(logging.WARNING):
        logging.getLogger("urllib3.connectionpool").warning(
            "Retrying after connection broken by %r: %s",
            "err", "/api?securityToken=sekrit-entsoe")

    assert "sekrit-entsoe" not in caplog.text
    assert "<redacted>" in caplog.text


def test_redaction_covers_deeply_nested_loggers(redaction_installed, caplog):
    with caplog.at_level(logging.ERROR):
        logging.getLogger("a.b.c.d").error(
            "token=sekrit-fingrid")

    assert "sekrit-fingrid" not in caplog.text
