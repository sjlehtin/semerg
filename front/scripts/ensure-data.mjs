// A fresh clone has no public/data.json -- it is gitignored, because a real
// fetch writes real data there. Seed it from the committed sample so that
// `npm run dev` works without API tokens.
//
// The sample holds real prices from a real day, which makes it honest but
// useless for looking at the page: nothing schedules against a day two years
// ago. So the timestamps are shifted onto today. The shape and the prices are
// untouched; only the dates move.
import { access, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../public/", import.meta.url));

/**
 * Marks a file this script wrote.
 *
 * Seeded data goes stale -- it is pinned to the day it was generated -- so it
 * has to be regenerated, but a real `semerg gather-data --output` into this
 * path must never be clobbered. Only files carrying this flag are replaced.
 */
const FIXTURE_FLAG = "_devFixture";

function shift(series, offsetMs) {
  return series?.map((point) => ({
    ...point,
    startTime: new Date(Date.parse(point.startTime) + offsetMs).toISOString(),
  }));
}

async function readIfPresent(path) {
  try {
    await access(path);
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function isStale(data) {
  const prices = data?.basePrices;
  if (!prices?.length) return true;
  return Date.parse(prices.at(-1).startTime) < Date.now();
}

const target = dir + "data.json";
const existing = await readIfPresent(target);

if (existing && !(existing[FIXTURE_FLAG] && isStale(existing))) {
  // Either real data, or a fixture that still covers the present.
} else {
  const sample = JSON.parse(await readFile(dir + "data.sample.json", "utf8"));

  // Anchor the first price to the start of today, which puts the sample's
  // 46 hours of prices across today and tomorrow.
  //
  // Not the start of yesterday, and not the sample's own `startTime`. The
  // sample was captured at 12:19, before Nord Pool publishes the next day
  // around 14:00, so it contains no tomorrow of its own -- anchoring it
  // faithfully reproduces a morning with nothing ahead of it. Sliding it
  // forward gives the more useful afternoon shape, where there is a next day
  // to see and to schedule into.
  const first = Date.parse(sample.basePrices[0].startTime);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const offset = startOfToday.getTime() - first;

  const seeded = {
    ...sample,
    [FIXTURE_FLAG]: true,
    fetchTime: new Date().toISOString(),
  };
  for (const key of [
    "basePrices",
    "windProduction",
    "windProductionForecast",
    "solarProductionForecast",
  ]) {
    if (seeded[key]) seeded[key] = shift(seeded[key], offset);
  }
  seeded.startTime = new Date(Date.parse(sample.startTime) + offset).toISOString();
  seeded.endTime = new Date(Date.parse(sample.endTime) + offset).toISOString();

  await writeFile(target, JSON.stringify(seeded));
  console.log(
    existing
      ? "Re-seeded stale public/data.json from data.sample.json"
      : "Seeded public/data.json from data.sample.json",
  );
}
