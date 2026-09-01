import { DateTime } from "luxon";

import { createChart } from "./chart.js";
import { recommend, toSlots } from "./schedule.js";
import { sourceStatus } from "./status.js";
import { durationOf, loadSettings, saveSettings, tasks } from "./tasks.js";
import { supplier, transmission, VAT_RATE, ZONE } from "./tariff.js";

/**
 * How often to pull fresh data.
 *
 * The page never reloads itself, so that a reader keeps their scroll position
 * and any highlighted window. Everything time-dependent, including the "now"
 * marker, is updated on this interval instead.
 */
const REFRESH_MS = 5 * 60 * 1000;

const el = (id) => document.getElementById(id);

const euro = (value) =>
  value.toLocaleString(undefined, { style: "currency", currency: "EUR" });

let view = null;
let latest = null;
let settings = loadSettings();
let selected = null;
let statusOpen = false;

async function fetchData() {
  // Absolute path: a relative one resolves against the document path and
  // breaks anywhere the page is not served from the root.
  const response = await fetch("/data.json");
  if (!response.ok) {
    throw new Error(`Could not load price data (HTTP ${response.status}).`);
  }
  return response.json();
}

function showError(message) {
  const box = el("error");
  box.textContent = message;
  box.hidden = !message;
}

function renderHeader(data) {
  const fetched = DateTime.fromISO(data.fetchTime).setZone(ZONE);
  el("updated").textContent = `Updated ${fetched.toFormat("ccc d LLL, HH:mm")}`;

  const prices = data.basePrices ?? [];
  const now = DateTime.now().setZone(ZONE);
  const last = prices.length
    ? DateTime.fromISO(prices.at(-1).startTime).setZone(ZONE)
    : null;

  if (!last) {
    el("coverage").textContent = "Prices unavailable";
  } else if (last < now) {
    // Prices that stop in the past are not a normal morning, so do not offer
    // the usual reassurance about tomorrow's publication.
    el("coverage").textContent =
      `Prices ran out ${last.toFormat("ccc d LLL, HH:mm")}`;
  } else {
    el("coverage").textContent =
      last > now.endOf("day")
        ? `Prices through ${last.toFormat("cccc HH:mm")}`
        : `Prices through ${last.toFormat("HH:mm")} — tomorrow's are published around 14:00`;
  }
}

/**
 * The warning by the chart, and the reasons behind it.
 *
 * Built as nodes rather than markup: the reasons include an upstream error
 * message, which is not ours to trust with innerHTML.
 */
function renderStatus(data) {
  const status = sourceStatus(data);
  el("source-status").hidden = !status;
  if (!status) {
    statusOpen = false;
    return;
  }

  el("source-status-summary").textContent = status.summary;

  const details = el("source-status-details");
  details.replaceChildren(
    ...status.items.map((item) => {
      const node = document.createElement("div");

      const title = document.createElement("p");
      title.className = "font-medium";
      title.style.color = "var(--text)";
      title.textContent = item.title;
      node.append(title);

      for (const line of item.lines) {
        const paragraph = document.createElement("p");
        paragraph.textContent = line;
        node.append(paragraph);
      }

      return node;
    }),
  );

  details.hidden = !statusOpen;
  el("source-status-toggle").setAttribute("aria-expanded", String(statusOpen));
  el("source-status-hint").textContent = statusOpen ? "Hide" : "Why?";
}

function renderTariffNote() {
  const day = (transmission.dayRate * (1 + VAT_RATE)).toFixed(2);
  const night = (transmission.nightRate * (1 + VAT_RATE)).toFixed(2);
  const margin = (supplier.margin * (1 + VAT_RATE)).toFixed(2);
  el("tariff-note").textContent =
    `"Your price" is spot plus ${margin} c/kWh supplier margin, electricity tax ` +
    `and security-of-supply fee, and ${transmission.label} transfer ` +
    `(${day} c/kWh ${transmission.dayStartHour}:00–${transmission.dayEndHour}:00, ` +
    `${night} c/kWh otherwise), including VAT ${(VAT_RATE * 100).toFixed(1)} %.`;
}

function card(result) {
  const { task, window } = result;
  const node = document.createElement("article");
  node.className = "card p-4 flex flex-col gap-3";

  const control =
    task.input === "energy"
      ? `<label class="flex items-center gap-2 text-sm">
           <input type="number" min="1" max="100" step="1" data-field="energyKwh"
                  value="${settings[task.id]?.energyKwh ?? task.defaultEnergyKwh}"
                  class="w-16 rounded border px-2 py-1 tabular-nums"
                  style="border-color: var(--border); background: var(--surface-sunken); color: var(--text)" />
           <span style="color: var(--text-muted)">kWh at ${task.powerKw} kW</span>
         </label>`
      : `<label class="flex items-center gap-2 text-sm">
           <input type="number" min="15" max="600" step="15" data-field="durationMinutes"
                  value="${settings[task.id]?.durationMinutes ?? task.defaultDurationMinutes}"
                  class="w-16 rounded border px-2 py-1 tabular-nums"
                  style="border-color: var(--border); background: var(--surface-sunken); color: var(--text)" />
           <span style="color: var(--text-muted)">min at ${task.powerKw} kW</span>
         </label>`;

  let body;
  if (!window) {
    body = `<p class="text-sm" style="color: var(--text-muted)">
              Not enough price data yet to place a run this long.
            </p>`;
  } else {
    const start = window.start.setZone(ZONE);
    const today = DateTime.now().setZone(ZONE).hasSame(start, "day");
    const when = today ? start.toFormat("HH:mm") : start.toFormat("ccc HH:mm");
    const saving =
      result.startingNow || result.saving === null
        ? `<span style="color: var(--text-muted)">cheapest right now</span>`
        : `saves ${euro(result.saving)} vs. now`;

    body = `<div>
              <p class="text-2xl font-semibold tabular-nums">${when}</p>
              <p class="mt-1 text-sm tabular-nums" style="color: var(--text-muted)">
                ${euro(window.cost)} · ${window.averagePrice.toFixed(1)} c/kWh avg
              </p>
              <p class="mt-1 text-sm">${saving}</p>
            </div>`;
  }

  node.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <h3 class="font-medium"><span aria-hidden="true">${task.icon}</span> ${task.label}</h3>
    </div>
    ${body}
    ${control}`;

  if (window) {
    node.classList.add("cursor-pointer");
    node.addEventListener("click", (event) => {
      if (event.target.tagName === "INPUT") return;
      selected = selected === task.id ? null : task.id;
      renderTasks();
    });
  }

  node.querySelector("input")?.addEventListener("change", (event) => {
    const field = event.target.dataset.field;
    const value = Number(event.target.value);
    if (!Number.isFinite(value) || value <= 0) return;
    settings = {
      ...settings,
      [task.id]: { ...settings[task.id], [field]: value },
    };
    saveSettings(settings);
    renderTasks();
  });

  if (selected === task.id) {
    node.style.outline = `2px solid var(--window-border)`;
    node.style.outlineOffset = "1px";
  }

  return node;
}

function renderTasks() {
  if (!latest) return;
  const { slots, resolution } = toSlots(latest);
  const now = DateTime.now();

  const container = el("tasks");
  container.replaceChildren();

  let highlight = null;
  for (const task of tasks) {
    const result = recommend({
      slots,
      resolution,
      task,
      durationMinutes: durationOf(task, settings[task.id]),
      now,
    });
    container.append(card(result));
    if (selected === task.id && result.window) {
      highlight = { ...result.window, label: task.label };
    }
  }

  el("clear-highlight").hidden = !highlight;
  view?.highlight(highlight);
}

async function refresh() {
  try {
    latest = await fetchData();
    renderHeader(latest);
    renderStatus(latest);
    if (view) {
      view.update(latest);
    } else {
      view = createChart(el("energy"), latest);
    }
    renderTasks();
  } catch (error) {
    showError(`${error.message} Showing the last data loaded.`);
  }
}

function start() {
  renderTariffNote();

  el("clear-highlight").addEventListener("click", () => {
    selected = null;
    renderTasks();
  });

  el("source-status-toggle").addEventListener("click", () => {
    statusOpen = !statusOpen;
    if (latest) renderStatus(latest);
  });

  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (latest) view?.retheme(latest);
      renderTasks();
    });

  refresh();
  setInterval(refresh, REFRESH_MS);
}

start();
