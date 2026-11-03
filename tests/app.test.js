import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../js/balance.js";

const CODE = "hub-abcde-23456-fghjk-mnpqr";
const mem = {};
globalThis.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };

// A fake page for the JSONP read: appending the script calls the callback with `sheetRows` (or never).
let sheetMode;
let sheetRows = [];
globalThis.window = globalThis;
globalThis.document = {
  body: { appendChild(script) {
    const cb = new URL(script.src).searchParams.get("tqx").split(":")[1];
    if (sheetMode === "hang") return;
    setTimeout(() => globalThis[cb] && globalThis[cb]({ status: "ok", table: { rows: sheetRows } }), 0);
  } },
  createElement: () => ({ remove() {} }),
};

const fsTicket = (id, kid, app, tickets, ts) => ({ document: { name: `projects/p/databases/(default)/documents/hubs/${CODE}/tickets/${id}`, fields: {
  kid: { stringValue: kid }, app: { stringValue: app }, tickets: { integerValue: String(tickets) }, ts: { integerValue: String(ts) }, detail: { stringValue: "" } } } });

// The fake hub: `serverTickets` ([id, kid, app, tickets, ts]) answered with the query's ts filter applied,
// every query's lower bound recorded in `queries`, and an optional settings doc.
let hubMode;
let serverTickets;
let queries;
let settingsDoc;
globalThis.fetch = (url, init = {}) => {
  if (hubMode === "hang") return new Promise(() => {});
  if (String(url).endsWith(":runQuery")) {
    const since = Number(JSON.parse(init.body).structuredQuery.where.fieldFilter.value.integerValue);
    queries.push(since);
    const rows = serverTickets.filter(t => t[4] >= since).map(t => fsTicket(...t));
    return Promise.resolve({ ok: true, status: 200, json: async () => (rows.length ? rows : [{ readTime: "x" }]) });
  }
  if (settingsDoc) return Promise.resolve({ ok: true, status: 200, json: async () => ({ updateTime: "2026-11-03T00:00:00Z", fields: { data: { stringValue: JSON.stringify(settingsDoc) } } }) });
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) }); // getHub: no settings doc yet
};

const app = await import("../js/app.js");

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  sheetMode = "ok"; hubMode = "ok"; sheetRows = []; settingsDoc = null; queries = [];
  const t = Date.now() - 3600e3;
  serverTickets = [["h-amc", "zyler", "amc", 40, t], ["h-typ", "zyler", "typing", 3, t]];
});

let codeSeq = 0;
// joinHub resets the cache only for a different code, so each test joins its own.
const newCode = () => { const c = "hub-q" + String(++codeSeq).padStart(4, "0") + "-23456-fghjk-mnpqr"; app.joinHub(c); return c; };
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime(); // Nov 2026, local

test("loadKidData ignores app:'amc' events from the hub log (R11)", async () => {
  assert.ok(app.joinHub(CODE));
  const d = await app.loadKidData("zyler");
  assert.equal(d.mix.amc.counted, 0, "AMC comes only from the Sheet (empty here)");
  assert.equal(d.mix.typing.counted, 3);
  assert.ok(!d.recent.some(e => e.app === "amc"));
  assert.equal(d.stale, false);
});

test("a cached amc event in the hub cache is ignored too (R11)", async () => {
  app.joinHub(CODE);
  await app.loadKidData("zyler"); // fills the cache
  hubMode = "hang";
  // poison the cache with an amc event, as an older build might have stored
  const s = JSON.parse(mem["family-hub:v1"]);
  s.cache.hub.events.push({ id: "old-amc", kid: "zyler", app: "amc", tickets: 30, ts: Date.now() - 1000, detail: "" });
  mem["family-hub:v1"] = JSON.stringify(s);
  const d = await app.loadKidData("zyler", Date.now(), 50);
  assert.equal(d.stale, true);
  assert.equal(d.mix.amc.counted, 0);
});

test("a hub that never answers times out: stale, not stuck on Loading", async () => {
  app.joinHub("hub-zzzzz-23456-fghjk-mnpqr"); // a new code starts with an empty cache
  hubMode = "hang";
  const t0 = Date.now();
  const d = await app.loadKidData("zyler", Date.now(), 50);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(d.stale, true);
  assert.equal(d.staleAt, null, "nothing cached yet");
});

// ---------- R26: incremental ticket reads ----------

const day = (now, back) => { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime(); };

test("R26: the first read is a full query from 14 days back; the next 60 s refreshes ask only since yesterday", async () => {
  newCode();
  const t0 = at(3, 16, 30);
  serverTickets = [["a", "zyler", "typing", 2, t0 - 3600e3]];
  await app.loadKidData("zyler", t0);
  assert.deepEqual(queries, [day(t0, 14)]);
  serverTickets.push(["b", "zyler", "typing", 4, t0 + 30e3]);
  const d = await app.loadKidData("zyler", t0 + 60e3);
  assert.deepEqual(queries, [day(t0, 14), day(t0, 1)], "a routine refresh uses the 1-day filter");
  assert.equal(d.mix.typing.counted, 6, "the cached ticket and the new one both count");
  await app.loadKidData("zyler", t0 + 120e3);
  assert.equal(queries[2], day(t0, 1));
});

test("R26: an old ticket stays counted from the cache, and a re-delivered one isn't counted twice", async () => {
  newCode();
  const t0 = at(3, 16, 30);
  serverTickets = [["old", "zyler", "typing", 5, day(t0, 5)], ["yest", "zyler", "typing", 1, day(t0, 1) + 3600e3]];
  await app.loadKidData("zyler", t0);
  const d = await app.loadKidData("zyler", t0 + 60e3); // asks since yesterday: "yest" comes again, "old" doesn't
  assert.equal(d.mix.typing.counted, 6);
  const stored = JSON.parse(mem["family-hub:v1"]).cache.hub;
  assert.deepEqual(stored.events.map(e => e.id).sort(), ["old", "yest"], "merged by id, no duplicates");
});

test("R26: a full refresh runs 6 hours after the last one", async () => {
  newCode();
  const t0 = at(3, 8, 0);
  await app.loadKidData("zyler", t0);
  await app.loadKidData("zyler", t0 + 5.9 * 3600e3);
  assert.deepEqual(queries, [day(t0, 14), day(t0, 1)]);
  const t6 = t0 + 6 * 3600e3;
  await app.loadKidData("zyler", t6);
  assert.deepEqual(queries.slice(2), [day(t6, 14)]);
  await app.loadKidData("zyler", t6 + 60e3);
  assert.equal(queries[3], day(t6, 1), "and routine again right after");
});

test("R26: a full refresh runs when the local day changes, even minutes later", async () => {
  newCode();
  const t0 = at(3, 23, 58);
  await app.loadKidData("zyler", t0);
  const t1 = at(4, 0, 1);
  await app.loadKidData("zyler", t1);
  assert.deepEqual(queries, [day(t0, 14), day(t1, 14)]);
  assert.ok(queries[1] > queries[0], "the window moved forward a day");
});

test("R26: joining a different hub starts with a full read and drops the other hub's events", async () => {
  newCode();
  const t0 = at(3, 16, 30);
  serverTickets = [["a", "zyler", "typing", 2, t0 - 1000]];
  await app.loadKidData("zyler", t0);
  newCode(); // another hub
  serverTickets = [["z", "zyler", "typing", 7, t0 - 500]];
  const d = await app.loadKidData("zyler", t0 + 60e3);
  assert.equal(queries[1], day(t0, 14), "full, not 1-day");
  assert.equal(d.mix.typing.counted, 7, "nothing from the first hub");
});

test("R26: the stored cache entry records its hub code and the time of its last full read", async () => {
  const code = newCode();
  const t0 = at(3, 16, 30);
  await app.loadKidData("zyler", t0);
  await app.loadKidData("zyler", t0 + 60e3);
  const c = JSON.parse(mem["family-hub:v1"]).cache.hub;
  assert.equal(c.code, code);
  assert.equal(c.fullAt, t0, "a routine refresh keeps the full-read time");
  assert.equal(c.at, t0 + 60e3);
});

test("R26: tickets older than the 14-day window age out of the cache on the next full read", async () => {
  newCode();
  const t0 = at(3, 8, 0);
  serverTickets = [["edge", "zyler", "typing", 1, day(t0, 14) + 1000]];
  await app.loadKidData("zyler", t0);
  assert.deepEqual(JSON.parse(mem["family-hub:v1"]).cache.hub.events.map(e => e.id), ["edge"]);
  const t1 = at(4, 8, 0); // next day: the window start moves past "edge"
  serverTickets = [];
  await app.loadKidData("zyler", t1);
  assert.deepEqual(JSON.parse(mem["family-hub:v1"]).cache.hub.events, []);
});

test("R26: if the routine refresh fails, the cached events are used and the screen says stale", async () => {
  newCode();
  const t0 = at(3, 16, 30);
  serverTickets = [["a", "zyler", "typing", 2, t0 - 1000]];
  await app.loadKidData("zyler", t0);
  hubMode = "hang";
  const d = await app.loadKidData("zyler", t0 + 60e3, 50);
  assert.equal(d.stale, true);
  assert.equal(d.staleAt, t0);
  assert.equal(d.mix.typing.counted, 2);
});

// ---------- R20: nothing from before the hub's startedAt counts ----------

const amcRow = (ts, n) => ({ c: [{ v: "x" }, { v: "zyler" }, { v: "answer" }, { v: JSON.stringify({ id: "r" + n + ts, y: 2012, n, a: "A", ok: true, ts, d: "2026-11-03" }) }] });

test("R20: hub tickets and Sheet AMC answers before settings.startedAt are dropped", async () => {
  newCode();
  const t0 = at(3, 16, 30);
  const started = t0 - 2 * 3600e3;
  settingsDoc = { ...DEFAULT_SETTINGS, startedAt: started };
  serverTickets = [["before", "zyler", "typing", 5, started - 1000], ["after", "zyler", "typing", 2, started + 1000], ["exact", "zyler", "typing", 1, started]];
  sheetRows = [amcRow(started - 1000, 10), amcRow(started + 1000, 10)]; // 1 + 0.2*10 = 3 tickets each
  const d = await app.loadKidData("zyler", t0);
  assert.equal(d.mix.typing.counted, 3, "2 + 1, not the 5 from before the start");
  assert.equal(d.mix.amc.counted, 3, "one AMC answer, not two");
});

test("R20: without startedAt (or with a bad one) everything counts, as before", async () => {
  for (const startedAt of [undefined, "later", null]) {
    newCode();
    const t0 = at(3, 16, 30);
    settingsDoc = startedAt === undefined ? { ...DEFAULT_SETTINGS } : { ...DEFAULT_SETTINGS, startedAt };
    serverTickets = [["before", "zyler", "typing", 5, t0 - 5 * 3600e3]];
    sheetRows = [amcRow(t0 - 6 * 3600e3, 10)];
    const d = await app.loadKidData("zyler", t0);
    assert.equal(d.mix.typing.counted, 5);
    assert.equal(d.mix.amc.counted, 3);
  }
});
