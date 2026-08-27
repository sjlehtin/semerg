import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";

import { priceFor, transmission, ZONE } from "../src/tariff.js";

/**
 * What the page reports, pinned.
 *
 * These are recomputed deliberately whenever a published rate changes, in a
 * commit that changes nothing else, so that the diff is a reviewable record of
 * what this tool now tells someone their electricity costs.
 *
 * Previous values, and why they moved (all figures c/kWh):
 *
 *   17.24372 -> 17.386025   night
 *   19.04372 -> 19.268525   day
 *
 * Three separate corrections, none of which had reached the page:
 *
 *   - Electricity tax and the security-of-supply fee were still grossed up at
 *     24% VAT. Only the spot multiplier was updated when VAT rose to 25.5% in
 *     September 2024, so 2.7776 (= 2.24 x 1.24) and 0.01612 (= 0.013 x 1.24)
 *     kept the old rate for over a year.
 *   - The security-of-supply fee itself rose from 0.013 to 0.085 on
 *     2026-04-01, which is by far the largest of the three.
 *   - The transfer tariff is 2.63 / 1.13 ex-VAT, not 2.5498 / 1.1155.
 *
 * The supplier margin was already correct at 0.50 incl. VAT.
 */
const CURRENT_BEHAVIOUR = [
  ["06:59 Helsinki, winter — night rate", "2025-12-01T04:59:00+00:00", 10.0, 17.38602500],
  ["07:00 Helsinki, winter — day rate begins", "2025-12-01T05:00:00+00:00", 10.0, 19.26852500],
  ["21:59 Helsinki, winter — last day slot", "2025-12-01T19:59:00+00:00", 10.0, 19.26852500],
  ["22:00 Helsinki, winter — night rate resumes", "2025-12-01T20:00:00+00:00", 10.0, 17.38602500],
  ["07:00 Helsinki, summer — day rate across DST", "2025-07-01T04:00:00+00:00", 10.0, 19.26852500],
  ["06:59 Helsinki, summer — night rate across DST", "2025-07-01T03:59:00+00:00", 10.0, 17.38602500],
  ["negative spot — not marked up by VAT", "2025-12-01T12:00:00+00:00", -2.5, 4.21852500],
  ["zero spot", "2025-12-01T12:00:00+00:00", 0.0, 6.71852500],
  ["high spot, daytime", "2025-12-01T12:00:00+00:00", 45.67, 64.03437500],
];

describe("priceFor", () => {
  it.each(CURRENT_BEHAVIOUR)("%s", (_name, isoTime, basePrice, expected) => {
    expect(priceFor(basePrice, isoTime)).toBeCloseTo(expected, 6);
  });

  it("accepts a Luxon DateTime as well as an ISO string", () => {
    const iso = "2025-12-01T12:00:00+00:00";

    expect(priceFor(10, DateTime.fromISO(iso))).toBeCloseTo(
      priceFor(10, iso),
      10,
    );
  });
});

describe("the day/night transfer boundary", () => {
  /**
   * The regression test for the bug this restructure fixes.
   *
   * The old code read the hour with Date#getHours(), i.e. in the browser's own
   * zone, so the transfer fee stepped at 07:00 wherever the reader happened to
   * be. These tests run with TZ=UTC (pinned in vite.config.js), so under the old
   * implementation the two cases below would have come out identical.
   */
  it("steps at 07:00 Helsinki, not 07:00 in the runner's zone", () => {
    const beforeSix = priceFor(10, "2025-07-01T03:59:00+00:00");
    const justAfterSeven = priceFor(10, "2025-07-01T04:00:00+00:00");

    expect(justAfterSeven).toBeGreaterThan(beforeSix);
    expect(justAfterSeven - beforeSix).toBeCloseTo(1.8825, 5);
  });

  it("uses the same wall-clock hours in winter and summer", () => {
    const winter = DateTime.fromISO("2025-12-01T07:00", { zone: ZONE });
    const summer = DateTime.fromISO("2025-07-01T07:00", { zone: ZONE });

    expect(transmission.rateAt(winter)).toBe(transmission.dayRate);
    expect(transmission.rateAt(summer)).toBe(transmission.dayRate);
    expect(winter.offset).not.toBe(summer.offset);
  });

  it("applies the day rate on weekends too", () => {
    // "kaikkina viikonpäivinä klo 7-22" -- every day of the week.
    const saturday = DateTime.fromISO("2025-12-06T12:00", { zone: ZONE });
    const sunday = DateTime.fromISO("2025-12-07T12:00", { zone: ZONE });

    expect(saturday.weekday).toBe(6);
    expect(transmission.rateAt(saturday)).toBe(transmission.dayRate);
    expect(transmission.rateAt(sunday)).toBe(transmission.dayRate);
  });

  it("treats 22:00 as night and 21:59 as day", () => {
    const lastDay = DateTime.fromISO("2025-12-01T21:59", { zone: ZONE });
    const firstNight = DateTime.fromISO("2025-12-01T22:00", { zone: ZONE });

    expect(transmission.rateAt(lastDay)).toBe(transmission.dayRate);
    expect(transmission.rateAt(firstNight)).toBe(transmission.nightRate);
  });
});
