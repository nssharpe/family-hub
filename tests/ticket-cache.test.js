import { test } from "node:test";
import assert from "node:assert/strict";
import { ticketsSince } from "../js/balance.js";
import { FULL_REFRESH_MS, incrementalSince, needsFullRefresh, mergeEvents, refreshTickets } from "../js/ticket-cache.js";

const CODE = "hub-abcde-23456-fghjk-mnpqr";
const NOW = new Date(2026, 10, 3, 16, 30).getTime(); // Tue 3 Nov 2026, 4:30pm local
const ev = (id, ts) => ({ id, kid: "zyler", app: "typing", tickets: 1, ts, detail: "" });
const cacheAt = (fullAt, events = []) => ({ code: CODE, events, at: fullAt, fullAt });

test("incrementalSince is local midnight at the start of yesterday", () => {
  assert.equal(incrementalSince(NOW), new Date(2026, 10, 2).getTime());
  assert.equal(incrementalSince(new Date(2026, 10, 3, 0, 0).getTime()), new Date(2026, 10, 2).getTime());
  assert.equal(incrementalSince(new Date(2026, 10, 3, 23, 59).getTime()), new Date(2026, 10, 2).getTime());
});

test("needsFullRefresh: no cache, other hub, odd cache, 6 h, new local day, clock moved back", () => {
  assert.equal(needsFullRefresh(null, CODE, NOW), true);
  assert.equal(needsFullRefresh(cacheAt(NOW - 60e3), CODE, NOW), false, "a routine refresh");
  assert.equal(needsFullRefresh({ ...cacheAt(NOW - 60e3), code: "hub-zzzzz-23456-fghjk-mnpqr" }, CODE, NOW), true, "another hub's cache");
  assert.equal(needsFullRefresh({ events: [], at: NOW - 1000 }, CODE, NOW), true, "an old-format entry has no code or fullAt");
  assert.equal(needsFullRefresh({ ...cacheAt(NOW - 60e3), events: null }, CODE, NOW), true);
  assert.equal(needsFullRefresh(cacheAt(NOW - FULL_REFRESH_MS + 1), CODE, NOW), false);
  assert.equal(needsFullRefresh(cacheAt(NOW - FULL_REFRESH_MS), CODE, NOW), true, "6 h after the last full fetch");
  const late = new Date(2026, 10, 3, 23, 58).getTime();
  assert.equal(needsFullRefresh(cacheAt(late), CODE, late + 120e3), true, "local day changed, only 2 minutes later");
  assert.equal(needsFullRefresh(cacheAt(NOW + 3600e3), CODE, NOW), true, "full fetch lies in the future");
});

test("mergeEvents: merged by id (no duplicates), aged out before ticketsSince(now), sorted", () => {
  const from = ticketsSince(NOW);
  const cached = [ev("b", NOW - 2000), ev("old", from - 1), ev("edge", from), ev("a", NOW - 3000)];
  const fetched = [ev("b", NOW - 2000), ev("c", NOW - 1000), ev("a", NOW - 3000)];
  const out = mergeEvents(cached, fetched, NOW);
  assert.deepEqual(out.map(e => e.id), ["edge", "a", "b", "c"]);
  assert.deepEqual(mergeEvents(null, undefined, NOW), []);
});

test("refreshTickets: routine refresh asks since yesterday midnight, keeps the cache's older events", async () => {
  const asked = [];
  const older = ev("older", ticketsSince(NOW) + 1000);
  const c0 = cacheAt(NOW - 60e3, [older]);
  const r = await refreshTickets(c0, CODE, NOW, async since => { asked.push(since); return [ev("new", NOW - 1000)]; });
  assert.deepEqual(asked, [incrementalSince(NOW)]);
  assert.deepEqual(r.events.map(e => e.id), ["older", "new"]);
  assert.equal(r.cache.fullAt, c0.fullAt, "a routine refresh doesn't reset the full-refresh clock");
  assert.equal(r.cache.at, NOW);
  assert.equal(r.cache.code, CODE);
});

test("refreshTickets: full refresh asks since ticketsSince(now), replaces the cache and resets the clock", async () => {
  const asked = [];
  const stale = ev("gone", NOW - 5000); // not on the server any more: a full read is authoritative
  const r = await refreshTickets(cacheAt(NOW - FULL_REFRESH_MS, [stale]), CODE, NOW, async since => { asked.push(since); return [ev("x", NOW - 10)]; });
  assert.deepEqual(asked, [ticketsSince(NOW)]);
  assert.deepEqual(r.events.map(e => e.id), ["x"]);
  assert.equal(r.cache.fullAt, NOW);
});

test("refreshTickets: a failed fetch rejects, leaving the caller's cache alone", async () => {
  const c0 = cacheAt(NOW - 60e3, [ev("a", NOW - 1000)]);
  await assert.rejects(refreshTickets(c0, CODE, NOW, async () => { throw new Error("offline"); }), /offline/);
  assert.equal(c0.events.length, 1);
});
