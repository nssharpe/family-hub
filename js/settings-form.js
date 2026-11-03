// Pure helpers for the grown-ups' settings form. No DOM, no storage, no network, so `npm test`
// can load it. The form works in strings (what the inputs hold); these turn them into HubSettings.

import { APPS, APP_NAMES, DEFAULT_SETTINGS, guaranteedShares, localDayKey } from "./balance.js";

// SHA-256 of the parents' password (the same one the AMC 8 Quest PARENT_HASH uses). It is a soft
// gate that keeps kids out of the settings, not real security: the hub code is the real secret.
export const PARENT_HASH = "3ea107e103aeecaceda90cd5d28027d44617058c00bd1b27289ec4d341302ff3";

export const HUB_SITE = "https://nssharpe.github.io/family-hub/";
export const joinLink = code => `${HUB_SITE}#join=${code}`;

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export async function isParentPassword(text, hash = PARENT_HASH) {
  return (await sha256Hex(text)) === hash;
}

// ---------- strings to numbers ----------

// "30", " 30 ", "30%" -> 30; "0.2" -> 0.2. Anything else -> NaN, which validateSettings then rejects with a
// message instead of saving something odd: "abc", "1e3", "0x10", a half-typed "3e", and blank (a blank box is
// not a 0; it used to silently turn an app off).
export function parseNum(v) {
  if (typeof v === "number") return v;
  const s = String(v == null ? "" : v).trim().replace(/%$/, "").trim();
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}

// What a number input holds, as text. A type=number box with half-typed text ("3e") reports value "" while
// validity.badInput is true; that must not read as blank, so it becomes text parseNum rejects.
export const BAD_NUMBER_TEXT = "(not a number)";
export function inputText(el) {
  return el && el.validity && el.validity.badInput ? BAD_NUMBER_TEXT : el.value;
}

const RATE_KEYS = ["amcBase", "amcPerNum", "amc10Mult", "frenchCardsPerTicket", "typingCharsPerTicket", "typingMasteredFactor", "spellingWordsPerTicket"];

// formValues = {
//   kids:   { [kidId]: { ranges: { [app]: { min: "10", max: "30%" } } } },
//   rates:  { amcBase: "1", ... },
//   baseline: "150",
//   ladder: [{ tickets: "15", minutes: "30" }, ...],
// }
// `current` supplies everything the form doesn't edit (v, kid names, kids missing from the form).
// Returns a new HubSettings with pending: null (withPendingChange stores it as the pending change).
export function formToSettings(formValues, current) {
  const out = JSON.parse(JSON.stringify(current));
  out.pending = null;
  const fv = formValues || {};
  for (const [id, kidForm] of Object.entries(fv.kids || {})) {
    const kid = out.kids[id];
    if (!kid || !kidForm || !kidForm.ranges) continue;
    for (const app of APPS) {
      const r = kidForm.ranges[app];
      if (r) kid.ranges[app] = [parseNum(r.min), parseNum(r.max)];
    }
  }
  if (fv.rates) for (const k of RATE_KEYS) if (k in fv.rates) out.rates[k] = parseNum(fv.rates[k]);
  if ("baseline" in fv) out.baseline = parseNum(fv.baseline);
  if (Array.isArray(fv.ladder)) out.ladder = fv.ladder.map(row => [parseNum(row.tickets), parseNum(row.minutes)]);
  return out;
}

// The reverse: settings -> the strings the form inputs start with.
export function settingsToForm(s) {
  const kids = {};
  for (const [id, kid] of Object.entries(s.kids)) {
    const ranges = {};
    for (const app of APPS) {
      const r = (kid.ranges && kid.ranges[app]) || [0, 0];
      ranges[app] = { min: String(r[0]), max: String(r[1]) };
    }
    kids[id] = { ranges };
  }
  const rates = {};
  for (const k of RATE_KEYS) rates[k] = String(s.rates[k]);
  return { kids, rates, baseline: String(s.baseline), ladder: s.ladder.map(([t, m]) => ({ tickets: String(t), minutes: String(m) })) };
}

// Guaranteed share and warning per app for one kid's form ranges ({ [app]: { min, max } } of strings).
// Half-typed or blank values count as 0 here, so the preview never shows NaN; Save still validates properly.
export function kidGuarantees(rangesForm) {
  const ranges = {};
  for (const app of APPS) {
    const r = (rangesForm && rangesForm[app]) || {};
    const num = v => { const n = parseNum(v); return Number.isFinite(n) ? n : 0; };
    ranges[app] = [num(r.min), num(r.max)];
  }
  return guaranteedShares(ranges);
}

// ---------- creating and joining a hub ----------

// The settings a brand-new hub starts with. `startedAt` (ms) is when the hub began: ticket history from before
// it never counts (R20), so the weeks of AMC answers already in the Sheet can't fill a cap on day one.
export function newHubSettings(now = Date.now()) {
  return { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), startedAt: now };
}

export const CONFIRM_CREATE_HUB = "Already have a hub on another device? Open its join link here instead. Create a new hub anyway?";

// ---------- pending change ----------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// 'YYYY-MM-DD' -> "Wed 4 Nov" (fixed English wording, independent of the browser's locale).
export function dayLabel(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!m) return String(key);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

// The change still waiting for its midnight, as { effectiveFrom, text }, or null. A pending change whose
// day has already started is in force (effectiveSettings applies it), so there is nothing to announce.
export function pendingInfo(doc, now) {
  const p = doc && doc.pending;
  if (!p || !p.settings || typeof p.effectiveFrom !== "string") return null;
  if (p.effectiveFrom <= localDayKey(now)) return null;
  const d = new Date(now);
  const tomorrow = localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime());
  const label = dayLabel(p.effectiveFrom);
  return { effectiveFrom: p.effectiveFrom, text: p.effectiveFrom === tomorrow ? `Changes take effect tomorrow (${label})` : `Changes take effect on ${label}` };
}

// ---------- plain-language summary, so effective and pending values can be compared ----------

const num = n => String(Math.round(n * 1000) / 1000);

export function summarizeSettings(s) {
  const lines = [];
  for (const kid of Object.values(s.kids)) {
    lines.push([kid.name, APPS.map(a => `${APP_NAMES[a]} ${kid.ranges[a][0]}–${kid.ranges[a][1]}%`).join(", ")]);
  }
  const r = s.rates;
  lines.push(["AMC", `${num(r.amcBase)} + ${num(r.amcPerNum)} per problem number, AMC 10 ×${num(r.amc10Mult)}`]);
  lines.push(["French", `1 ticket per ${num(r.frenchCardsPerTicket)} cards`]);
  lines.push(["Typing", `1 ticket per ${num(r.typingCharsPerTicket)} correct characters, ×${num(r.typingMasteredFactor)} for replays`]);
  lines.push(["Spelling", `1 ticket per ${num(r.spellingWordsPerTicket)} first-try words`]);
  lines.push(["Baseline week", `${s.baseline} tickets`]);
  lines.push(["Ladder", s.ladder.map(([t, m]) => `${t} → ${m} min`).join(", ") + " (last row repeats)"]);
  return lines;
}
