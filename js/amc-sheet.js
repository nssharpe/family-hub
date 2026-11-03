// AMC 8 Quest answers, read from its Google Sheet for the hub.
//
// `parseGviz` and `countedAnswers` are copied VERBATIM from
// amc8-quest/extension/src/lib/ladder.js (the Streaming Lock extension), so the hub and the
// extension count the same answers. Everything below them is hub-only: the page can't fetch the
// Sheet (no CORS), so it reads it by JSONP, the way amc8-quest/index.html does.
// Import-safe in node: nothing here touches the DOM until amcAnswers() runs.

export const SHEET_ID = "1psoHNlkBsdd8Z2QMehLn-iaPsFBmzduSubO3i1BjNo0";

// ---- verbatim from amc8-quest/extension/src/lib/ladder.js ----

// Parses the Sheets gviz JSON response. Columns: [timestamp, kid, type, infoJSON].
export function parseGviz(text) {
  const start = text.indexOf("setResponse(");
  const end = text.lastIndexOf(")");
  if (start < 0 || end < start) throw new Error("Unexpected response from Google Sheets.");
  const resp = JSON.parse(text.slice(start + "setResponse(".length, end));
  if (resp.status !== "ok" || !resp.table) throw new Error("Google Sheets returned an error.");
  const out = [];
  for (const row of resp.table.rows || []) {
    const cells = (row.c || []).map(c => (c ? c.v : null));
    try {
      const info = JSON.parse(cells[3]);
      if (info && typeof info === "object" && typeof info.id === "string" && typeof cells[1] === "string" && typeof cells[2] === "string") {
        out.push({ kid: cells[1], type: cells[2], info });
      }
    } catch {}
  }
  return out;
}

// Same semantics as foldKid in index.html: drop everything before the kid's
// last reset, drop answers voided by a later void, dedupe by event id.
export function countedAnswers(events, kid) {
  const seen = new Set();
  const evs = [];
  for (const e of events) {
    if (e.kid !== kid || seen.has(e.info.id)) continue;
    seen.add(e.info.id);
    evs.push(e);
  }
  let lastReset = -1;
  evs.forEach((e, i) => { if (e.type === "reset") lastReset = i; });
  const live = evs.slice(lastReset + 1);
  const voids = live.filter(e => e.type === "void").map(e => e.info);
  const isVoided = a => voids.some(v => v.y === a.y && v.n === a.n && (a.ts ? a.ts < v.ts : a.d <= v.d));
  const out = [];
  const credited = new Set(); // practice-test problems already counted (retakes don't count twice)
  for (const e of live) {
    if (e.type === "answer") {
      if (Number.isInteger(e.info.n) && typeof e.info.ok === "boolean" && !isVoided(e.info))
        out.push({ y: e.info.y, n: e.info.n, ok: e.info.ok, ts: e.info.ts });
    } else if (e.type === "exam" && Array.isArray(e.info.right)) {
      // a handed-in practice test: each correct problem counts as a correct answer at hand-in time
      for (const n of e.info.right) {
        const key = e.info.y + "-" + n;
        if (!Number.isInteger(n) || n < 1 || n > 25 || credited.has(key)) continue;
        credited.add(key);
        out.push({ y: e.info.y, n, ok: true, ts: e.info.ts });
      }
    }
  }
  return out;
}

// ---- hub-only: the JSONP read ----

// The Sheet's kid column holds the AMC kid id ('zyler', 'kadyn'): the same id the extension
// puts in its query and the hub uses in settings.kids. The id goes into a query, so keep it plain.
export function amcQueryUrl(kid, callback, nonce) {
  if (!/^[\w-]{1,40}$/.test(String(kid))) throw new Error("Unexpected kid id.");
  const tq = encodeURIComponent("select * where B='" + kid + "'");
  return "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/gviz/tq?tqx=responseHandler:" + callback +
    "&headers=1&tq=" + tq + "&_=" + nonce;
}

let seq = 0;

// Resolves to the kid's counted answers [{ y, n, ok, ts }]; rejects if the Sheet can't be read in 12 s.
export function amcAnswers(kid, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const cb = "__hubAmc" + (++seq);
    let done = false, timer = null;
    const script = document.createElement("script");
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      delete window[cb];
      script.remove();
      if (err) reject(err); else resolve(value);
    };
    window[cb] = resp => {
      try {
        // JSONP hands us the parsed payload; parseGviz wants the text form, so wrap it back.
        finish(null, countedAnswers(parseGviz("setResponse(" + JSON.stringify(resp) + ")"), kid));
      } catch (e) { finish(e); }
    };
    script.src = amcQueryUrl(kid, cb, Date.now());
    script.onerror = () => finish(new Error("Couldn't reach Google Sheets."));
    timer = setTimeout(() => finish(new Error("Google Sheets took too long.")), timeoutMs);
    document.body.appendChild(script);
  });
}
