import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGviz, countedAnswers, amcQueryUrl, SHEET_ID } from "../js/amc-sheet.js";

// Fixture rows copied from amc8-quest/extension/test/ladder.test.js
const at = (h, m = 0, day = 20) => new Date(2026, 9, day, h, m).getTime();
let seq = 0;
const ans = (kid, n, ok, ts, extra = {}) =>
  ({ kid, type: "answer", info: { id: "a" + ++seq, y: 2010, n, a: "A", ok, t: 30, d: "2026-10-20", ts, ...extra } });
const exam = (y, right, ts) =>
  ({ kid: "zyler", type: "exam", info: { id: "x" + ++seq, y, ans: "-".repeat(25), right, t: 2400, d: "2026-10-20", ts } });

function fixtureRows() {
  const a1 = ans("zyler", 5, true, at(9));
  return [
    ans("zyler", 1, true, at(8)),
    { kid: "zyler", type: "reset", info: { id: "r1", d: "2026-10-20" } },
    a1, a1,
    ans("kadyn", 5, true, at(9)),
    ans("zyler", 6, true, at(10), { y: 2011 }),
    { kid: "zyler", type: "void", info: { id: "v1", y: 2011, n: 6, ts: at(11), d: "2026-10-20" } },
    ans("zyler", 7, false, at(12)),
  ];
}

test("countedAnswers: fixture rows plus one practice-test exam row", () => {
  const evs = [...fixtureRows(), exam(2019, [3, 7], at(13))];
  const got = countedAnswers(evs, "zyler");
  // fixture: #5 right, #7 wrong (reset, dupe, void and kadyn's answer are dropped); exam adds #3 and #7 (right)
  assert.deepEqual(got.map(a => [a.y, a.n, a.ok]), [[2010, 5, true], [2010, 7, false], [2019, 3, true], [2019, 7, true]]);
  assert.equal(got.filter(a => a.ok).length, 3, "3 correct answers earn tickets");
});

test("countedAnswers: a retaken practice test credits each problem once", () => {
  const evs = [...fixtureRows(), exam(2019, [3, 7], at(13)), exam(2019, [3, 7, 9], at(14))];
  const got = countedAnswers(evs, "zyler").filter(a => a.y === 2019);
  assert.deepEqual(got.map(a => a.n), [3, 7, 9]);
});

test("countedAnswers: another kid's rows are not mixed in", () => {
  assert.deepEqual(countedAnswers(fixtureRows(), "kadyn").map(a => a.n), [5]);
});

const gviz = rows => "/*O_o*/\ngoogle.visualization.Query.setResponse(" + JSON.stringify({
  version: "0.6", status: "ok",
  table: { cols: [], rows: rows.map(r => ({ c: r.map(v => (v === null ? null : { v })) })) },
}) + ");";

test("parseGviz reads rows and skips bad ones", () => {
  const evs = parseGviz(gviz([
    ["Date(2026,9,20,15,0,0)", "zyler", "answer", JSON.stringify({ id: "x1", y: 2010, n: 3, ok: true, ts: 5 })],
    ["Date(2026,9,20,15,0,0)", "zyler", "answer", "{not json"],
    ["Date(2026,9,20,15,0,0)", "zyler", "answer", null],
  ]));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].info.id, "x1");
});

test("parseGviz throws on garbage or an error status", () => {
  assert.throws(() => parseGviz("<html>sign in</html>"));
  assert.throws(() => parseGviz('google.visualization.Query.setResponse({"status":"error","errors":[]});'));
});

test("amcQueryUrl filters by the lowercase kid id and names the JSONP callback", () => {
  const u = new URL(amcQueryUrl("zyler", "cb1", 123));
  assert.equal(u.pathname, `/spreadsheets/d/${SHEET_ID}/gviz/tq`);
  assert.equal(u.searchParams.get("tq"), "select * where B='zyler'");
  assert.equal(u.searchParams.get("tqx"), "responseHandler:cb1");
  assert.throws(() => amcQueryUrl("zy'ler", "cb1", 1));
});
