import { describe, expect, it } from "vitest";

import { nearestIndexByTime } from "../src/chart.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Timestamps every 15 minutes from 0, with the given gaps skipped. */
function grid(count, { skipAfter = [] } = {}) {
  const times = [];
  let t = 0;
  for (let i = 0; i < count; i += 1) {
    times.push(t);
    t += skipAfter.includes(i) ? 2 * 15 * MINUTE : 15 * MINUTE;
  }
  return times;
}

describe("nearestIndexByTime", () => {
  it("picks the closest reading", () => {
    const times = grid(8);

    expect(nearestIndexByTime(times, 30 * MINUTE)).toBe(2);
    expect(nearestIndexByTime(times, 32 * MINUTE)).toBe(2);
    expect(nearestIndexByTime(times, 38 * MINUTE)).toBe(3);
  });

  /**
   * The bug this replaced Chart.js's "index" mode for.
   *
   * Entso-E omits repeated prices, so the price series carries gaps the evenly
   * sampled Fingrid series do not. Matching on array position therefore drifts
   * further apart the further right you hover; matching on time does not.
   */
  it("agrees across series that do not share a timestamp list", () => {
    const prices = grid(20, { skipAfter: [2, 9] }); // two gaps
    const production = grid(20); // evenly sampled

    for (const hovered of [1 * HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR]) {
      const priceIndex = nearestIndexByTime(prices, hovered);
      const productionIndex = nearestIndexByTime(production, hovered);

      // The array positions differ -- that is the whole problem --
      expect(priceIndex).not.toBe(productionIndex);
      // -- but the times they resolve to agree.
      expect(
        Math.abs(prices[priceIndex] - production[productionIndex]),
      ).toBeLessThanOrEqual(15 * MINUTE);
    }
  });

  it("drops a series whose nearest reading is too far away", () => {
    // Fingrid's actual wind production stops at the present moment; without a
    // cutoff its last value would keep being offered hours into the forecast.
    const endsEarly = grid(4); // 0..45 min

    expect(nearestIndexByTime(endsEarly, 50 * MINUTE)).toBe(3);
    expect(nearestIndexByTime(endsEarly, 5 * HOUR)).toBe(-1);
  });

  it("skips gaps rather than selecting them", () => {
    const times = [0, null, 30 * MINUTE, undefined, 60 * MINUTE];

    expect(nearestIndexByTime(times, 30 * MINUTE)).toBe(2);
    expect(nearestIndexByTime(times, 58 * MINUTE)).toBe(4);
  });

  it("returns -1 for an empty series", () => {
    expect(nearestIndexByTime([], 0)).toBe(-1);
    expect(nearestIndexByTime([null, null], 0)).toBe(-1);
  });

  it("prefers the earlier reading when two are equidistant", () => {
    const times = [0, 30 * MINUTE];

    expect(nearestIndexByTime(times, 15 * MINUTE)).toBe(0);
  });
});
