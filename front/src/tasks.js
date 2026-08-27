/**
 * Household loads worth timing.
 *
 * Power figures are nominal averages over the run. Real appliances are not flat:
 * a dishwasher front-loads its heating element, a sauna stove duty-cycles once
 * it reaches temperature. Modelling that would need load curves per appliance
 * and would not change which window wins, so the page says so in a footnote
 * instead.
 *
 * Adding a task is one entry here.
 */
export const tasks = [
  {
    id: "dishwasher",
    label: "Dishwasher",
    icon: "🍽️",
    powerKw: 0.9,
    input: "duration",
    defaultDurationMinutes: 150,
  },
  {
    id: "washing-machine",
    label: "Washing machine",
    icon: "🧺",
    powerKw: 0.7,
    input: "duration",
    defaultDurationMinutes: 120,
  },
  {
    id: "sauna",
    label: "Sauna",
    icon: "🧖",
    powerKw: 6,
    input: "duration",
    defaultDurationMinutes: 90,
  },
  {
    id: "ev",
    label: "EV charging",
    icon: "🚗",
    powerKw: 11,
    // Asking "how many kWh do you want to add" is more natural than asking how
    // long to charge; the duration follows from the charge rate.
    input: "energy",
    defaultEnergyKwh: 30,
  },
];

/** How long a task runs, in minutes, given its current settings. */
export function durationOf(task, settings) {
  if (task.input === "energy") {
    const kwh = settings?.energyKwh ?? task.defaultEnergyKwh;
    return (kwh / task.powerKw) * 60;
  }
  return settings?.durationMinutes ?? task.defaultDurationMinutes;
}

const STORAGE_KEY = "semerg.taskSettings";

/**
 * Settings live in the browser and nowhere else. There are no accounts and no
 * server-side storage, by design.
 */
export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing, quota, or storage disabled. Not worth failing over.
  }
}
