// SHARED FILE: copied verbatim into the hub and the learning apps (AMC, French, Typing, Spelling).
// Keep it self-contained: no imports, no DOM, no Chrome APIs. Only fetch, crypto and the storage
// object handed to createOutbox. Firestore REST (project sharpe-family), no SDK, no sign-in: the hub
// code is the secret, and firestore.rules only allow get/create/update on hubs/{code} and
// get/list/create (never update or delete) on hubs/{code}/tickets/{id}.
//
// Ticket event (shared contract):
//   { id, kid: 'zyler'|'kadyn', app: 'amc'|'french'|'typing'|'spelling', tickets: int >= 1, ts: ms, detail: string <= 80 }
// `id` is the Firestore doc id, so creating the same id twice is a no-op (ALREADY_EXISTS).

export const HUB_API = 'https://firestore.googleapis.com/v1/projects/sharpe-family/databases/(default)/documents';

export class HubConflict extends Error {
  constructor(message = 'The hub changed on another device') { super(message); this.name = 'HubConflict'; }
}

const clone = x => JSON.parse(JSON.stringify(x));

// ---------- codes ----------

// Same alphabet and shape as mamou-french's makeFamilyCode, with a hub- prefix.
export function makeHubCode(rand = n => crypto.getRandomValues(new Uint8Array(n))) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = rand(20);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `hub-${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}

export function isHubCode(s) {
  return typeof s === 'string' && /^hub-[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}$/.test(s);
}

// Parses '#hub=<code>&kid=<kidId>'. Null unless the code is a hub code. A missing or odd kid is null.
export function readHandoff(hash) {
  const q = String(hash == null ? '' : hash).replace(/^#/, '');
  let params;
  try { params = new URLSearchParams(q); } catch { return null; }
  const code = params.get('hub');
  if (!isHubCode(code)) return null;
  const kid = params.get('kid');
  return { code, kid: kid && /^[\w-]{1,40}$/.test(kid) ? kid : null };
}

// ---------- settings (same rule as balance.js effectiveSettings) ----------

function localDayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// The settings that apply at `now`: the pending ones once their day has started (local midnight).
// Always a fresh copy. tests/hub-client.test.js checks this stays identical to balance.js.
export function effectiveSettings(doc, now) {
  const p = doc && doc.pending;
  if (p && p.settings && typeof p.effectiveFrom === 'string' && p.effectiveFrom <= localDayKey(now)) {
    return { ...clone(p.settings), pending: null };
  }
  return doc == null ? doc : clone(doc);
}

// ---------- hub doc: hubs/{code} with data (JSON string), v, updated ----------

const hubUrl = code => `${HUB_API}/hubs/${encodeURIComponent(code)}`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// A conflicting write answers 409 or 400 with FAILED_PRECONDITION / ALREADY_EXISTS.
async function errorStatus(res) {
  const j = await res.json().catch(() => ({}));
  return (j && j.error && j.error.status) || '';
}

export async function getHub(code) {
  const res = await fetch(hubUrl(code), { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`hub get ${res.status}`);
  const j = await res.json();
  return { settings: JSON.parse(j.fields.data.stringValue), updateTime: j.updateTime };
}

// Writes the settings only if nobody wrote since `updateTime` (null = create; fails if it exists).
// Resolves to the new updateTime. Throws HubConflict when someone else wrote first.
export async function putHub(code, settings, updateTime) {
  const pre = updateTime ? `currentDocument.updateTime=${encodeURIComponent(updateTime)}` : 'currentDocument.exists=false';
  const body = { fields: {
    data: { stringValue: JSON.stringify(settings) },
    v: { integerValue: String((settings && settings.v) || 1) },
    updated: { integerValue: String(Date.now()) },
  } };
  const res = await fetch(`${hubUrl(code)}?${pre}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (res.status === 400 || res.status === 409) {
    const st = await errorStatus(res);
    if (st === 'FAILED_PRECONDITION' || st === 'ALREADY_EXISTS') throw new HubConflict();
  }
  if (!res.ok) throw new Error(`hub put ${res.status}`);
  return (await res.json()).updateTime;
}

// ---------- tickets: hubs/{code}/tickets/{id} ----------

const cmpTickets = (a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Events with ts >= sinceTs, sorted by (ts, id). The query has no orderBy, so it needs no composite
// index; the sort happens here. Resolves to [{ id, kid, app, tickets, ts, detail }].
export async function listTickets(code, sinceTs) {
  const body = { structuredQuery: {
    from: [{ collectionId: 'tickets' }],
    where: { fieldFilter: { field: { fieldPath: 'ts' }, op: 'GREATER_THAN_OR_EQUAL', value: { integerValue: String(Math.trunc(Number(sinceTs) || 0)) } } },
  } };
  const res = await fetch(`${hubUrl(code)}:runQuery`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`tickets list ${res.status}`);
  const rows = await res.json();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const d = row && row.document;
    if (!d || !d.fields) continue; // a query with no hits answers [{ readTime }]
    const f = d.fields;
    const id = String(d.name).slice(String(d.name).lastIndexOf('/') + 1);
    out.push({
      id,
      kid: f.kid ? f.kid.stringValue : '',
      app: f.app ? f.app.stringValue : '',
      tickets: Number(f.tickets && f.tickets.integerValue),
      ts: Number(f.ts && f.ts.integerValue),
      detail: f.detail && typeof f.detail.stringValue === 'string' ? f.detail.stringValue : '',
    });
  }
  return out.sort(cmpTickets);
}

// ---------- outbox: pending ticket events, persisted so a closed tab or lost network loses nothing ----------

const KIDS = ['zyler', 'kadyn'];
const APP_IDS = ['amc', 'french', 'typing', 'spelling'];

// The rules allow at most 80 characters; cut by code points so an emoji is never split in half.
const clip = detail => Array.from(String(detail == null ? '' : detail)).slice(0, 80).join('');

// Does the event meet the shared ticket contract (and the rules, and Firestore's doc id limits)?
function validEvent(e) {
  return !!e && typeof e === 'object'
    && typeof e.id === 'string' && e.id !== '' && e.id !== '.' && e.id !== '..' && !e.id.includes('/') && !/^__.*__$/.test(e.id)
    && KIDS.includes(e.kid) && APP_IDS.includes(e.app)
    && Number.isInteger(e.tickets) && e.tickets >= 1 && e.tickets <= 200
    && Number.isFinite(e.ts) && Number.isInteger(e.ts)
    && typeof e.detail === 'string';
}

function ticketFields(e) {
  return {
    kid: { stringValue: String(e.kid) },
    app: { stringValue: String(e.app) },
    tickets: { integerValue: String(Math.round(Number(e.tickets))) },
    ts: { integerValue: String(Math.round(Number(e.ts))) },
    detail: { stringValue: clip(e.detail) },
  };
}

// `storage` has getItem/setItem (localStorage or a stub). Events stay queued under `key` until the
// hub confirms them. Sending the same id twice is harmless: the second create answers ALREADY_EXISTS.
export function createOutbox(storage, key) {
  let mem = []; // used if storage is unreadable or full
  let dirty = false; // the last write to storage failed, so `mem` is newer than what storage holds
  let inFlight = null;

  function load() {
    if (dirty) return mem; // storage is stale: never let it overwrite events only memory has
    try {
      const raw = storage.getItem(key);
      if (raw == null) return mem;
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return (mem = list.filter(e => e && typeof e.id === 'string'));
    } catch { /* corrupt or unavailable: fall back to memory */ }
    return mem;
  }
  function save(list) {
    mem = list;
    try { storage.setItem(key, JSON.stringify(list)); dirty = false; } catch { dirty = true; /* full or private mode: the memory copy is the truth until a write works */ }
  }

  // Queues an event. Returns false (and does nothing) if it breaks the shared contract: kid or app not
  // known, tickets not an integer 1..200, ts not an integer, detail not a string, or an id that is empty,
  // contains '/', or looks like __x__. Returns true if it was queued or its id is already pending (the
  // first one wins). detail is cut to 80 characters before it is stored.
  function add(event) {
    if (!validEvent(event)) return false;
    const list = load();
    if (list.some(e => e.id === event.id)) return true;
    save([...list, { ...clone(event), detail: clip(event.detail) }]);
    return true;
  }

  function pending() { return clone(load()); }

  async function sendOne(code, e) {
    try {
      const res = await fetch(`${HUB_API}/hubs/${encodeURIComponent(code)}/tickets/${encodeURIComponent(e.id)}?currentDocument.exists=false`, {
        // keepalive: a flush started as the tab closes still reaches Firestore.
        method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ fields: ticketFields(e) }), keepalive: true,
      });
      if (res.ok) return true;
      if (res.status === 409 || res.status === 400) return (await errorStatus(res)) === 'ALREADY_EXISTS';
      return false;
    } catch { return false; }
  }

  async function run(code) {
    const batch = load().slice();
    const done = new Set();
    let failed = 0;
    for (const e of batch) {
      if (await sendOne(code, e)) done.add(e.id); else failed++;
    }
    // Re-read: events added while we were sending stay queued.
    if (done.size || dirty) save(load().filter(e => !done.has(e.id))); // also retries a failed write
    return { sent: done.size, failed };
  }

  // Sends every pending event. One flush at a time: callers during a flush share its result.
  // Resolves to { sent, failed }; failed events stay queued for the next flush.
  function flush(code) {
    if (!code) return Promise.resolve({ sent: 0, failed: 0 });
    if (inFlight) return inFlight;
    inFlight = run(code).finally(() => { inFlight = null; });
    return inFlight;
  }

  return { add, flush, pending };
}
