import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../js/balance.js";
import { appHref, bestPick, tileNote, recentLine, nextUnlock, buildKidData, kidEvents, APP_INFO } from "../js/view-model.js";

const CODE = "hub-abcde-23456-fghjk-mnpqr";
const NOW = new Date(2026, 10, 3, 16, 30).getTime(); // 4:30pm local
const at = (h, m = 0) => new Date(2026, 10, 3, h, m).getTime();
const mix = (o) => Object.fromEntries(["amc", "french", "typing", "spelling"].map(a =>
  [a, { counted: 0, share: 0, min: 0, max: 100, status: "ok", ...(o[a] || {}) }]));

test("appHref appends the hub handoff, or nothing without a hub", () => {
  assert.equal(appHref("spelling", CODE, "zyler"), `https://nssharpe.github.io/spell-hive/#hub=${CODE}&kid=zyler`);
  assert.equal(appHref("french", null, "kadyn"), "https://nssharpe.github.io/mamou-french/");
  assert.deepEqual(Object.keys(APP_INFO), ["amc", "french", "typing", "spelling"]);
});

test("bestPick is the app furthest under its min", () => {
  assert.equal(bestPick(mix({ french: { status: "needs", min: 10, share: 0.05 }, typing: { status: "needs", min: 25, share: 0.05 } })), "typing");
  assert.equal(bestPick(mix({})), null);
});

test("tileNote wording", () => {
  assert.equal(tileNote("max"), "Practice only — no TV time until others catch up");
  assert.equal(tileNote("off"), "Practice only");
  assert.equal(tileNote("ok"), "Earns TV time");
});

test("recentLine shows time, and practice only when capped", () => {
  assert.equal(recentLine({ tickets: 3, counted: 3, app: "spelling", ts: at(16, 12) }, NOW), "+3 Spelling · 4:12pm");
  assert.equal(recentLine({ tickets: 3, counted: 1, app: "typing", ts: at(9, 5) }, NOW), "+3 Typing · 9:05am (practice only)");
  assert.equal(recentLine({ tickets: 1, counted: 1, app: "amc", ts: at(0, 0) }, NOW), "+1 AMC · 12:00am");
  assert.match(recentLine({ tickets: 2, counted: 2, app: "french", ts: NOW - 2 * 86400000 }, NOW), /^\+2 French · \w{3} \d+:\d\d[ap]m$/);
});

test("nextUnlock: tickets left and the minutes the next rung pays", () => {
  assert.deepEqual(nextUnlock(DEFAULT_SETTINGS, { nextIndex: 0, needed: 15, done: 4 }), { left: 11, minutes: 30 });
  assert.deepEqual(nextUnlock(DEFAULT_SETTINGS, { nextIndex: 9, needed: 40, done: 0 }), { left: 40, minutes: 5 });
});

test("buildKidData counts one kid's events and lists the newest first", () => {
  const ev = (id, kid, app, tickets, ts) => ({ id, kid, app, tickets, ts, detail: "" });
  const events = [ev("a", "zyler", "typing", 5, at(10)), ev("b", "zyler", "french", 3, at(11)), ev("c", "kadyn", "typing", 50, at(12))];
  const d = buildKidData(events, DEFAULT_SETTINGS, "zyler", NOW);
  assert.deepEqual(d.recent.map(e => e.id), ["b", "a"]);
  assert.equal(d.ladder.ticketsToday, d.counted.reduce((s, e) => s + e.counted, 0));
  assert.ok(d.mix.typing.counted <= 5);
  assert.equal(buildKidData(events, DEFAULT_SETTINGS, "nobody", NOW), null);
});

test("kidEvents (R11): amc events in the hub log are ignored, Sheet-derived ones kept", () => {
  const ev = (id, app, tickets, ts) => ({ id, kid: "zyler", app, tickets, ts, detail: "" });
  const hub = [ev("h1", "amc", 40, at(10)), ev("h2", "typing", 3, at(11))];
  const sheet = [ev("amc:2010:5:1", "amc", 2, at(9))];
  const got = kidEvents(hub, sheet);
  assert.deepEqual(got.map(e => e.id), ["h2", "amc:2010:5:1"]);
  const d = buildKidData(got, DEFAULT_SETTINGS, "zyler", NOW);
  assert.equal(d.mix.amc.counted, 2);
  assert.deepEqual(kidEvents(null, null), []);
});
