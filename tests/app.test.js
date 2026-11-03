import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const CODE = "hub-abcde-23456-fghjk-mnpqr";
const mem = {};
globalThis.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };

// A fake page for the JSONP read: appending the script calls the callback with `sheetRows` (or never).
let sheetMode;
globalThis.window = globalThis;
globalThis.document = {
  body: { appendChild(script) {
    const cb = new URL(script.src).searchParams.get("tqx").split(":")[1];
    if (sheetMode === "hang") return;
    setTimeout(() => globalThis[cb] && globalThis[cb]({ status: "ok", table: { rows: [] } }), 0);
  } },
  createElement: () => ({ remove() {} }),
};

const fsTicket = (id, kid, app, tickets, ts) => ({ document: { name: `projects/p/databases/(default)/documents/hubs/${CODE}/tickets/${id}`, fields: {
  kid: { stringValue: kid }, app: { stringValue: app }, tickets: { integerValue: String(tickets) }, ts: { integerValue: String(ts) }, detail: { stringValue: "" } } } });

let hubMode;
globalThis.fetch = (url, init = {}) => {
  if (hubMode === "hang") return new Promise(() => {});
  if (String(url).endsWith(":runQuery")) {
    const t = Date.now() - 3600e3;
    return Promise.resolve({ ok: true, status: 200, json: async () => [fsTicket("h-amc", "zyler", "amc", 40, t), fsTicket("h-typ", "zyler", "typing", 3, t)] });
  }
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) }); // getHub: no settings doc yet
};

const app = await import("../js/app.js");

beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k]; sheetMode = "ok"; hubMode = "ok"; });

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
