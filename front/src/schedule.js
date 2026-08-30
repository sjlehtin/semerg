/**
 * When should you run the dishwasher?
 *
 * The parser hands us a uniform grid, so this is a plain sliding minimum: score
 * every run of consecutive slots long enough to cover the task and keep the
 * cheapest. Contiguity is still checked against the timestamps rather than
 * assumed, because a gap would silently make a window cheaper than it is.
 */
import { DateTime } from "luxon";

import { priceFor } from "./tariff.js";

const DEFAULT_RESOLUTION_MINUTES = 15;

/**
 * Turn raw price points into priced slots.
 *
 * `resolutionMinutes` is optional and defaults when absent. Assets are
 * immutable, so an old bundle may be paired with new data and vice versa;
 * neither side may assume the other's version.
 */
export function toSlots(data) {
  const resolution = data.priceResolutionMinutes ?? DEFAULT_RESOLUTION_MINUTES;
  return {
    resolution,
    slots: (data.basePrices ?? []).map((point) => {
      const start = DateTime.fromISO(point.startTime);
      return { start, price: priceFor(point.price, start) };
    }),
  };
}

function isContiguous(slots, from, count, resolution) {
  for (let i = from; i < from + count - 1; i += 1) {
    const gap = slots[i + 1].start.diff(slots[i].start, "minutes").minutes;
    if (Math.abs(gap - resolution) > 0.001) return false;
  }
  return true;
}

/**
 * Cost in euros of running `powerKw` for `durationMinutes` from slot `from`.
 *
 * The final slot is prorated. A task rarely divides evenly into the grid --
 * 30 kWh at 11 kW is 163.6 minutes, which occupies eleven 15-minute slots but
 * only uses ten and a bit. Charging for the whole eleventh would bill 30.25 kWh
 * for a 30 kWh charge, and make the quoted average price disagree with the
 * quoted total.
 */
function costOf(slots, from, count, resolution, powerKw, durationMinutes) {
  let remaining = durationMinutes;
  let total = 0;
  for (let i = from; i < from + count; i += 1) {
    const minutes = Math.min(resolution, remaining);
    total += slots[i].price * powerKw * (minutes / 60);
    remaining -= minutes;
  }
  return total / 100;
}

/** Energy a task consumes, in kWh. */
export function energyOf(powerKw, durationMinutes) {
  return powerKw * (durationMinutes / 60);
}

/**
 * The cheapest place to put a run of `durationMinutes`, at or after `fromTime`.
 *
 * Returns null when the remaining prices do not cover the task -- better to say
 * "not enough data yet" than to recommend a window that gets cut short.
 */
export function findCheapestWindow({
  slots,
  resolution,
  durationMinutes,
  powerKw,
  fromTime,
}) {
  const count = Math.ceil(durationMinutes / resolution);
  if (count < 1) return null;

  const startIndex = slots.findIndex(
    (slot) => slot.start.plus({ minutes: resolution }) > fromTime,
  );
  if (startIndex === -1) return null;

  let best = null;
  for (let i = startIndex; i + count <= slots.length; i += 1) {
    if (!isContiguous(slots, i, count, resolution)) continue;
    const cost = costOf(slots, i, count, resolution, powerKw, durationMinutes);
    if (best === null || cost < best.cost) {
      best = {
        cost,
        start: slots[i].start,
        // The finish time, not the end of the last slot occupied.
        end: slots[i].start.plus({ minutes: durationMinutes }),
        averagePrice: (cost * 100) / energyOf(powerKw, durationMinutes),
      };
    }
  }
  return best;
}

/**
 * What the same task would cost started right now.
 *
 * This is the number that makes the recommendation worth acting on: a cheapest
 * window means little without knowing what waiting actually saves.
 */
export function costIfStartedNow({
  slots,
  resolution,
  durationMinutes,
  powerKw,
  fromTime,
}) {
  const count = Math.ceil(durationMinutes / resolution);
  const index = slots.findIndex(
    (slot) => slot.start.plus({ minutes: resolution }) > fromTime,
  );
  if (index === -1 || index + count > slots.length) return null;
  if (!isContiguous(slots, index, count, resolution)) return null;
  return costOf(slots, index, count, resolution, powerKw, durationMinutes);
}

/** Everything a task card needs to render. */
export function recommend({ slots, resolution, task, durationMinutes, now }) {
  const query = {
    slots,
    resolution,
    durationMinutes,
    powerKw: task.powerKw,
    fromTime: now,
  };
  const cheapest = findCheapestWindow(query);
  if (!cheapest) return { task, durationMinutes, window: null };

  const nowCost = costIfStartedNow(query);
  return {
    task,
    durationMinutes,
    window: cheapest,
    energyKwh: energyOf(task.powerKw, durationMinutes),
    costNow: nowCost,
    saving: nowCost === null ? null : nowCost - cheapest.cost,
    startingNow: nowCost !== null && Math.abs(nowCost - cheapest.cost) < 0.005,
  };
}
