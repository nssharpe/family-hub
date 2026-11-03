// SHARED FILE: this module is copied verbatim into amc8-quest/extension/src/lib/balance.js
// (the Streaming Lock extension). The two copies must stay byte-identical, so the hub and
// the lock always agree on which tickets count. Keep it pure: no imports, no DOM, no
// network, no Chrome APIs. All times are ms since epoch; day keys are local 'YYYY-MM-DD'.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export const APPS = ["amc", "french", "typing", "spelling"];
export const APP_NAMES = { amc: "AMC", french: "French", typing: "Typing", spelling: "Spelling" };

export const DEFAULT_SETTINGS = {
  v: 1,
  kids: {
    zyler: { name: "Zyler", ranges: { amc: [0, 30], french: [10, 30], typing: [25, 50], spelling: [25, 50] } },
    kadyn: { name: "Kadyn", ranges: { amc: [0, 100], french: [0, 100], typing: [0, 100], spelling: [0, 100] } },
  },
  rates: { amcBase: 1, amcPerNum: 0.2, amc10Mult: 1.5, frenchCardsPerTicket: 4, typingCharsPerTicket: 100, typingMasteredFactor: 0.5, spellingWordsPerTicket: 3 },
  baseline: 150,
  ladder: [[15, 30], [20, 25], [25, 20], [30, 15], [35, 10], [40, 5]],
  pending: null,
};

const clone = x => JSON.parse(JSON.stringify(x));

// ---------- days ----------

// Same as the extension's todayKey: the local day starts at midnight.
export function localDayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function tomorrowKey(now) {
  const d = new Date(now);
  return localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()); // DST-safe
}

// ---------- settings ----------

// The settings that apply at `now`: the pending ones once their day has started.
export function effectiveSettings(doc, now) {
  const p = doc && doc.pending;
  if (p && p.settings && typeof p.effectiveFrom === "string" && p.effectiveFrom <= localDayKey(now)) {
    return { ...clone(p.settings), pending: null };
  }
  return doc == null ? doc : clone(doc); // always a fresh copy
}

// Stores `newSettings` to take effect at the next local midnight. A pending change that has
// already taken effect is folded in first, so a second edit never undoes today's settings.
export function withPendingChange(doc, newSettings, now) {
  const base = clone(effectiveSettings(doc, now));
  const settings = clone(newSettings);
  settings.pending = null;
  return { ...base, pending: { effectiveFrom: tomorrowKey(now), settings } };
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isNum = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

export function validateSettings(s) {
  if (!s || typeof s !== "object") return "Settings are missing.";
  if (!s.kids || typeof s.kids !== "object" || Object.keys(s.kids).length < 1) return "There are no kids in the settings.";
  for (const [id, kid] of Object.entries(s.kids)) {
    if (!kid || typeof kid.name !== "string" || !kid.name.trim()) return `Kid "${id}" needs a name.`;
    if (!kid.ranges || typeof kid.ranges !== "object") return `${kid.name}: the app ranges are missing.`;
    for (const app of APPS) {
      const r = kid.ranges[app];
      const label = `${kid.name}, ${APP_NAMES[app]}: `;
      if (!Array.isArray(r) || r.length !== 2) return label + "needs a min and a max.";
      if (!isInt(r[0], 0, 100) || !isInt(r[1], 0, 100)) return label + "min and max must be whole numbers from 0 to 100.";
      if (r[0] > r[1]) return label + "the min can't be more than the max.";
    }
  }
  const r = s.rates;
  if (!r || typeof r !== "object") return "The ticket rates are missing.";
  if (!isNum(r.amcBase, 0, 1000) || !isNum(r.amcPerNum, 0, 1000)) return "AMC rates must be numbers of 0 or more.";
  if (!isNum(r.amc10Mult, 0, 100) || r.amc10Mult <= 0) return "The AMC 10 multiplier must be more than 0.";
  for (const k of ["frenchCardsPerTicket", "typingCharsPerTicket", "spellingWordsPerTicket"]) {
    // Whole numbers: the apps pay per N whole cards, characters or words.
    if (!isInt(r[k], 1, 1e6)) return "Each per-ticket rate must be a whole number of at least 1.";
  }
  if (!isNum(r.typingMasteredFactor, 0, 1)) return "The replay factor must be from 0 to 1.";
  if (!isInt(s.baseline, 1, 100000)) return "The baseline week must be a whole number of at least 1.";
  const L = s.ladder;
  if (!Array.isArray(L) || L.length < 1) return "The ladder needs at least one row.";
  if (L.length > 20) return "The ladder can have at most 20 rows.";
  for (let i = 0; i < L.length; i++) {
    const row = L[i];
    const label = "Ladder row " + (i + 1) + ": ";
    if (!Array.isArray(row) || row.length !== 2) return label + "needs tickets and minutes.";
    if (!isInt(row[0], 1, 1000)) return label + "tickets must be a whole number from 1 to 1000.";
    if (!isInt(row[1], 1, 240)) return label + "minutes must be a whole number from 1 to 240.";
  }
  return null;
}

// ---------- AMC tickets (derived from the Sheet's answers, never stored) ----------

export function amcTickets(answer, rates) {
  if (!answer || answer.ok !== true || !Number.isInteger(answer.n)) return 0;
  const y = String(answer.y);
  const mult = y.startsWith("10:") ? rates.amc10Mult : 1;
  return Math.round((rates.amcBase + rates.amcPerNum * answer.n) * mult);
}

export function amcTicketEvents(answers, kid, rates) {
  const out = [];
  for (const a of answers || []) {
    if (!a || a.ok !== true || typeof a.ts !== "number" || !Number.isFinite(a.ts)) continue;
    const tickets = amcTickets(a, rates);
    if (tickets < 1) continue;
    const y = String(a.y);
    const detail = (y.startsWith("10:") ? `AMC 10 ${y.slice(3)} #${a.n}` : `AMC 8 ${y} #${a.n}`).slice(0, 80);
    out.push({ id: `amc:${y}:${a.n}:${a.ts}`, kid, app: "amc", tickets, ts: a.ts, detail });
  }
  return out;
}

// ---------- weekly caps ----------

// Plain code-unit comparison: never localeCompare, whose order depends on the locale.
const cmpEvents = (a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const maxOf = (ranges, app) => {
  const r = ranges && ranges[app];
  return Array.isArray(r) && typeof r[1] === "number" ? r[1] : 0;
};

// Start of the ticket history countTickets uses: local midnight 14 days before today's day
// start. It is the same instant all day, so counted results only change at midnight (a moving
// now - 14d could take back tickets already spent on today's TV time). The hub and the
// extension both fetch the ticket log from this instant, so they feed identical inputs.
export function ticketsSince(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 14).getTime(); // DST-safe
}

// One kid's events in, the same events with `counted` out, sorted by (ts, id) and covering
// [ticketsSince(now), now]. Each event is judged against the trailing window (ts - 7d, ts],
// one ticket at a time: counted = the largest c in 0..tickets with
//   (this app's counted in window) + c <= max% x max(baseline, counted total in window + c)
// The older days are processed so the current 7-day window starts with sensible counts.
// Duplicate ids keep the first occurrence in (ts, id) order.
export function countTickets(events, ranges, baseline, now) {
  const from = ticketsSince(now);
  const list = (events || [])
    .filter(e => e && typeof e.id === "string" && typeof e.ts === "number" && e.ts >= from && e.ts <= now)
    .slice()
    .sort(cmpEvents);
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({ ...e, counted: 0 });
  }
  const base = typeof baseline === "number" && Number.isFinite(baseline) ? baseline : 0;
  const inWin = {}; // counted per app inside the sliding window
  let total = 0;
  let left = 0;
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    while (out[left].ts <= e.ts - WEEK_MS) {
      const old = out[left++];
      inWin[old.app] -= old.counted;
      total -= old.counted;
    }
    const tickets = Number.isInteger(e.tickets) && e.tickets > 0 ? e.tickets : 0;
    const mine = inWin[e.app] || 0;
    const max = Math.min(100, Math.max(0, maxOf(ranges, e.app)));
    // The event counts as if it were `tickets` single tickets: c tickets fit while
    // mine + c <= max% x max(baseline, total + c). Compared as 100 x (mine + c) <= max x X,
    // which is exact for whole numbers (no (max / 100) float). For max <= 100 the slack only
    // shrinks as c grows, so the tickets that fit are 0..c and a binary search finds c.
    const fits = c => 100 * (mine + c) <= max * Math.max(base, total + c);
    let lo = 0, hi = tickets; // invariant: lo fits (or lo is 0), everything above hi doesn't
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid; else hi = mid - 1;
    }
    e.counted = lo;
    inWin[e.app] = mine + e.counted;
    total += e.counted;
  }
  return out;
}

// Per-app counted tickets and share over the trailing 7 days (now - 7d, now].
export function weeklyMix(counted, ranges, now) {
  const per = {};
  let total = 0;
  for (const app of APPS) per[app] = 0;
  for (const e of counted || []) {
    if (e.ts <= now - WEEK_MS || e.ts > now || !(e.app in per)) continue;
    per[e.app] += e.counted;
    total += e.counted;
  }
  const out = {};
  for (const app of APPS) {
    const r = (ranges && ranges[app]) || [0, 0];
    const min = r[0], max = r[1];
    const c = per[app];
    let status;
    if (max === 0) status = "off";
    else if (total > 0 && c * 100 >= max * total) status = "max";
    else if (c * 100 < min * total || (total === 0 && min > 0)) status = "needs";
    else status = "ok";
    out[app] = { counted: c, share: total > 0 ? c / total : 0, min, max, status };
  }
  return out;
}

// Guaranteed share = 100 - sum of the other apps' maxes, clamped to 0..100.
export function guaranteedShares(ranges) {
  const out = {};
  for (const app of APPS) {
    const r = (ranges && ranges[app]) || [0, 0];
    const min = r[0];
    let others = 0;
    for (const o of APPS) if (o !== app) others += maxOf(ranges, o);
    const guaranteed = Math.min(100, Math.max(0, 100 - others));
    const warning = guaranteed < min
      ? `${APP_NAMES[app]} could still end up at ${guaranteed}%. The other apps' maxes add up to ${others}% — bring them down to ${100 - min}% or less to guarantee ${min}%.`
      : null;
    out[app] = { guaranteed, warning };
  }
  return out;
}

// ---------- daily ladder ----------

// Today's counted tickets (local day of `now`) spent on rungs in order; the last row repeats.
// `done` is the counted tickets already put toward the next rung; `needed` is its cost.
export function ladderStatus(ladder, counted, now) {
  const day = localDayKey(now);
  let ticketsToday = 0;
  for (const e of counted || []) if (e.ts <= now && localDayKey(e.ts) === day) ticketsToday += e.counted;
  let left = ticketsToday, unlocks = 0, earnedMinutes = 0;
  if (!Array.isArray(ladder) || ladder.length < 1) return { unlocks, earnedMinutes, nextIndex: 0, needed: 0, done: left, ticketsToday };
  const rung = k => ladder[Math.min(k, ladder.length - 1)];
  for (;;) {
    const [cost, minutes] = rung(unlocks);
    if (!(cost > 0) || left < cost) break;
    left -= cost;
    unlocks++;
    earnedMinutes += minutes;
  }
  return { unlocks, earnedMinutes, nextIndex: unlocks, needed: rung(unlocks)[0], done: left, ticketsToday };
}
