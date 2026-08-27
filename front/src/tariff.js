/**
 * What a kilowatt-hour actually costs.
 *
 * The spot price is only part of a Finnish electricity bill. Three separate
 * parties add to it, and they are chosen independently: the state sets tax and
 * VAT, the retailer sets a margin on spot, and the local grid operator sets the
 * transfer fee. They are modelled separately here so that supporting a second
 * contract later means adding data, not rewriting arithmetic.
 *
 * Every rate is stored EXCLUDING VAT, which is then applied once. Storing
 * VAT-inclusive figures is what caused this to be wrong for over a year: when
 * VAT went 24% -> 25.5% in September 2024 only the spot multiplier was updated,
 * and the four baked-in constants silently kept the old rate.
 *
 * Where a source publishes an inclusive figure, derive it with `exVat()` rather
 * than dividing by hand, so the published number stays visible in the code and
 * the VAT rate it was quoted at is pinned alongside it.
 */
import { DateTime } from "luxon";

/** Finnish electricity tariffs are Finnish. Never use the browser's zone. */
export const ZONE = "Europe/Helsinki";

export const VAT_RATE = 0.255;

/**
 * Convert a VAT-inclusive published figure to its ex-VAT basis.
 *
 * `quotedVatRate` is the rate the figure was published at, which is not
 * necessarily the current one: if VAT changes, a supplier's ex-VAT rate stays
 * put and their inclusive price moves. Pinning the quoted rate keeps the
 * derivation correct across a VAT change.
 */
export function exVat(value, quotedVatRate) {
  return value / (1 + quotedVatRate);
}

/** Set by the state; the same for everyone. Rates ex-VAT, c/kWh. */
export const national = {
  // NOTE: the four rates below are the values currently in production,
  // back-derived from the inclusive figures the old code carried, so that this
  // restructure provably changes no output. Several of them are wrong -- see
  // the comments -- and are corrected in the very next commit, on its own, so
  // that the change in what this tool reports is visible in review rather than
  // buried in a refactor.

  // sähkövero veroluokka I. 2.7776 = 2.24 x 1.24: this still carries the OLD
  // 24% VAT rate, never re-derived when VAT rose to 25.5% in September 2024.
  electricityTax: exVat(2.7776, 0.255),
  // Huoltovarmuusmaksu. 0.01612 = 0.013 x 1.24, so likewise stuck at 24% VAT --
  // and the underlying rate itself rose to 0.085 on 2026-04-01.
  securityOfSupply: exVat(0.01612, 0.255),
  /**
   * Whether VAT applies to a negative spot price.
   *
   * When spot goes negative the customer is credited, and crediting VAT on top
   * would mean being paid more than the market moved. The current contract is
   * modelled as not doing that.
   */
  vatOnNegativeSpot: false,
};

/** The retailer. Rates ex-VAT, c/kWh. */
export const supplier = {
  id: "vattenfall-spot",
  label: "Vattenfall (spot)",
  // Quoted as 0.50 c/kWh including 25.5% VAT. Confirmed correct.
  margin: exVat(0.5, 0.255),
};

/**
 * The distribution network operator.
 *
 * `rateAt` is a function rather than a pair of numbers because transfer
 * products are where the time dependence lives: flat, day/night, and seasonal
 * products all exist. A new product kind slots in here without touching callers.
 */
export const transmission = {
  id: "vantaa-aikasiirto",
  label: "Vantaan Energia Sähköverkot — Aikasiirto",
  // "Aikasiirron päivähinta on voimassa kaikkina viikonpäivinä klo 7-22, muina
  // aikoina on voimassa yöhinta." -- all days of the week, so no weekend case.
  dayStartHour: 7,
  dayEndHour: 22,
  // Production values, back-derived as above. The current price list gives
  // 2.63 and 1.13 ex-VAT (3.30 / 1.42 inclusive).
  dayRate: exVat(3.2, 0.255),
  nightRate: exVat(1.4, 0.255),

  rateAt(dateTime) {
    const hour = dateTime.setZone(ZONE).hour;
    return hour >= this.dayStartHour && hour < this.dayEndHour
      ? this.dayRate
      : this.nightRate;
  },
};

/**
 * The price of one kWh consumed at `isoTime`, in c/kWh, all in.
 *
 * `basePrice` is the raw spot price from the data feed, also c/kWh, exclusive
 * of everything.
 */
export function priceFor(basePrice, isoTime) {
  const at = DateTime.isDateTime(isoTime)
    ? isoTime
    : DateTime.fromISO(isoTime, { zone: ZONE });

  const spot =
    basePrice < 0 && !national.vatOnNegativeSpot
      ? { taxed: 0, untaxed: basePrice }
      : { taxed: basePrice, untaxed: 0 };

  const beforeVat =
    spot.taxed +
    supplier.margin +
    national.electricityTax +
    national.securityOfSupply +
    transmission.rateAt(at);

  return beforeVat * (1 + VAT_RATE) + spot.untaxed;
}

/** Convenience for charting: map a whole series through `priceFor`. */
export function adjustSeries(points) {
  return points.map((point) => ({
    startTime: point.startTime,
    price: priceFor(point.price, point.startTime),
  }));
}
