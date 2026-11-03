import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS, effectiveSettings, withPendingChange, validateSettings,
  amcTickets, amcTicketEvents, countTickets, weeklyMix, guaranteedShares,
  ladderStatus, localDayKey, ticketsSince,
} from "../js/balance.js";

const DAY = 24 * 60 * 60 * 1000;
const at = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min).getTime(); // local time
const MON9 = at(2026, 10, 2, 9); // Monday 2 Nov 2026, 09:00 local
const RATES = DEFAULT_SETTINGS.rates;
const ZYLER = DEFAULT_SETTINGS.kids.zyler.ranges;
const OPEN = { amc: [0, 100], french: [0, 100], typing: [0, 100], spelling: [0, 100] };

let seq = 0;
const ev = (app, tickets, ts, id) => ({ id: id ?? `e${String(++seq).padStart(5, "0")}`, kid: "zyler", app, tickets, ts, detail: "" });
const sum = (list, app) => list.filter(e => !app || e.app === app).reduce((s, e) => s + e.counted, 0);
const byId = (list, id) => list.find(e => e.id === id);

// ---------- DEFAULT_SETTINGS ----------

test("DEFAULT_SETTINGS has the spec values", () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    v: 1,
    kids: {
      zyler: { name: "Zyler", ranges: { amc: [0, 30], french: [10, 30], typing: [25, 50], spelling: [25, 50] } },
      kadyn: { name: "Kadyn", ranges: { amc: [0, 100], french: [0, 100], typing: [0, 100], spelling: [0, 100] } },
    },
    rates: { amcBase: 1, amcPerNum: 0.2, amc10Mult: 1.5, frenchCardsPerTicket: 4, typingCharsPerTicket: 100, typingMasteredFactor: 0.5, spellingWordsPerTicket: 3 },
    baseline: 150,
    ladder: [[15, 30], [20, 25], [25, 20], [30, 15], [35, 10], [40, 5]],
    pending: null,
  });
});

// ---------- localDayKey ----------

test("localDayKey uses the local day, starting at midnight", () => {
  assert.equal(localDayKey(at(2026, 10, 3, 0, 0)), "2026-11-03");
  assert.equal(localDayKey(at(2026, 10, 3, 0, 0) - 1), "2026-11-02");
  assert.equal(localDayKey(at(2026, 0, 5, 23, 59)), "2026-01-05");
});

// ---------- amcTickets ----------

test("amcTickets: round(1 + 0.2n), AMC 10 x1.5, wrong answers 0", () => {
  assert.equal(amcTickets({ y: "2019", n: 1, ok: true, ts: 1 }, RATES), 1);
  assert.equal(amcTickets({ y: "2019", n: 10, ok: true, ts: 1 }, RATES), 3);
  assert.equal(amcTickets({ y: "2019", n: 25, ok: true, ts: 1 }, RATES), 6);
  assert.equal(amcTickets({ y: "10:2020A", n: 25, ok: true, ts: 1 }, RATES), 9);
  assert.equal(amcTickets({ y: "2019", n: 25, ok: false, ts: 1 }, RATES), 0);
});

test("amcTicketEvents: only ok answers, id amc:y:n:ts", () => {
  const evs = amcTicketEvents([
    { y: "2019", n: 10, ok: true, ts: MON9 },
    { y: "2019", n: 11, ok: false, ts: MON9 + 1 },
    { y: "10:2020A", n: 25, ok: true, ts: MON9 + 2 },
  ], "zyler", RATES);
  assert.equal(evs.length, 2);
  assert.deepEqual(evs.map(e => [e.id, e.kid, e.app, e.tickets, e.ts]), [
    [`amc:2019:10:${MON9}`, "zyler", "amc", 3, MON9],
    [`amc:10:2020A:25:${MON9 + 2}`, "zyler", "amc", 9, MON9 + 2],
  ]);
  for (const e of evs) assert.ok(typeof e.detail === "string" && e.detail.length > 0 && e.detail.length <= 80);
});

test("amcTicketEvents skips answers without a numeric ts or worth < 1 ticket", () => {
  const evs = amcTicketEvents([
    { y: "2019", n: 5, ok: true },
    { y: "2019", n: 6, ok: true, ts: null },
    { y: "2019", n: 1, ok: true, ts: MON9 },
  ], "kadyn", { ...RATES, amcBase: 0, amcPerNum: 0.2 }); // n=1 → round(0.2) = 0
  assert.deepEqual(evs, []);
});

// ---------- countTickets ----------

test("countTickets: an uncapped app counts everything", () => {
  const out = countTickets([ev("french", 5, MON9)], OPEN, 150, MON9);
  assert.equal(out.length, 1);
  assert.equal(out[0].counted, 5);
});

test("countTickets: cold start caps Zyler's AMC at 30% x baseline 150 = 45", () => {
  const one = countTickets([ev("amc", 50, MON9)], ZYLER, 150, MON9 + 1000);
  assert.equal(sum(one), 45);
  // the same 50 tickets one at a time: 1st-45th count, 46th-50th count 0
  const singles = Array.from({ length: 50 }, (_, i) => ev("amc", 1, MON9 + i * 1000));
  const out = countTickets(singles, ZYLER, 150, MON9 + DAY / 2);
  assert.equal(sum(out), 45);
  assert.deepEqual(out.slice(45).map(e => e.counted), [0, 0, 0, 0, 0]);
  assert.ok(out.slice(0, 45).every(e => e.counted === 1));
});

test("countTickets: partial count when an event crosses the cap", () => {
  const out = countTickets([ev("amc", 44, MON9, "a"), ev("amc", 3, MON9 + 1000, "b")], ZYLER, 150, MON9 + 2000);
  assert.equal(byId(out, "a").counted, 44);
  assert.equal(byId(out, "b").counted, 1);
});

test("countTickets: a big single event counts like that many single tickets (R10)", () => {
  // empty week, Zyler defaults: 30% x 150 = 45 AMC, 50% x 150 = 75 typing
  assert.equal(countTickets([ev("amc", 1000, MON9)], ZYLER, 150, MON9)[0].counted, 45);
  assert.equal(countTickets([ev("typing", 300, MON9)], ZYLER, 150, MON9)[0].counted, 75);
  // and exactly what the same tickets one at a time would give
  const singles = Array.from({ length: 300 }, (_, i) => ev("typing", 1, MON9 + i));
  assert.equal(sum(countTickets(singles, ZYLER, 150, MON9 + 1000)), 75);
});

test("countTickets: past the baseline, a big event still stops at the max share", () => {
  // typing [0,100], AMC [0,30]: 200 typing, then 1000 AMC → 30% of (200 + c) ≥ c → c ≤ 85.7 → 85
  const ranges = { amc: [0, 30], french: [0, 30], typing: [0, 100], spelling: [0, 50] };
  const out = countTickets([ev("typing", 200, MON9, "t"), ev("amc", 1000, MON9 + 1, "a")], ranges, 150, MON9 + 2);
  assert.equal(byId(out, "a").counted, 85);
  const one = Array.from({ length: 1000 }, (_, i) => ev("amc", 1, MON9 + 1 + i));
  assert.equal(sum(countTickets([ev("typing", 200, MON9, "t"), ...one], ranges, 150, MON9 + 5000), "amc"), 85);
});

test("countTickets: catch-up, after 300 typing tickets AMC's cap is 30% of the bigger total", () => {
  // typing uncapped here so all 300 count and the counted total is 45 + 300 = 345
  const ranges = { amc: [0, 30], french: [0, 30], typing: [0, 100], spelling: [0, 50] };
  const t = MON9;
  const out = countTickets([
    ev("amc", 50, t, "a1"),            // 45 (cold start)
    ev("amc", 10, t + 1000, "a2"),     // 0, at the cap
    ev("typing", 300, t + 2000, "t1"), // 300: cap 100% x 345
    ev("amc", 100, t + 3000, "a3"),    // per ticket: 45 + c <= 30% x (345 + c) → c <= 83.57 → 83
    ev("amc", 10, t + 4000, "a4"),     // AMC is at 128 of 428; a 129th doesn't fit 30% x 429 → 0
  ], ranges, 150, t + 5000);
  assert.deepEqual(out.map(e => [e.id, e.counted]), [["a1", 45], ["a2", 0], ["t1", 300], ["a3", 83], ["a4", 0]]);
});

test("countTickets: catch-up with single AMC tickets stops when AMC reaches 30%", () => {
  const ranges = { amc: [0, 30], french: [0, 30], typing: [0, 100], spelling: [0, 50] };
  const evs = [ev("amc", 45, MON9), ev("typing", 300, MON9 + 1000)];
  for (let i = 0; i < 100; i++) evs.push(ev("amc", 1, MON9 + 2000 + i));
  const out = countTickets(evs, ranges, 150, MON9 + DAY);
  // a counts while floor(0.3 x (301 + a) - a) >= 1, i.e. a <= 127, so AMC ends at 128 of 428
  assert.equal(sum(out, "amc"), 128);
  assert.equal(sum(out), 428);
});

test("countTickets: [0,0] switches an app off", () => {
  const ranges = { ...OPEN, spelling: [0, 0] };
  const out = countTickets([ev("spelling", 5, MON9), ev("spelling", 1, MON9 + 1), ev("french", 2, MON9 + 2)], ranges, 150, MON9 + 3);
  assert.deepEqual(out.filter(e => e.app === "spelling").map(e => e.counted), [0, 0]);
  assert.equal(sum(out, "french"), 2);
});

test("countTickets: an app missing from ranges counts 0", () => {
  const out = countTickets([ev("typing", 5, MON9)], { amc: [0, 100] }, 150, MON9);
  assert.equal(out[0].counted, 0);
});

test("countTickets: an event 8 days old doesn't count toward today's caps", () => {
  const now = MON9;
  const out = countTickets([ev("amc", 50, now - 8 * DAY, "old"), ev("amc", 50, now - 1000, "new")], ZYLER, 150, now);
  assert.equal(byId(out, "old").counted, 45);
  assert.equal(byId(out, "new").counted, 45);
});

test("countTickets: window is (ts - 7d, ts], so an event exactly 7 days earlier is out", () => {
  const t = MON9 - 10 * DAY;
  const exact = countTickets([ev("amc", 45, t, "a"), ev("amc", 10, t + 7 * DAY, "b")], ZYLER, 150, MON9);
  assert.equal(byId(exact, "b").counted, 10);
  const inside = countTickets([ev("amc", 45, t, "a"), ev("amc", 10, t + 7 * DAY - 1, "b")], ZYLER, 150, MON9);
  assert.equal(byId(inside, "b").counted, 0);
});

test("countTickets: result covers [ticketsSince(now), now], and the older days still shape today's caps", () => {
  const now = MON9;                  // Mon 2 Nov 09:00
  const since = at(2026, 9, 19, 0); // Mon 19 Oct 00:00, local midnight 14 days before today
  const out = countTickets([
    ev("amc", 5, since - 1, "gone"),
    ev("amc", 5, since, "edge"),
    ev("amc", 5, now - 14 * DAY - 1, "after-midnight"), // before now - 14d, but after the anchor: kept
    ev("amc", 45, now - 7 * DAY + 1, "recent"),         // still inside the window of the next event
    ev("amc", 10, now - 1000, "today"),
    ev("amc", 10, now + 1, "future"),
  ], ZYLER, 150, now);
  assert.deepEqual(out.map(e => e.id), ["edge", "after-midnight", "recent", "today"]);
  assert.equal(byId(out, "recent").counted, 45);
  assert.equal(byId(out, "today").counted, 0);
});

test("countTickets: today's counted tickets don't change as the day goes on (R8 regression)", () => {
  // Chain: old AMC 14 days back caps a 7-days-back AMC event, which leaves today's AMC free.
  // With a moving now - 14d cut-off, "old" fell off by 11:00 and today's 45 dropped to 0.
  // Times leave an hour of slack so the chain forms with or without the 1 Nov DST change.
  const evs = [
    ev("amc", 45, at(2026, 9, 20, 10, 45), "old"),     // Tue 20 Oct 10:45, 14 days back, in week's window
    ev("french", 5, at(2026, 9, 24, 12), "mid"),       // Sat 24 Oct, 10 days back
    ev("typing", 20, at(2026, 9, 25, 18), "mid2"),     // Sun 25 Oct, 9 days back
    ev("amc", 45, at(2026, 9, 27, 10, 30), "week"),    // Tue 27 Oct 10:30, inside today's 09:00 window
    ev("amc", 45, at(2026, 10, 3, 9), "today"),        // Tue 3 Nov 09:00
  ];
  const countedToday = now => {
    const out = countTickets(evs, ZYLER, 150, now);
    assert.equal(byId(out, "week").counted, 0);
    return byId(out, "today").counted;
  };
  assert.equal(countedToday(at(2026, 10, 3, 9) + 1000), 45);
  assert.equal(countedToday(at(2026, 10, 3, 11)), 45);
  assert.equal(countedToday(at(2026, 10, 3, 23, 59)), 45);
  const lad = ladderStatus(DEFAULT_SETTINGS.ladder, countTickets(evs, ZYLER, 150, at(2026, 10, 3, 23, 59)), at(2026, 10, 3, 23, 59));
  assert.equal(lad.earnedMinutes, 55); // 45 tickets: 15 + 20, 10 toward the third rung
});

test("ticketsSince: local midnight 14 days before today's day start, the same all day", () => {
  assert.equal(ticketsSince(at(2026, 10, 3, 0, 0)), at(2026, 9, 20, 0));
  assert.equal(ticketsSince(at(2026, 10, 3, 15)), at(2026, 9, 20, 0));
  assert.equal(ticketsSince(at(2026, 10, 4, 0, 0) - 1), at(2026, 9, 20, 0));
  assert.equal(ticketsSince(at(2026, 10, 4, 0, 0)), at(2026, 9, 21, 0));
  assert.equal(ticketsSince(at(2026, 0, 10, 8)), at(2025, 11, 27, 0)); // across a year
  assert.equal(ticketsSince(at(2026, 10, 10, 12)), at(2026, 9, 27, 0)); // across the US DST change (1 Nov)
  assert.equal(new Date(ticketsSince(at(2026, 2, 20, 12))).getHours(), 0); // and the spring one
});

test("countTickets: the same id twice is counted once", () => {
  const e = ev("french", 5, MON9, "dup");
  const out = countTickets([e, { ...e }, ev("french", 2, MON9 + 1, "other")], OPEN, 150, MON9 + 2);
  assert.deepEqual(out.map(x => [x.id, x.counted]), [["dup", 5], ["other", 2]]);
});

test("countTickets: ties in ts are broken by id, whatever the input order", () => {
  const a = ev("amc", 30, MON9, "amc:b");
  const b = ev("amc", 30, MON9, "amc:a");
  const one = countTickets([a, b], ZYLER, 150, MON9);
  const two = countTickets([b, a], ZYLER, 150, MON9);
  assert.deepEqual(one, two);
  assert.deepEqual(one.map(e => [e.id, e.counted]), [["amc:a", 30], ["amc:b", 15]]);
});

test("countTickets: ids compare by code unit, not locale", () => {
  const out = countTickets([ev("french", 1, MON9, "b"), ev("french", 1, MON9, "B"), ev("french", 1, MON9, "a")], OPEN, 150, MON9);
  assert.deepEqual(out.map(e => e.id), ["B", "a", "b"]);
});

test("countTickets: sorts by ts and doesn't mutate the input", () => {
  const input = [ev("french", 1, MON9 + 5, "x"), ev("french", 1, MON9, "y")];
  const copy = structuredClone(input);
  const out = countTickets(input, OPEN, 150, MON9 + 10);
  assert.deepEqual(input, copy);
  assert.deepEqual(out.map(e => e.id), ["y", "x"]);
  assert.ok(!("counted" in input[0]));
});

test("countTickets: cap math is exact for percentages like 57%", () => {
  // (57/100)*100 is 56.999… in floating point; the cap must still be 57
  const out = countTickets([ev("amc", 100, MON9)], { ...OPEN, amc: [0, 57] }, 100, MON9);
  assert.equal(out[0].counted, 57);
});

// ---------- weeklyMix ----------

test("weeklyMix with no events: shares 0, statuses needs / ok / off", () => {
  const ranges = { ...ZYLER, amc: [0, 0] };
  const mix = weeklyMix([], ranges, MON9);
  assert.deepEqual(mix, {
    amc: { counted: 0, share: 0, min: 0, max: 0, status: "off" },
    french: { counted: 0, share: 0, min: 10, max: 30, status: "needs" },
    typing: { counted: 0, share: 0, min: 25, max: 50, status: "needs" },
    spelling: { counted: 0, share: 0, min: 25, max: 50, status: "needs" },
  });
  assert.equal(weeklyMix([], ZYLER, MON9).amc.status, "ok");
});

test("weeklyMix: shares over the trailing 7 days, at max / ok / needs", () => {
  const now = MON9;
  const counted = [
    { ...ev("amc", 30, now - 7 * DAY), counted: 30 },     // exactly 7 days old: out
    { ...ev("amc", 30, now - 1000), counted: 30 },
    { ...ev("typing", 40, now - 900), counted: 40 },
    { ...ev("spelling", 25, now - 800), counted: 25 },
    { ...ev("french", 5, now - 700), counted: 5 },
  ];
  const mix = weeklyMix(counted, ZYLER, now);
  assert.equal(mix.amc.counted, 30);
  assert.equal(mix.amc.share, 0.3);
  assert.equal(mix.amc.status, "max");      // 30% of 100 is at AMC's max
  assert.equal(mix.typing.status, "ok");    // 40%
  assert.equal(mix.spelling.status, "ok");  // 25%, exactly the min
  assert.equal(mix.french.status, "needs"); // 5% < 10%
});

// ---------- guaranteedShares ----------

test("guaranteedShares(zyler): spelling warns with the exact text", () => {
  const g = guaranteedShares(ZYLER);
  assert.deepEqual(g.spelling, {
    guaranteed: 0,
    warning: "Spelling could still end up at 0%. The other apps' maxes add up to 110% — bring them down to 75% or less to guarantee 25%.",
  });
});

test("guaranteedShares: lower maxes guarantee spelling's min", () => {
  const g = guaranteedShares({ amc: [0, 20], french: [0, 20], typing: [25, 35], spelling: [25, 50] });
  assert.deepEqual(g.spelling, { guaranteed: 25, warning: null });
});

test("guaranteedShares: an app with min 0 never warns", () => {
  const g = guaranteedShares(ZYLER);
  assert.equal(g.amc.warning, null);
  assert.equal(g.amc.guaranteed, 0);
  for (const r of [OPEN, { amc: [0, 0], french: [0, 0], typing: [0, 0], spelling: [0, 0] }]) {
    for (const v of Object.values(guaranteedShares(r))) assert.equal(v.warning, null);
  }
  assert.equal(guaranteedShares({ amc: [0, 0], french: [0, 0], typing: [0, 0], spelling: [0, 0] }).amc.guaranteed, 100);
});

test("guaranteedShares: names apps in the warning (French, Typing, AMC)", () => {
  const g = guaranteedShares({ amc: [10, 100], french: [10, 100], typing: [10, 100], spelling: [0, 0] });
  assert.match(g.amc.warning, /^AMC could still end up at 0%\. The other apps' maxes add up to 200% — bring them down to 90% or less to guarantee 10%\.$/);
  assert.match(g.french.warning, /^French /);
  assert.match(g.typing.warning, /^Typing /);
});

// ---------- ladderStatus ----------

const LADDER = DEFAULT_SETTINGS.ladder;
const today = (counted, ts = MON9) => [{ ...ev("typing", counted || 1, ts), counted }];

test("ladderStatus: nothing counted today", () => {
  assert.deepEqual(ladderStatus(LADDER, [], MON9), { unlocks: 0, earnedMinutes: 0, nextIndex: 0, needed: 15, done: 0, ticketsToday: 0 });
  assert.deepEqual(ladderStatus(LADDER, today(0), MON9), { unlocks: 0, earnedMinutes: 0, nextIndex: 0, needed: 15, done: 0, ticketsToday: 0 });
});

test("ladderStatus: 40 counted today = 2 unlocks, 55 minutes, 5 toward rung 3", () => {
  assert.deepEqual(ladderStatus(LADDER, today(40), MON9 + 1000), { unlocks: 2, earnedMinutes: 55, nextIndex: 2, needed: 25, done: 5, ticketsToday: 40 });
});

test("ladderStatus: the last rung repeats", () => {
  // 15+20+25+30+35 = 125 for 100 minutes, then 275 = 6 x 40 (30 min) + 35
  assert.deepEqual(ladderStatus(LADDER, today(400), MON9 + 1000), { unlocks: 11, earnedMinutes: 130, nextIndex: 11, needed: 40, done: 35, ticketsToday: 400 });
});

test("ladderStatus: only counted tickets from the current local day", () => {
  const counted = [
    { ...ev("typing", 40, at(2026, 10, 1, 23, 59)), counted: 40 }, // yesterday
    { ...ev("typing", 20, at(2026, 10, 2, 0, 0)), counted: 10 },   // today at midnight, 10 counted
  ];
  assert.deepEqual(ladderStatus(LADDER, counted, MON9), { unlocks: 0, earnedMinutes: 0, nextIndex: 0, needed: 15, done: 10, ticketsToday: 10 });
});

test("ladderStatus: exactly at a rung boundary", () => {
  assert.deepEqual(ladderStatus(LADDER, today(15), MON9 + 1), { unlocks: 1, earnedMinutes: 30, nextIndex: 1, needed: 20, done: 0, ticketsToday: 15 });
});

// ---------- settings ----------

const changed = () => ({ ...structuredClone(DEFAULT_SETTINGS), baseline: 200 });

test("withPendingChange sets pending from tomorrow's local day", () => {
  const doc = withPendingChange(DEFAULT_SETTINGS, changed(), at(2026, 10, 3, 15));
  assert.equal(doc.baseline, 150);
  assert.equal(doc.pending.effectiveFrom, "2026-11-04");
  assert.equal(doc.pending.settings.baseline, 200);
  assert.equal(doc.pending.settings.pending, null);
  assert.equal(DEFAULT_SETTINGS.pending, null); // input untouched
  assert.equal(withPendingChange(DEFAULT_SETTINGS, changed(), at(2026, 10, 30, 23, 59)).pending.effectiveFrom, "2026-12-01");
  assert.equal(withPendingChange(DEFAULT_SETTINGS, changed(), at(2026, 11, 31, 12)).pending.effectiveFrom, "2027-01-01");
});

test("effectiveSettings: a change made at 15:00 applies from 00:00 the next local day", () => {
  const doc = withPendingChange(DEFAULT_SETTINGS, changed(), at(2026, 10, 3, 15));
  assert.equal(effectiveSettings(doc, at(2026, 10, 3, 15, 1)).baseline, 150);
  assert.equal(effectiveSettings(doc, at(2026, 10, 4, 0, 0) - 1).baseline, 150);
  const next = effectiveSettings(doc, at(2026, 10, 4, 0, 0));
  assert.equal(next.baseline, 200);
  assert.equal(next.pending, null);
  const same = effectiveSettings(DEFAULT_SETTINGS, MON9);
  assert.deepEqual(same, DEFAULT_SETTINGS);
  assert.notEqual(same, DEFAULT_SETTINGS); // a fresh copy, never the caller's object
  same.kids.zyler.ranges.amc[1] = 99;
  assert.equal(DEFAULT_SETTINGS.kids.zyler.ranges.amc[1], 30);
});

test("withPendingChange keeps a pending change that already took effect", () => {
  // changed on Monday, in effect since Tuesday 00:00; another edit on Tuesday afternoon
  const mon = withPendingChange(DEFAULT_SETTINGS, changed(), at(2026, 10, 2, 15));
  const tue = withPendingChange(mon, { ...changed(), baseline: 250 }, at(2026, 10, 3, 15));
  assert.equal(effectiveSettings(tue, at(2026, 10, 3, 16)).baseline, 200); // Monday's edit still applies today
  assert.equal(effectiveSettings(tue, at(2026, 10, 4, 0)).baseline, 250);
  assert.equal(tue.pending.effectiveFrom, "2026-11-04");
});

test("validateSettings accepts the defaults", () => {
  assert.equal(validateSettings(DEFAULT_SETTINGS), null);
});

test("validateSettings rejects bad ranges, ladder rows and baselines", () => {
  const bad = f => { const s = structuredClone(DEFAULT_SETTINGS); f(s); return validateSettings(s); };
  const isErr = v => assert.ok(typeof v === "string" && v.length > 0, `expected an error, got ${v}`);
  isErr(bad(s => { s.kids.zyler.ranges.amc = [40, 30]; }));     // min > max
  isErr(bad(s => { s.kids.zyler.ranges.amc = [-1, 30]; }));
  isErr(bad(s => { s.kids.kadyn.ranges.french = [0, 101]; }));
  isErr(bad(s => { delete s.kids.zyler.ranges.typing; }));
  isErr(bad(s => { s.ladder[2] = [0, 20]; }));
  isErr(bad(s => { s.ladder[2] = [25, 0]; }));
  isErr(bad(s => { s.ladder[2] = [25, -5]; }));
  isErr(bad(s => { s.ladder = []; }));
  isErr(bad(s => { s.baseline = 0; }));
  isErr(bad(s => { s.baseline = 0.5; }));
  isErr(bad(s => { s.rates.frenchCardsPerTicket = 0; }));
  isErr(bad(s => { s.rates.frenchCardsPerTicket = 2.5; }));
  isErr(bad(s => { s.rates.spellingWordsPerTicket = 1.5; }));
  isErr(bad(s => { s.kids.zyler.name = ""; }));
  isErr(validateSettings(null));
});
