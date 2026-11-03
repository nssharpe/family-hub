import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  HUB_API, HubConflict, makeHubCode, isHubCode, getHub, putHub, listTickets,
  createOutbox, readHandoff, effectiveSettings,
} from "../js/hub-client.js";
import * as balance from "../js/balance.js";

const CODE = "hub-abcde-fghij-kmnop-qrstu";
const realFetch = globalThis.fetch;
let calls; // recorded requests
let handler; // (call) => Response, or throws

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const already = () => json(409, { error: { code: 409, status: "ALREADY_EXISTS", message: "Document already exists" } });
const storageStub = () => {
  const m = new Map();
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
};
const ev = (n, over = {}) => ({ id: `french:p-zyler:${1730000000000 + n}`, kid: "zyler", app: "french", tickets: 2, ts: 1730000000000 + n, detail: `card ${n}`, ...over });

beforeEach(() => {
  calls = [];
  handler = () => json(200, {});
  globalThis.fetch = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || "GET", headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    return handler(call);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

// ---------- codes ----------

test("makeHubCode: hub- prefix, four groups of five, same alphabet as makeFamilyCode", () => {
  const code = makeHubCode(n => new Uint8Array(n).map((_, i) => i));
  assert.match(code, /^hub-[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}$/);
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  assert.equal(code, "hub-" + [0, 5, 10, 15].map(o => Array.from({ length: 5 }, (_, i) => alphabet[(o + i) % alphabet.length]).join("")).join("-"));
  assert.ok(isHubCode(makeHubCode()));
  assert.notEqual(makeHubCode(), makeHubCode());
});

test("isHubCode matches exactly the hub code shape", () => {
  assert.equal(isHubCode(CODE), true);
  for (const bad of ["", null, undefined, 5, "mamou-abcde-fghij-kmnop-qrstu", "hub-abcde-fghij-kmnop", "hub-abcde-fghij-kmnop-qrstuv",
    "hub-ABCDE-fghij-kmnop-qrstu", " " + CODE, CODE + " ", CODE + "\n", "xhub-abcde-fghij-kmnop-qrstu"]) {
    assert.equal(isHubCode(bad), false, JSON.stringify(bad));
  }
});

// ---------- handoff ----------

test("readHandoff parses #hub=…&kid=…", () => {
  assert.deepEqual(readHandoff("#hub=hub-abcde-fghij-kmnop-qrstu&kid=zyler"), { code: CODE, kid: "zyler" });
  assert.deepEqual(readHandoff("#kid=p-kadyn&hub=" + CODE), { code: CODE, kid: "p-kadyn" });
  assert.deepEqual(readHandoff("hub=" + CODE + "&kid=zyler"), { code: CODE, kid: "zyler" });
});

test("readHandoff: bad or missing code gives null; missing or odd kid gives kid null", () => {
  assert.equal(readHandoff("#hub=hub-abc&kid=zyler"), null);
  assert.equal(readHandoff("#hub=mamou-abcde-fghij-kmnop-qrstu&kid=zyler"), null);
  assert.equal(readHandoff("#kid=zyler"), null);
  assert.equal(readHandoff(""), null);
  assert.equal(readHandoff(null), null);
  assert.equal(readHandoff("#import=abc"), null);
  assert.deepEqual(readHandoff("#hub=" + CODE), { code: CODE, kid: null });
  assert.deepEqual(readHandoff("#hub=" + CODE + "&kid=a%2Fb%20c"), { code: CODE, kid: null });
});

// ---------- hub doc ----------

test("getHub: 404 is null, 200 parses the settings and returns updateTime", async () => {
  handler = () => json(404, { error: { status: "NOT_FOUND" } });
  assert.equal(await getHub(CODE), null);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].url, `${HUB_API}/hubs/${CODE}`);

  const settings = { v: 1, baseline: 150, pending: null };
  handler = () => json(200, { name: "x", fields: { data: { stringValue: JSON.stringify(settings) }, v: { integerValue: "1" }, updated: { integerValue: "5" } }, updateTime: "2026-11-03T10:00:00.123456Z" });
  assert.deepEqual(await getHub(CODE), { settings, updateTime: "2026-11-03T10:00:00.123456Z" });

  handler = () => json(500, {});
  await assert.rejects(getHub(CODE), /500/);
});

test("putHub creates with exists=false and updates with the updateTime precondition", async () => {
  handler = () => json(200, { updateTime: "T1" });
  const settings = { v: 3, baseline: 150 };
  assert.equal(await putHub(CODE, settings, null), "T1");
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].url, `${HUB_API}/hubs/${CODE}?currentDocument.exists=false`);
  assert.deepEqual(Object.keys(calls[0].body.fields).sort(), ["data", "updated", "v"]);
  assert.deepEqual(JSON.parse(calls[0].body.fields.data.stringValue), settings);
  assert.equal(calls[0].body.fields.v.integerValue, "3");
  assert.match(calls[0].body.fields.updated.integerValue, /^\d+$/);

  await putHub(CODE, settings, "2026-11-03T10:00:00.123456Z");
  assert.equal(calls[1].url, `${HUB_API}/hubs/${CODE}?currentDocument.updateTime=${encodeURIComponent("2026-11-03T10:00:00.123456Z")}`);
  assert.equal(calls[1].headers["Content-Type"], "application/json");
});

test("putHub throws HubConflict on FAILED_PRECONDITION / ALREADY_EXISTS, a plain Error otherwise", async () => {
  handler = () => json(400, { error: { status: "FAILED_PRECONDITION" } });
  await assert.rejects(putHub(CODE, {}, "T"), e => e instanceof HubConflict);
  handler = already;
  await assert.rejects(putHub(CODE, {}, null), e => e instanceof HubConflict);
  handler = () => json(400, { error: { status: "INVALID_ARGUMENT" } });
  await assert.rejects(putHub(CODE, {}, "T"), e => !(e instanceof HubConflict) && /400/.test(e.message));
  handler = () => json(403, { error: { status: "PERMISSION_DENIED" } });
  await assert.rejects(putHub(CODE, {}, "T"), e => !(e instanceof HubConflict) && /403/.test(e.message));
});

// ---------- listTickets ----------

const tdoc = (id, t) => ({
  document: {
    name: `projects/sharpe-family/databases/(default)/documents/hubs/${CODE}/tickets/${id}`,
    fields: { kid: { stringValue: t.kid }, app: { stringValue: t.app }, tickets: { integerValue: String(t.tickets) }, ts: { integerValue: String(t.ts) }, detail: { stringValue: t.detail } },
  },
  readTime: "x",
});

test("listTickets sends a runQuery with ts >= sinceTs and maps results back", async () => {
  const a = ev(1);
  const b = ev(2, { id: "amc:2023:5:1730000000002", app: "amc", kid: "kadyn", tickets: 7, detail: "AMC 8 2023 #5" });
  handler = () => json(200, [tdoc(a.id, a), tdoc(b.id, b)]);
  const out = await listTickets(CODE, 1730000000000);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${HUB_API}/hubs/${CODE}:runQuery`);
  assert.deepEqual(calls[0].body, {
    structuredQuery: {
      from: [{ collectionId: "tickets" }],
      where: { fieldFilter: { field: { fieldPath: "ts" }, op: "GREATER_THAN_OR_EQUAL", value: { integerValue: "1730000000000" } } },
    },
  });
  assert.deepEqual(out, [a, b]);
  assert.equal(typeof out[0].tickets, "number");
  assert.equal(typeof out[0].ts, "number");
});

test("listTickets sorts by (ts, id), skips rows without a document, and handles an empty result", async () => {
  const t1 = ev(5, { id: "b", ts: 100 }), t2 = ev(6, { id: "a", ts: 100 }), t3 = ev(7, { id: "c", ts: 50 });
  handler = () => json(200, [tdoc("b", t1), { readTime: "r" }, tdoc("a", t2), tdoc("c", t3)]);
  assert.deepEqual((await listTickets(CODE, 0)).map(t => t.id), ["c", "a", "b"]);
  handler = () => json(200, [{ readTime: "r" }]);
  assert.deepEqual(await listTickets(CODE, 0), []);
  handler = () => json(500, {});
  await assert.rejects(listTickets(CODE, 0), /500/);
});

test("listTickets keeps ids with colons intact (document name last segment)", async () => {
  const t = ev(1);
  handler = () => json(200, [tdoc(t.id, t)]);
  assert.equal((await listTickets(CODE, 0))[0].id, t.id);
});

// ---------- outbox ----------

test("outbox.flush PATCHes each ticket with exists=false and an encoded id, then empties", async () => {
  const st = storageStub();
  const ob = createOutbox(st, "k");
  handler = () => json(200, {});
  const e1 = ev(1), e2 = ev(2);
  ob.add(e1); ob.add(e2);
  assert.deepEqual(await ob.flush(CODE), { sent: 2, failed: 0 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "PATCH");
  assert.equal(calls[0].url, `${HUB_API}/hubs/${CODE}/tickets/${encodeURIComponent(e1.id)}?currentDocument.exists=false`);
  assert.match(calls[0].url, /french%3Ap-zyler%3A1730000000001\?/);
  assert.deepEqual(calls[0].body, {
    fields: { kid: { stringValue: "zyler" }, app: { stringValue: "french" }, tickets: { integerValue: "2" }, ts: { integerValue: String(e1.ts) }, detail: { stringValue: "card 1" } },
  });
  assert.deepEqual(ob.pending(), []);
  assert.equal(JSON.parse(st.m.get("k")).length, 0);
});

test("outbox duplicate safety: re-sending already-created ids reports sent and empties pending", async () => {
  const ob = createOutbox(storageStub(), "k");
  const e1 = ev(1), e2 = ev(2);
  ob.add(e1); ob.add(e2);
  handler = () => json(200, {});
  assert.deepEqual(await ob.flush(CODE), { sent: 2, failed: 0 });
  // The same events come around again (e.g. the app re-reported after a lost response).
  ob.add(e1); ob.add(e2);
  assert.equal(ob.pending().length, 2);
  handler = already;
  assert.deepEqual(await ob.flush(CODE), { sent: 2, failed: 0 });
  assert.deepEqual(ob.pending(), []);
});

test("outbox treats 400 ALREADY_EXISTS as sent too", async () => {
  const ob = createOutbox(storageStub(), "k");
  ob.add(ev(1));
  handler = () => json(400, { error: { status: "ALREADY_EXISTS" } });
  assert.deepEqual(await ob.flush(CODE), { sent: 1, failed: 0 });
  assert.deepEqual(ob.pending(), []);
});

test("outbox persistence: a throwing fetch leaves events pending, persisted under the key", async () => {
  const st = storageStub();
  const ob = createOutbox(st, "family-hub:outbox");
  ob.add(ev(1)); ob.add(ev(2));
  handler = () => { throw new TypeError("offline"); };
  assert.deepEqual(await ob.flush(CODE), { sent: 0, failed: 2 });
  assert.equal(ob.pending().length, 2);
  assert.deepEqual(JSON.parse(st.m.get("family-hub:outbox")).map(e => e.id), [ev(1).id, ev(2).id]);
  // A fresh outbox over the same storage (page reload) sees them and can send them.
  const ob2 = createOutbox(st, "family-hub:outbox");
  assert.equal(ob2.pending().length, 2);
  handler = () => json(200, {});
  assert.deepEqual(await ob2.flush(CODE), { sent: 2, failed: 0 });
  assert.deepEqual(createOutbox(st, "family-hub:outbox").pending(), []);
});

test("outbox keeps rejected and server-error events pending, sends the rest", async () => {
  const ob = createOutbox(storageStub(), "k");
  const e1 = ev(1), e2 = ev(2), e3 = ev(3);
  ob.add(e1); ob.add(e2); ob.add(e3);
  handler = c => {
    if (c.url.includes(encodeURIComponent(e1.id))) return json(500, {});
    if (c.url.includes(encodeURIComponent(e2.id))) return json(403, { error: { status: "PERMISSION_DENIED" } });
    return json(200, {});
  };
  assert.deepEqual(await ob.flush(CODE), { sent: 1, failed: 2 });
  assert.deepEqual(ob.pending().map(e => e.id), [e1.id, e2.id]);
});

test("outbox.add ignores an id that is already pending", () => {
  const ob = createOutbox(storageStub(), "k");
  assert.equal(ob.add(ev(1)), true);
  assert.equal(ob.add(ev(1, { tickets: 9 })), false);
  assert.equal(ob.pending().length, 1);
  assert.equal(ob.pending()[0].tickets, 2);
  assert.equal(ob.add(null), false);
  assert.equal(ob.add({ kid: "zyler" }), false);
});

test("outbox.pending returns copies, so callers cannot corrupt the queue", () => {
  const ob = createOutbox(storageStub(), "k");
  ob.add(ev(1));
  ob.pending()[0].tickets = 999;
  ob.pending().pop();
  assert.equal(ob.pending().length, 1);
  assert.equal(ob.pending()[0].tickets, 2);
});

test("outbox survives corrupt or missing storage", async () => {
  const st = storageStub();
  st.m.set("k", "{not json");
  const ob = createOutbox(st, "k");
  assert.deepEqual(ob.pending(), []);
  ob.add(ev(1));
  assert.equal(ob.pending().length, 1);
  st.m.set("k2", JSON.stringify({ not: "an array" }));
  assert.deepEqual(createOutbox(st, "k2").pending(), []);
  // setItem throwing (quota / private mode) must not break add or flush
  const bad = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  const ob3 = createOutbox(bad, "k");
  assert.equal(ob3.add(ev(1)), true);
  handler = () => json(200, {});
  assert.deepEqual(await ob3.flush(CODE), { sent: 1, failed: 0 });
  assert.deepEqual(ob3.pending(), []);
});

test("concurrent flush calls coalesce into one in-flight flush (no double send)", async () => {
  const ob = createOutbox(storageStub(), "k");
  ob.add(ev(1)); ob.add(ev(2));
  let release;
  const gate = new Promise(r => { release = r; });
  handler = async () => { await gate; return json(200, {}); };
  const p1 = ob.flush(CODE);
  const p2 = ob.flush(CODE);
  const p3 = ob.flush(CODE);
  release();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(calls.length, 2, "each ticket is sent exactly once");
  assert.deepEqual(r1, { sent: 2, failed: 0 });
  assert.deepEqual(r2, r1);
  assert.deepEqual(r3, r1);
  // after it settles, a new flush starts a new run
  ob.add(ev(3));
  handler = () => json(200, {});
  assert.deepEqual(await ob.flush(CODE), { sent: 1, failed: 0 });
  assert.equal(calls.length, 3);
});

test("an event added during a flush is kept (and sent by the next flush)", async () => {
  const ob = createOutbox(storageStub(), "k");
  ob.add(ev(1));
  let release;
  const gate = new Promise(r => { release = r; });
  handler = async () => { await gate; return json(200, {}); };
  const p = ob.flush(CODE);
  ob.add(ev(2));
  release();
  assert.deepEqual(await p, { sent: 1, failed: 0 });
  assert.deepEqual(ob.pending().map(e => e.id), [ev(2).id]);
  handler = () => json(200, {});
  assert.deepEqual(await ob.flush(CODE), { sent: 1, failed: 0 });
});

test("flush with an empty queue makes no request; flush without a code sends nothing", async () => {
  const ob = createOutbox(storageStub(), "k");
  assert.deepEqual(await ob.flush(CODE), { sent: 0, failed: 0 });
  ob.add(ev(1));
  assert.deepEqual(await ob.flush(""), { sent: 0, failed: 0 });
  assert.deepEqual(await ob.flush(null), { sent: 0, failed: 0 });
  assert.equal(calls.length, 0);
  assert.equal(ob.pending().length, 1);
});

test("flush truncates detail to 80 chars so the rules never reject it", async () => {
  const ob = createOutbox(storageStub(), "k");
  ob.add(ev(1, { detail: "x".repeat(200) }));
  handler = () => json(200, {});
  await ob.flush(CODE);
  assert.equal(calls[0].body.fields.detail.stringValue.length, 80);
});

// ---------- effectiveSettings parity with balance.js (ruling R1) ----------

test("effectiveSettings matches balance.effectiveSettings before and after local midnight", () => {
  const next = { ...balance.DEFAULT_SETTINGS, baseline: 99, pending: null };
  const doc = { ...balance.DEFAULT_SETTINGS, pending: { effectiveFrom: "2026-11-04", settings: next } };
  const before = new Date(2026, 10, 3, 23, 59, 59, 999).getTime();
  const after = new Date(2026, 10, 4, 0, 0, 0, 0).getTime();
  for (const now of [before, after, after + 3600e3, before - 86400e3]) {
    assert.deepEqual(effectiveSettings(doc, now), balance.effectiveSettings(doc, now), String(now));
  }
  assert.equal(effectiveSettings(doc, before).baseline, 150);
  assert.equal(effectiveSettings(doc, after).baseline, 99);
  assert.equal(effectiveSettings(doc, after).pending, null);
  // fresh copies, null passthrough
  const a = effectiveSettings(doc, before);
  a.kids.zyler.name = "changed";
  assert.equal(doc.kids.zyler.name, "Zyler");
  assert.equal(effectiveSettings(null, before), null);
  assert.equal(effectiveSettings(undefined, before), undefined);
  const noPending = effectiveSettings(balance.DEFAULT_SETTINGS, before);
  assert.deepEqual(noPending, balance.DEFAULT_SETTINGS);
  assert.notEqual(noPending, balance.DEFAULT_SETTINGS);
});
