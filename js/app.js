// Hub state: the joined hub code, the settings cache and the last tickets we saw, all under the
// single localStorage key `family-hub:v1` (GitHub Pages shares one origin between every app).
// No DOM at import time, so tests can load it.

import { DEFAULT_SETTINGS, effectiveSettings, amcTicketEvents, ticketsSince } from "./balance.js";
import { getHub, listTickets, isHubCode } from "./hub-client.js";
import { amcAnswers } from "./amc-sheet.js";
import { buildKidData } from "./view-model.js";

export const STORE_KEY = "family-hub:v1";

const fresh = () => ({ v: 1, hub: null, settingsDoc: null, cache: { hub: null, amc: {} } });
let state = null;

function load() {
  if (state) return state;
  state = fresh();
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.v === 1) {
      state.hub = isHubCode(s.hub) ? s.hub : null;
      state.settingsDoc = s.settingsDoc && s.settingsDoc.kids ? s.settingsDoc : null;
      if (s.cache && typeof s.cache === "object") state.cache = { hub: s.cache.hub || null, amc: s.cache.amc || {} };
    }
  } catch { /* first run, private mode or corrupt: start fresh */ }
  return state;
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* full or blocked: memory still works */ }
}

export const getHubCode = () => load().hub;

// Joins this device to a hub. Returns false (and changes nothing) for something that isn't a hub code.
export function joinHub(code) {
  if (!isHubCode(code)) return false;
  const s = load();
  if (s.hub !== code) { s.hub = code; s.settingsDoc = null; s.cache = { hub: null, amc: {} }; save(); }
  return true;
}

// The settings in force at `now`: the hub's (once fetched), else the defaults.
export function getSettings(now = Date.now()) {
  const doc = load().settingsDoc || DEFAULT_SETTINGS;
  return effectiveSettings(doc, now);
}

// Fetches the hub's settings into the cache (no-op without a hub). Never throws.
export async function refreshSettings() {
  const s = load();
  if (!s.hub) return false;
  try {
    const hub = await getHub(s.hub);
    if (hub && hub.settings && hub.settings.kids) { s.settingsDoc = hub.settings; save(); return true; }
  } catch { /* offline: keep the cached settings */ }
  return false;
}

const ok = r => r.status === "fulfilled";

// Everything the kid screen shows. Resolves to null if the kid isn't in the settings.
// Tickets come from the hub log (fetched from ticketsSince(now), so the hub and the extension
// count the same events) plus the kid's AMC answers from the Sheet. If a source can't be read,
// its last cached copy is used and `stale` is true (`staleAt` = when that copy was saved, if known).
export async function loadKidData(kidId, now = Date.now()) {
  const s = load();
  const [, hubR, amcR] = await Promise.all([
    refreshSettings(),
    Promise.allSettled([s.hub ? listTickets(s.hub, ticketsSince(now)) : Promise.resolve([])]).then(r => r[0]),
    Promise.allSettled([amcAnswers(kidId)]).then(r => r[0]),
  ]);

  let stale = false;
  const staleTimes = [];
  const useCache = (cached) => { stale = true; if (cached) staleTimes.push(cached.at); };

  let hubEvents;
  if (ok(hubR)) {
    hubEvents = hubR.value;
    if (s.hub) s.cache.hub = { events: hubEvents, at: now };
  } else {
    hubEvents = (s.cache.hub && s.cache.hub.events) || [];
    useCache(s.cache.hub);
  }
  let answers;
  if (ok(amcR)) {
    answers = amcR.value;
    s.cache.amc[kidId] = { answers, at: now };
  } else {
    const c = s.cache.amc[kidId];
    answers = (c && c.answers) || [];
    useCache(c);
  }
  save();

  const settings = getSettings(now);
  const kid = settings.kids[kidId];
  if (!kid) return null;
  const events = hubEvents.concat(amcTicketEvents(answers, kidId, settings.rates));
  const data = buildKidData(events, settings, kidId, now);
  return {
    ...data,
    kidName: kid.name,
    settings,
    hasHub: !!s.hub,
    stale,
    staleAt: stale && staleTimes.length ? Math.min(...staleTimes) : null,
    asOf: now,
  };
}
