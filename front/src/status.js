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
 * How often `refresh-data.yml` publishes a new `data.json`. Keep in step with
 * its cron -- every series here is judged against the wall clock, so the whole
 * page is at least this far behind for a moment before each refresh lands.
 */
const REFRESH_CADENCE_HOURS = 1;

/**
 * GitHub's scheduler is congested at the top of the hour and routinely runs a
 * scheduled job 5-20 minutes late, which is why the cron fires at :07 in the
 * first place. A refresh being late is not a source being down.
 */
const SCHEDULER_SLACK_HOURS = 0.5;

/**
 * The floor under every grace period.
 *
 * No series is behind merely because the next publish has not happened yet, so
 * nothing may be reported sooner than the publishing cadence, however a series
 * below tunes itself.
 */
const MINIMUM_GRACE_HOURS = REFRESH_CADENCE_HOURS + SCHEDULER_SLACK_HOURS;

/**
 * Total age a series may reach before it is worth reporting, floored at
 * `MINIMUM_GRACE_HOURS`.
 *
 * This is the number to tune. It covers the source's own publication lag *on
 * top of* our cadence, because the reader sees the sum of the two: a reading
 * taken shortly before a fetch is already an hour old by the time the next
 * fetch is due.
 */
function graceHoursFor(series) {
  return Math.max(series.graceHours ?? 0, MINIMUM_GRACE_HOURS);
}

/**
 * Where a source announces its own outages.
 *
 * Linked rather than fetched and summarised. It is the platform's whole news
 * feed, not an incident feed, so deciding which entries are relevant is real
 * design work -- and the feed lives on the platform that is down, so it cannot
 * be relied on at the moment it would be quoted.
 */
const PLATFORM_NOTICES = "https://external-api.tp.entsoe.eu/news/feed";

const SERIES = [
  {
    key: "basePrices",
    label: "Spot price",
    source: "Entso-E",
    noun: "Price",
    notices: PLATFORM_NOTICES,
  },
  {
    key: "windProduction",
    label: "Wind production",
    source: "Fingrid",
    noun: "Production",
    // Measurement, not forecast: it never reaches the present. Fingrid's last
    // reading is around half an hour old when we fetch it, and that fetch is
    // already a cadence old by the time the next one is due. Three hours
    // reports two missed refreshes in a row and stays quiet otherwise.
    graceHours: 3,
  },
  {
    key: "windProductionForecast",
    label: "Wind forecast",
    source: "Fingrid",
    noun: "Forecast",
  },
  {
    key: "solarProductionForecast",
    label: "Solar forecast",
    source: "Fingrid",
    noun: "Forecast",
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

  const item = { title: `${series.label} (${series.source})`, lines };
  if (series.notices) {
    item.link = { href: series.notices, text: `${series.source} news feed` };
  }
  return item;
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
    const deadline = now.minus({ hours: graceHoursFor(series) });

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
