import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";

import { priceFor, transmission, ZONE } from "../src/tariff.js";

/**
 * Characterisation test: what the page reports TODAY.
 *
 * These numbers were produced by the previous implementation, the `adjust()`
 * function in the old energy.js, reading hours in Helsinki time. They are
 * recorded here so that restructuring the tariff into a module provably does
 * not move a single figure.
 *
 * Several of them are KNOWN TO BE WRONG -- the electricity tax and the
 * security-of-supply fee still carry 24% VAT, and both the transfer rates and
 * the security-of-supply rate itself have since changed. They are pinned anyway,
 * because the point of this test is to isolate the restructure from the
 * correction. The following commit changes these expected values, and that diff
 * is the reviewable record of what this tool now tells someone their
 * electricity costs.
 */
const CURRENT_BEHAVIOUR = [
  ["06:59 Helsinki, winter — night rate", "2025-12-01T04:59:00+00:00", 10.0, 17.24372],
  ["07:00 Helsinki, winter — day rate begins", "2025-12-01T05:00:00+00:00", 10.0, 19.04372],
  ["21:59 Helsinki, winter — last day slot", "2025-12-01T19:59:00+00:00", 10.0, 19.04372],
  ["22:00 Helsinki, winter — night rate resumes", "2025-12-01T20:00:00+00:00", 10.0, 17.24372],
  ["07:00 Helsinki, summer — day rate across DST", "2025-07-01T04:00:00+00:00", 10.0, 19.04372],
  ["06:59 Helsinki, summer — night rate across DST", "2025-07-01T03:59:00+00:00", 10.0, 17.24372],
  ["negative spot — not marked up by VAT", "2025-12-01T12:00:00+00:00", -2.5, 3.99372],
  ["zero spot", "2025-12-01T12:00:00+00:00", 0.0, 6.49372],
  ["high spot, daytime", "2025-12-01T12:00:00+00:00", 45.67, 63.80957],
];

describe("priceFor", () => {
  it.each(CURRENT_BEHAVIOUR)("%s", (_name, isoTime, basePrice, expected) => {
    expect(priceFor(basePrice, isoTime)).toBeCloseTo(expected, 5);
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
    expect(justAfterSeven - beforeSix).toBeCloseTo(1.8, 5);
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
