/**
 * What to tell the reader about the two upstream sources.
 *
 * Prices come from Entso-E and production from Fingrid, which fail
 * independently -- the page keeps drawing whichever still arrived. An absent
 * series is at least visibly absent; one the publisher carried forward while
 * its source was down is worse, because it looks like ordinary data. Both are
 * reported here.
 */
import { DateTime } from "luxon";

import { ZONE } from "./tariff.js";

/**
 * How far behind a measured series may fall before it is worth reporting.
 *
 * Fingrid's wind actuals are measurement, not forecast, so they always lag by
 * some minutes. Reporting that as a fault would train the reader to ignore the
 * indicator.
 */
const MEASUREMENT_GRACE_HOURS = 2;

const SERIES = [
  {
    key: "basePrices",
    label: "Spot price",
    source: "Entso-E",
    noun: "Price",
    measured: false,
  },
  {
    key: "windProduction",
    label: "Wind production",
    source: "Fingrid",
    noun: "Production",
    measured: true,
  },
  {
    key: "windProductionForecast",
    label: "Wind forecast",
    source: "Fingrid",
    noun: "Forecast",
    measured: false,
  },
  {
    key: "solarProductionForecast",
    label: "Solar forecast",
    source: "Fingrid",
    noun: "Forecast",
    measured: false,
  },
];

const at = (time) => time.setZone(ZONE).toFormat("ccc d LLL, HH:mm");

function lastPointOf(points) {
  const last = points.at(-1)?.startTime;
  return last ? DateTime.fromISO(last) : null;
}

function describe(series, state, last, notice) {
  const lines = [];

  if (state === "missing") {
    lines.push("Missing from the latest update.");
  } else {
    lines.push(`Nothing newer than ${at(last)}.`);
  }

  // `notices` is optional: assets are immutable, so a long-open tab can pair
  // an old bundle with new data and vice versa. Everything below degrades to
  // saying only what the series itself shows.
  if (notice?.state === "carriedForward") {
    lines.push(
      "Held over from an earlier update; it is no longer being refreshed.",
    );
  }
  if (notice?.detail) {
    lines.push(notice.detail);
  }

  return { title: `${series.label} (${series.source})`, lines };
}

/**
 * "Price", "Price and forecast", "Price, production and forecast".
 *
 * Kept honest rather than short: wind production is measurement, not a
 * forecast, and the moment the page is telling the reader something is wrong
 * is the wrong moment to be loose about which is which.
 */
function subject(nouns) {
  const listed = nouns.map((noun, index) =>
    index === 0 ? noun : noun.toLowerCase(),
  );
  if (listed.length === 1) return listed[0];
  return `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}`;
}

/**
 * A warning to show, or null when both sources are behaving.
 *
 * Returns the summary the indicator carries and one entry per affected series,
 * which is what opens up underneath it.
 */
export function sourceStatus(data, now = DateTime.now()) {
  const notices = data?.notices ?? [];
  const affected = [];

  for (const series of SERIES) {
    const points = data?.[series.key] ?? [];
    const last = lastPointOf(points);
    const deadline = series.measured
      ? now.minus({ hours: MEASUREMENT_GRACE_HOURS })
      : now;

    let state = null;
    if (!points.length) {
      state = "missing";
    } else if (last && last < deadline) {
      state = "stale";
    }
    if (!state) continue;

    affected.push({
      series,
      state,
      item: describe(
        series,
        state,
        last,
        notices.find((notice) => notice.series === series.key),
      ),
    });
  }

  if (!affected.length) return null;

  const nouns = SERIES.map((series) => series.noun).filter((noun) =>
    affected.some(({ series }) => series.noun === noun),
  );
  const verb = affected.every(({ state }) => state === "missing")
    ? "missing"
    : "out of date";

  return {
    summary: `${subject([...new Set(nouns)])} data ${verb}`,
    items: affected.map(({ item }) => item),
  };
}
