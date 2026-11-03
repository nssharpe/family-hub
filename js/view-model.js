// Pure helpers for the kid view: no DOM, no network, no storage (so `npm test` can import it).

import { APPS, APP_NAMES, countTickets, weeklyMix, ladderStatus } from "./balance.js";

// The four learning apps. `name` is what the kids read on the tile, `sub` the app's own title.
export const APP_INFO = {
  amc: { name: "AMC 8 Quest", sub: "Math contest problems", url: "https://nssharpe.github.io/amc8-quest/" },
  french: { name: "French", sub: "Les Cartes de Mamou", url: "https://nssharpe.github.io/mamou-french/" },
  typing: { name: "Typing", sub: "Turbo Keys", url: "https://nssharpe.github.io/turbo-keys/" },
  spelling: { name: "Spelling", sub: "Spelling Hive", url: "https://nssharpe.github.io/spelling-hive/" },
};

export const STATUS_LABEL = { needs: "Needs more", ok: "On track", max: "At max", off: "Off" };

// App link with the hub handoff appended: `#hub=<code>&kid=<kid>`. Without a hub code there is
// nothing to hand over (apps ignore a kid with no hub), so it is the plain app URL.
export function appHref(app, code, kid) {
  const url = APP_INFO[app].url;
  return code ? `${url}#hub=${encodeURIComponent(code)}&kid=${encodeURIComponent(kid)}` : url;
}

// The app furthest under its minimum share this week, or null if none is under it.
export function bestPick(mix) {
  let best = null, gap = 0;
  for (const app of APPS) {
    const m = mix[app];
    if (!m || m.status !== "needs") continue;
    const g = m.min - m.share * 100;
    if (g > gap) { gap = g; best = app; }
  }
  return best;
}

// The line under an app tile.
export function tileNote(status) {
  if (status === "max") return "Practice only — no TV time until others catch up";
  if (status === "off") return "Practice only";
  return "Earns TV time";
}

// "4:12pm", or "Mon 4:12pm" when it was not today.
export function timeLabel(ts, now) {
  const d = new Date(ts);
  const h = d.getHours();
  const t = (h % 12 || 12) + ":" + String(d.getMinutes()).padStart(2, "0") + (h < 12 ? "am" : "pm");
  const same = d.toDateString() === new Date(now).toDateString();
  return same ? t : d.toLocaleDateString("en-US", { weekday: "short" }) + " " + t;
}

// "+3 Spelling · 4:12pm", with "(practice only)" when the weekly caps stopped some tickets counting.
export function recentLine(e, now) {
  const s = `+${e.tickets} ${APP_NAMES[e.app] || e.app} · ${timeLabel(e.ts, now)}`;
  return e.counted < e.tickets ? s + " (practice only)" : s;
}

// Tickets still needed for the next unlock, and the minutes it pays.
export function nextUnlock(settings, ladder) {
  const L = settings.ladder;
  const minutes = Array.isArray(L) && L.length ? L[Math.min(ladder.nextIndex, L.length - 1)][1] : 0;
  return { left: Math.max(0, ladder.needed - ladder.done), minutes };
}

// 4:10pm from a timestamp, for "showing what we had at 4:10pm".
export const clockLabel = ts => timeLabel(ts, ts);

// One kid's numbers from all events (every kid's is fine: they are filtered here, because
// countTickets must see one kid's events at a time).
export function buildKidData(events, settings, kidId, now) {
  const kid = settings.kids[kidId];
  if (!kid) return null;
  const mine = (events || []).filter(e => e && e.kid === kidId);
  const counted = countTickets(mine, kid.ranges, settings.baseline, now);
  return {
    counted,
    mix: weeklyMix(counted, kid.ranges, now),
    ladder: ladderStatus(settings.ladder, counted, now),
    recent: counted.slice().reverse().slice(0, 10), // newest first
  };
}

// R11: AMC tickets come only from the Sheet. Any `amc` event found in the hub log is dropped
// before the two sources are combined (rules allow such events, but nothing should write them).
export function kidEvents(hubEvents, amcEvents) {
  return (hubEvents || []).filter(e => e && e.app !== "amc").concat(amcEvents || []);
}
