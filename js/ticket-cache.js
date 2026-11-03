// Incremental reads of the hub's ticket log (R26). Tickets are immutable and create-only, so the events
// we fetched stay valid: keep them, ask only for the recent ones on a routine refresh, and do the
// full 14-day query rarely. A page left open polls every few minutes, and a full query every poll would
// burn the Firestore free read quota. Pure: no DOM, no storage, no network.

import { ticketsSince, localDayKey } from "./balance.js";

export const FULL_REFRESH_MS = 6 * 60 * 60 * 1000;

// Local midnight at the start of yesterday: the lower bound of a routine refresh. DST-safe.
export function incrementalSince(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime();
}

// `cache` is { code, events, at, fullAt } or null. A full fetch is needed when there is no usable cache,
// it belongs to another hub, its last full fetch was 6 hours ago or on another local day (or lies in
// the future, after a clock change).
export function needsFullRefresh(cache, code, now) {
  if (!cache || cache.code !== code || !Array.isArray(cache.events)) return true;
  const full = cache.fullAt;
  if (typeof full !== "number" || !Number.isFinite(full)) return true;
  if (full > now || now - full >= FULL_REFRESH_MS) return true;
  return localDayKey(full) !== localDayKey(now);
}

// Cached events plus fetched ones, one per id (the fetched copy wins), without anything older than
// ticketsSince(now), sorted by (ts, id).
export function mergeEvents(cached, fetched, now) {
  const from = ticketsSince(now);
  const byId = new Map();
  for (const list of [cached, fetched]) {
    for (const e of list || []) if (e && typeof e.id === "string" && e.ts >= from) byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// One refresh. `fetchSince(sinceTs)` resolves to the events with ts >= sinceTs (a Promise that may reject).
// Resolves to { events, cache }: the events to count and the cache entry to store. A rejection passes through,
// so the caller falls back to its old cache.
export async function refreshTickets(cache, code, now, fetchSince) {
  const full = needsFullRefresh(cache, code, now);
  const fetched = await fetchSince(full ? ticketsSince(now) : incrementalSince(now));
  const events = mergeEvents(full ? [] : cache.events, fetched, now);
  return { events, cache: { code, events, at: now, fullAt: full ? now : cache.fullAt } };
}
