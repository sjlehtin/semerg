/**
 * The price and production chart.
 *
 * Colours come from the stylesheet rather than being hardcoded here, so that
 * the canvas follows the page's light/dark theme from one source of truth.
 */
import {
  Chart,
  Filler,
  Interaction,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  TimeSeriesScale,
  Title,
  Tooltip,
} from "chart.js";
import { getRelativePosition } from "chart.js/helpers";
import "chartjs-adapter-luxon";
import annotationPlugin from "chartjs-plugin-annotation";
import { DateTime } from "luxon";

import { adjustSeries, ZONE } from "./tariff.js";

/**
 * Do not show a series a reading from further away than this. Without it, a
 * series that stops early -- Fingrid's actual wind production always does,
 * since it is measurement rather than forecast -- would keep offering its last
 * value hours later, as though it were current.
 */
const MAX_GAP_MS = 60 * 60 * 1000;

/**
 * Index of the reading closest to `hoveredTime`, or -1 if the closest is
 * further away than `maxGapMs`. Nulls are gaps and are skipped.
 *
 * Split out from the interaction mode below so the selection rule can be tested
 * without standing up a chart, a canvas and a pointer event.
 */
export function nearestIndexByTime(times, hoveredTime, maxGapMs = MAX_GAP_MS) {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < times.length; index += 1) {
    if (times[index] === null || times[index] === undefined) continue;
    const distance = Math.abs(times[index] - hoveredTime);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }

  return bestDistance <= maxGapMs ? best : -1;
}

/**
 * Pick, for each series, the point nearest the cursor IN TIME.
 *
 * Chart.js's built-in "index" mode cannot do this. It finds the nearest
 * element, takes its array *index*, and then reads that same index out of every
 * dataset -- so it aligns by position in the array rather than by time. That
 * only works if every series shares an identical timestamp list. Ours do not:
 * Entso-E omits repeated prices, so basePrices carries gaps that the evenly
 * sampled Fingrid series do not, and each gap slides the price series another
 * step ahead of the rest. The visible effect is a tooltip whose readings drift
 * apart as you move right.
 */
Interaction.modes.nearestByTime = function (chart, event, options, useFinalPosition) {
  const position = getRelativePosition(event, chart);
  const scale = chart.scales.x;
  const hoveredTime = scale.getValueForPixel(position.x);
  const items = [];

  for (const meta of chart.getSortedVisibleDatasetMetas()) {
    const times = meta.data.map((element) =>
      element.skip
        ? null
        : scale.getValueForPixel(element.getProps(["x"], useFinalPosition).x));

    const index = nearestIndexByTime(times, hoveredTime);
    if (index !== -1) {
      items.push({ element: meta.data[index], datasetIndex: meta.index, index });
    }
  }

  return items;
};

Chart.register(
  LinearScale,
  LineElement,
  LineController,
  TimeSeriesScale,
  PointElement,
  Filler,
  Tooltip,
  Legend,
  Title,
  annotationPlugin,
);

function theme() {
  const style = getComputedStyle(document.documentElement);
  const read = (name) => style.getPropertyValue(name).trim();
  return {
    grid: read("--chart-grid"),
    axis: read("--chart-axis"),
    basePrice: read("--series-base-price"),
    actualPrice: read("--series-actual-price"),
    wind: read("--series-wind"),
    windForecast: read("--series-wind-forecast"),
    solar: read("--series-solar"),
    nowLine: read("--now-line"),
    windowFill: read("--window-fill"),
    windowBorder: read("--window-border"),
  };
}

/** Chart.js needs `data: []`, not `undefined`, when Fingrid was unavailable. */
const optional = (series) => series ?? [];

function datasets(data, colours) {
  const price = { xAxisKey: "startTime", yAxisKey: "price" };
  const energy = { xAxisKey: "startTime", yAxisKey: "energy" };

  return [
    {
      label: "Spot price",
      data: optional(data.basePrices),
      borderColor: colours.basePrice,
      parsing: price,
      yAxisID: "y",
      borderWidth: 1.5,
      pointRadius: 0,
      borderDash: [4, 3],
    },
    {
      label: "Your price",
      data: adjustSeries(optional(data.basePrices)),
      borderColor: colours.actualPrice,
      parsing: price,
      yAxisID: "y",
      borderWidth: 2.5,
      pointRadius: 0,
    },
    {
      label: "Wind production",
      data: optional(data.windProduction),
      borderColor: colours.wind,
      parsing: energy,
      yAxisID: "y1",
      borderWidth: 1.5,
      pointRadius: 0,
    },
    {
      label: "Wind forecast",
      data: optional(data.windProductionForecast),
      borderColor: colours.windForecast,
      parsing: energy,
      yAxisID: "y1",
      borderWidth: 1.5,
      pointRadius: 0,
      borderDash: [2, 3],
    },
    {
      label: "Solar forecast",
      data: optional(data.solarProductionForecast),
      borderColor: colours.solar,
      parsing: energy,
      yAxisID: "y1",
      borderWidth: 1.5,
      pointRadius: 0,
      borderDash: [2, 3],
    },
  ];
}

function nowAnnotation(colours) {
  const now = new Date().toISOString();
  return {
    type: "line",
    xMin: now,
    xMax: now,
    borderColor: colours.nowLine,
    borderWidth: 2,
    label: {
      display: true,
      content: DateTime.now().setZone(ZONE).toFormat("HH:mm"),
      position: "start",
      backgroundColor: colours.nowLine,
      font: { size: 11, weight: "bold" },
    },
  };
}

function windowAnnotation(window, colours) {
  return {
    type: "box",
    xMin: window.start.toISO(),
    xMax: window.end.toISO(),
    backgroundColor: colours.windowFill,
    borderColor: colours.windowBorder,
    borderWidth: 1,
    drawTime: "beforeDatasetsDraw",
    label: {
      display: true,
      content: window.label,
      position: { x: "center", y: "start" },
      color: colours.windowBorder,
      font: { size: 11, weight: "bold" },
      backgroundColor: "transparent",
    },
  };
}

export function createChart(canvas, data) {
  const colours = theme();
  let chart;

  chart = new Chart(canvas, {
    type: "line",
    options: {
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearestByTime", intersect: false },
      scales: {
        y: {
          type: "linear",
          position: "left",
          title: { display: true, text: "c/kWh", color: colours.axis },
          ticks: { color: colours.axis },
          grid: { color: colours.grid },
          border: { color: colours.grid },
        },
        y1: {
          type: "linear",
          position: "right",
          title: { display: true, text: "MW", color: colours.axis },
          ticks: { color: colours.axis },
          grid: { drawOnChartArea: false },
          border: { color: colours.grid },
        },
        x: {
          // A real time scale rather than `timeseries`: the parser guarantees
          // an evenly spaced grid, so ticks should fall on clock hours instead
          // of on data points. The series is 15-minute, so one tick per point
          // would be unreadable.
          type: "time",
          time: { unit: "hour", stepSize: 3 },
          ticks: {
            color: colours.axis,
            maxRotation: 0,
            autoSkip: true,
            // Show the date when a tick crosses midnight, the time otherwise.
            callback(value) {
              const at = DateTime.fromMillis(value).setZone(ZONE);
              return at.hour === 0
                ? at.toFormat("ccc d LLL")
                : at.toFormat("HH:mm");
            },
          },
          grid: { color: colours.grid },
          border: { color: colours.grid },
        },
      },
      plugins: {
        legend: { labels: { color: colours.axis, boxHeight: 2, usePointStyle: false } },
        tooltip: {
          callbacks: {
            title: (items) =>
              DateTime.fromMillis(items[0].parsed.x)
                .setZone(ZONE)
                .toFormat("ccc d LLL, HH:mm"),
          },
        },
        annotation: { annotations: { now: nowAnnotation(colours) } },
      },
    },
    data: { datasets: datasets(data, colours) },
  });

  return {
    chart,

    /** Swap in fresh data without rebuilding the chart, so the view is kept. */
    update(newData) {
      chart.data.datasets = datasets(newData, theme());
      chart.options.plugins.annotation.annotations.now = nowAnnotation(theme());
      chart.update();
    },

    /** Highlight a scheduling window, or clear it when passed null. */
    highlight(window) {
      const annotations = chart.options.plugins.annotation.annotations;
      if (window) {
        annotations.window = windowAnnotation(window, theme());
      } else {
        delete annotations.window;
      }
      chart.update();
    },

    /** Re-read the palette after a light/dark switch. */
    retheme(currentData) {
      this.update(currentData);
    },
  };
}
