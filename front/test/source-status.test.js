import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import { sourceStatus } from "../src/status.js";

const NOW = DateTime.fromISO("2025-12-01T12:00:00Z");

/** A series of `count` readings ending `hoursAgo` before NOW. */
function series(count, endingHoursFromNow, key = "energy") {
  const end = NOW.plus({ hours: endingHoursFromNow });
  return Array.from({ length: count }, (_, i) => ({
    startTime: end.minus({ minutes: 15 * (count - 1 - i) }).toISO(),
    [key]: 10,
  }));
}

/** Both sources behaving: prices ahead, forecasts ahead, actuals just behind. */
function healthy(overrides = {}) {
  return {
    basePrices: series(8, 11, "price"),
    windProduction: series(8, -0.5),
    windProductionForecast: series(8, 11),
    solarProductionForecast: series(8, 11),
    ...overrides,
  };
}

describe("sourceStatus", () => {
  it("says nothing when both sources are behaving", () => {
    expect(sourceStatus(healthy(), NOW)).toBeNull();
  });

  it("reports prices that are absent, with the reason", () => {
    const status = sourceStatus(
      healthy({
        basePrices: [],
        notices: [
          {
            series: "basePrices",
            state: "missing",
            detail: "Failed to fetch Entso-E data, code: 503.",
          },
        ],
      }),
      NOW,
    );

    expect(status.summary).toBe("Price data missing");
    expect(status.items).toHaveLength(1);
    expect(status.items[0].title).toBe("Spot price (Entso-E)");
    expect(status.items[0].lines).toContain("Missing from the latest update.");
    expect(status.items[0].lines).toContain(
      "Failed to fetch Entso-E data, code: 503.",
    );
  });

  it("reports prices that are present but no longer moving", () => {
    // The case the page used to draw as though nothing were wrong: the
    // publisher carried the last good prices forward, so they are there, they
    // are just old.
    const status = sourceStatus(
      healthy({
        basePrices: series(8, -36, "price"),
        notices: [
          {
            series: "basePrices",
            state: "carriedForward",
            detail: "Failed to fetch Entso-E data, code: 503.",
          },
        ],
      }),
      NOW,
    );

    expect(status.summary).toBe("Price data out of date");
    expect(status.items[0].lines[0]).toMatch(/^Nothing newer than /);
    expect(status.items[0].lines[1]).toBe(
      "Held over from an earlier update; it is no longer being refreshed.",
    );
  });

  it("points at the platform's own news feed for an Entso-E fault", () => {
    const status = sourceStatus(healthy({ basePrices: [] }), NOW);

    expect(status.items[0].link).toEqual({
      href: "https://external-api.tp.entsoe.eu/news/feed",
      text: "Entso-E news feed",
    });
  });

  it("offers no such link for a source that has none", () => {
    const status = sourceStatus(healthy({ solarProductionForecast: [] }), NOW);

    expect(status.items[0].title).toBe("Solar forecast (Fingrid)");
    expect(status.items[0].link).toBeUndefined();
  });

  it("reports the production forecasts", () => {
    const status = sourceStatus(
      healthy({ windProductionForecast: [], solarProductionForecast: [] }),
      NOW,
    );

    expect(status.summary).toBe("Forecast data missing");
    expect(status.items.map((item) => item.title)).toEqual([
      "Wind forecast (Fingrid)",
      "Solar forecast (Fingrid)",
    ]);
  });

  it("names both sources when both are affected", () => {
    const status = sourceStatus(
      healthy({ basePrices: [], solarProductionForecast: [] }),
      NOW,
    );

    expect(status.summary).toBe("Price and forecast data missing");
  });

  it("says out of date unless everything affected is absent", () => {
    const status = sourceStatus(
      healthy({ basePrices: [], windProductionForecast: series(8, -3) }),
      NOW,
    );

    expect(status.summary).toBe("Price and forecast data out of date");
  });

  it("tolerates wind actuals lagging, and reports them when they stop", () => {
    expect(
      sourceStatus(healthy({ windProduction: series(8, -1) }), NOW),
    ).toBeNull();

    // Measurement, not a forecast, and the summary says so.
    const status = sourceStatus(
      healthy({ windProduction: series(8, -3) }),
      NOW,
    );
    expect(status.summary).toBe("Production data out of date");
    expect(status.items[0].title).toBe("Wind production (Fingrid)");
  });

  it("lists every kind of series affected", () => {
    const status = sourceStatus(
      healthy({
        basePrices: [],
        windProduction: series(8, -3),
        solarProductionForecast: [],
      }),
      NOW,
    );

    expect(status.summary).toBe(
      "Price, production and forecast data out of date",
    );
  });

  it("works on data with no notices, as an older bundle would see it", () => {
    const status = sourceStatus(healthy({ basePrices: [] }), NOW);

    expect(status.summary).toBe("Price data missing");
    expect(status.items[0].lines).toEqual(["Missing from the latest update."]);
  });
});
