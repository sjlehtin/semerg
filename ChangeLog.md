# ChangeLog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.5.0 - [2024-05-16]

### Added

- Added `--wait-between-requests` option for the command. The API endpoint does not like being called immediately after a previous call.

## 0.4.0 - [2024-05-02]

### Added

- Added solar production forecast.

### Fixed

- Fixed to use https://data.fingrid.fi/api API endpoint, old one ceased to work just before May Day.

## 0.3.0 - [2024-01-29]

### Changed

- Move price adjustment to the client code.

## 0.2.0 - [2024-01-26]

### Added

- Host project as open source in GitHub.

### Changed

- Renamed command `semerg day-ahead-prices` to `semerg gather-data`.
