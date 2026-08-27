import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";

import {
  costIfStartedNow,
  findCheapestWindow,
  recommend,
  toSlots,
} from "../src/schedule.js";
import { tasks, durationOf } from "../src/tasks.js";

const START = DateTime.fromISO("2025-12-01T00:00:00Z");

/** A price series from raw c/kWh spot values, on the 15-minute grid. */
function priceData(spotPrices, { resolution = 15 } = {}) {
  return {
    priceResolutionMinutes: resolution,
    basePrices: spotPrices.map((price, i) => ({
      startTime: START.plus({ minutes: i * resolution }).toISO(),
      price,
    })),
  };
}

/** Slots with prices we control directly, bypassing the tariff. */
function fixedSlots(prices, { resolution = 15, gapAt = null } = {}) {
  let cursor = START;
  const slots = [];
  prices.forEach((price, i) => {
    if (gapAt === i) cursor = cursor.plus({ minutes: resolution });
    slots.push({ start: cursor, price });
    cursor = cursor.plus({ minutes: resolution });
  });
  return { slots, resolution };
}

describe("toSlots", () => {
  it("prices each slot through the tariff", () => {
    const { slots } = toSlots(priceData([10, 20]));

    expect(slots).toHaveLength(2);
    // Whatever the tariff adds, it is strictly more than the raw spot price.
    expect(slots[0].price).toBeGreaterThan(10);
  });

  it("defaults the resolution for data written before the field existed", () => {
    const data = priceData([10, 20]);
    delete data.priceResolutionMinutes;

    expect(toSlots(data).resolution).toBe(15);
  });

  it("tolerates data with no prices at all", () => {
    expect(toSlots({}).slots).toEqual([]);
  });
});

describe("findCheapestWindow", () => {
  it("finds the cheapest run of slots", () => {
    const { slots, resolution } = fixedSlots([10, 10, 1, 1, 10, 10]);

    const best = findCheapestWindow({
      slots,
      resolution,
      durationMinutes: 30,
      powerKw: 1,
      fromTime: START,
    });

    expect(best.start.toISO()).toBe(START.plus({ minutes: 30 }).toISO());
    expect(best.end.toISO()).toBe(START.plus({ minutes: 60 }).toISO());
    // 1 c/kWh over 0.5 kWh
    expect(best.cost).toBeCloseTo(0.005, 6);
  });

  it("prorates the final partial slot", () => {
    // 20 minutes occupies two 15-minute slots but only uses five of the second.
    const { slots, resolution } = fixedSlots([10, 100, 100, 100]);

    const best = findCheapestWindow({
      slots,
      resolution,
      durationMinutes: 20,
      powerKw: 1,
      fromTime: START,
    });

    // Reports when the task finishes, not when its last slot ends.
    expect(best.end.diff(best.start, "minutes").minutes).toBe(20);
    // 15 min at 10 c/kWh + 5 min at 100 c/kWh, over 1 kW.
    expect(best.cost).toBeCloseTo((10 * 0.25 + 100 * (5 / 60)) / 100, 8);
    // The average must agree with cost divided by the energy actually used.
    expect(best.averagePrice).toBeCloseTo((best.cost * 100) / (20 / 60), 8);
  });

  it("quotes an average price consistent with the total and the energy", () => {
    // 30 kWh at 11 kW is 163.6 minutes: eleven slots, the last one partial.
    const { slots, resolution } = fixedSlots(Array(20).fill(12));

    const best = findCheapestWindow({
      slots,
      resolution,
      durationMinutes: (30 / 11) * 60,
      powerKw: 11,
      fromTime: START,
    });

    expect(best.cost).toBeCloseTo((30 * 12) / 100, 8);
    expect(best.averagePrice).toBeCloseTo(12, 8);
  });

  it("will not start a window in the past", () => {
    const { slots, resolution } = fixedSlots([1, 1, 9, 9]);
    const now = START.plus({ minutes: 30 });

    const best = findCheapestWindow({
      slots,
      resolution,
      durationMinutes: 30,
      powerKw: 1,
      fromTime: now,
    });

    expect(best.start >= now.minus({ minutes: resolution })).toBe(true);
    expect(best.start.toISO()).toBe(START.plus({ minutes: 30 }).toISO());
  });

  it("counts the slot currently in progress as available", () => {
    const { slots, resolution } = fixedSlots([1, 9, 9, 9]);
    // Five minutes into the first slot: you can still start the machine.
    const now = START.plus({ minutes: 5 });

    const best = findCheapestWindow({
      slots,
      resolution,
      durationMinutes: 15,
      powerKw: 1,
      fromTime: now,
    });

    expect(best.start.toISO()).toBe(START.toISO());
  });

  it("returns null when the horizon is shorter than the task", () => {
    const { slots, resolution } = fixedSlots([5, 5]);

    const best = findCheapestWindow({
      slots,
      resolution,
      durationMinutes: 240,
      powerKw: 1,
      fromTime: START,
    });

    expect(best).toBeNull();
  });

  it("refuses to span a gap in the series", () => {
    // Cheap slots either side of a missing one must not count as one window.
    const { slots, resolution } = fixedSlots([1, 1, 1], { gapAt: 2 });

    const best = findCheapestWindow({
      slots,
      resolution,
      durationMinutes: 45,
      powerKw: 1,
      fromTime: START,
    });

    expect(best).toBeNull();
  });

  it("scales cost with power and duration", () => {
    const { slots, resolution } = fixedSlots(Array(8).fill(10));
    const query = { slots, resolution, fromTime: START, durationMinutes: 60 };

    const oneKw = findCheapestWindow({ ...query, powerKw: 1 });
    const elevenKw = findCheapestWindow({ ...query, powerKw: 11 });

    // 1 kW for an hour at 10 c/kWh = 10 c
    expect(oneKw.cost).toBeCloseTo(0.1, 6);
    expect(elevenKw.cost).toBeCloseTo(1.1, 6);
    expect(oneKw.averagePrice).toBeCloseTo(10, 6);
  });

  it("spans the 07:00 transfer-fee boundary correctly", () => {
    // Flat spot price across the step: the tariff alone must make the night
    // slots cheaper, so the window is pulled to before 07:00 Helsinki.
    const overnight = DateTime.fromISO("2025-12-01T02:00", {
      zone: "Europe/Helsinki",
    });
    const data = {
      priceResolutionMinutes: 15,
      basePrices: Array.from({ length: 40 }, (_, i) => ({
        startTime: overnight.plus({ minutes: i * 15 }).toISO(),
        price: 5,
      })),
    };
    const { slots, resolution } = toSlots(data);

    const best = findCheapestWindow({
      slots,
      resolution,
      durationMinutes: 60,
      powerKw: 1,
      fromTime: overnight,
    });

    expect(best.end.setZone("Europe/Helsinki").hour).toBeLessThanOrEqual(7);
  });
});

describe("costIfStartedNow", () => {
  it("prices the window beginning at the current slot", () => {
    const { slots, resolution } = fixedSlots([20, 20, 1, 1]);

    const cost = costIfStartedNow({
      slots,
      resolution,
      durationMinutes: 30,
      powerKw: 1,
      fromTime: START,
    });

    expect(cost).toBeCloseTo(0.1, 6);
  });

  it("returns null when there is not enough left to finish", () => {
    const { slots, resolution } = fixedSlots([5, 5]);

    expect(
      costIfStartedNow({
        slots,
        resolution,
        durationMinutes: 120,
        powerKw: 1,
        fromTime: START,
      }),
    ).toBeNull();
  });
});

describe("recommend", () => {
  const task = { id: "t", label: "T", powerKw: 2, input: "duration" };

  it("reports the saving against starting now", () => {
    const { slots, resolution } = fixedSlots([20, 20, 1, 1]);

    const result = recommend({
      slots,
      resolution,
      task,
      durationMinutes: 30,
      now: START,
    });

    expect(result.window.cost).toBeCloseTo(0.01, 6);
    expect(result.costNow).toBeCloseTo(0.2, 6);
    expect(result.saving).toBeCloseTo(0.19, 6);
    expect(result.startingNow).toBe(false);
    expect(result.energyKwh).toBeCloseTo(1, 6);
  });

  it("says so when now is already the cheapest moment", () => {
    const { slots, resolution } = fixedSlots([1, 1, 20, 20]);

    const result = recommend({
      slots,
      resolution,
      task,
      durationMinutes: 30,
      now: START,
    });

    expect(result.startingNow).toBe(true);
    expect(result.saving).toBeCloseTo(0, 6);
  });

  it("reports no window rather than a truncated one", () => {
    const { slots, resolution } = fixedSlots([5, 5]);

    const result = recommend({
      slots,
      resolution,
      task,
      durationMinutes: 600,
      now: START,
    });

    expect(result.window).toBeNull();
  });
});

describe("task presets", () => {
  it("derives EV charging duration from the energy target", () => {
    const ev = tasks.find((t) => t.id === "ev");

    // 30 kWh at 11 kW
    expect(durationOf(ev, {})).toBeCloseTo((30 / 11) * 60, 6);
    expect(durationOf(ev, { energyKwh: 11 })).toBeCloseTo(60, 6);
  });

  it("uses the stored duration when one has been set", () => {
    const dishwasher = tasks.find((t) => t.id === "dishwasher");

    expect(durationOf(dishwasher, {})).toBe(150);
    expect(durationOf(dishwasher, { durationMinutes: 90 })).toBe(90);
  });
});
