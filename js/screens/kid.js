// #/kid/<id> : TV minutes earned today, this week's mix per app, app tiles, recent tickets.
import { h } from "../dom.js";
import { APPS } from "../balance.js";
import { getHubCode, getSettings, loadKidData } from "../app.js";
import { APP_INFO, STATUS_LABEL, appHref, bestPick, tileNote, recentLine, nextUnlock, clockLabel } from "../view-model.js";

const REFRESH_MS = 60000;

const pct = x => Math.round(x * 100);

function hero(d) {
  const { ladder } = d;
  const next = nextUnlock(d.settings, ladder);
  return h("section", { class: "hero", "aria-labelledby": "hero-label" },
    h("p", { class: "hero-label", id: "hero-label" }, "TV minutes earned today"),
    h("p", { class: "hero-num" }, String(ladder.earnedMinutes)),
    h("p", { class: "hero-next" },
      `${next.left} more ${next.left === 1 ? "ticket" : "tickets"} for the next unlock`,
      next.minutes ? ` (+${next.minutes} min)` : ""));
}

function mixRow(app, m, name) {
  const off = m.max === 0;
  const share = pct(m.share);
  const label = off
    ? `${APP_INFO[app].name} is off this week`
    : `${APP_INFO[app].name}: ${share}% of this week’s tickets, aim for ${m.min} to ${m.max}%. ${STATUS_LABEL[m.status]}.`;
  const marker = Math.min(99, Math.max(1, m.share * 100)); // keep the mark inside the bar
  return h("li", { class: "mix-row" },
    h("div", { class: "mix-top" },
      h("span", { class: "mix-name" }, APP_INFO[app].name),
      h("span", { class: `chip chip-${m.status}` }, STATUS_LABEL[m.status])),
    h("div", { class: "bar", role: "img", "aria-label": label },
      !off && h("span", { class: "band", style: `left:${m.min}%;width:${m.max - m.min}%` }),
      h("span", { class: "mark", style: `left:${marker}%` })),
    h("p", { class: "mix-note" },
      off ? "Off for " + name + " this week" : `${share}% of this week · aim for ${m.min}–${m.max}%`));
}

function tile(app, m, code, kidId, best) {
  return h("li", {},
    h("a", { class: "tile" + (app === best ? " tile-best" : ""), href: appHref(app, code, kidId) },
      app === best && h("span", { class: "best" }, "Best pick right now"),
      h("span", { class: "tile-name" }, APP_INFO[app].name),
      h("span", { class: "tile-sub" }, APP_INFO[app].sub),
      h("span", { class: "tile-note" }, tileNote(m.status))));
}

export function render(root, { id }) {
  if (!getSettings().kids[id]) { location.replace("#/"); return null; }
  const code = getHubCode();
  const body = h("div", {}, h("p", { class: "muted", role: "status" }, "Loading your tickets…"));
  const name0 = getSettings().kids[id].name;
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

  root.append(h("main", { class: "page" },
    h("a", { class: "back", href: "#/" }, "← Everyone"),
    h("header", { class: "kid-head" },
      h("h1", { class: "title" }, `Hi ${name0}`),
      h("p", { class: "date" }, today)),
    body));

  function draw(d) {
    const best = bestPick(d.mix);
    const kids = [];
    if (d.stale) {
      kids.push(h("p", { class: "banner", role: "status" },
        "Tickets may still be arriving — " + (d.staleAt ? `showing what we had at ${clockLabel(d.staleAt)}` : "showing what we have so far")));
    }
    if (!d.hasHub) {
      kids.push(h("p", { class: "banner info" }, "Only AMC tickets show until a grown-up sets up the hub. ",
        h("a", { class: "text-link", href: "#/grown-ups" }, "Grown-ups: set up the hub")));
    }
    kids.push(
      hero(d),
      h("section", { class: "card", "aria-labelledby": "mix-h" },
        h("h2", { id: "mix-h" }, "Where your TV time comes from this week"),
        h("ul", { class: "mix" }, APPS.map(a => mixRow(a, d.mix[a], d.kidName)))),
      h("section", { "aria-labelledby": "apps-h" },
        h("h2", { id: "apps-h", class: "plain" }, "Open an app"),
        h("ul", { class: "tiles" }, APPS.map(a => tile(a, d.mix[a], code, id, best)))),
      h("section", { class: "card", "aria-labelledby": "recent-h" },
        h("h2", { id: "recent-h" }, "Recent tickets"),
        d.recent.length
          ? h("ul", { class: "recent" }, d.recent.map(e => h("li", {}, recentLine(e, d.asOf))))
          : h("p", { class: "muted" }, "No tickets yet. Open an app to start earning.")));
    body.replaceChildren(...kids);
  }

  let seq = 0, live = true;
  async function refresh() {
    const mine = ++seq;
    try {
      const d = await loadKidData(id);
      if (!live || mine !== seq) return;
      if (!d) { location.replace("#/"); return; }
      draw(d);
    } catch (e) {
      if (!live || mine !== seq) return;
      body.replaceChildren(h("p", { class: "banner", role: "alert" }, "Couldn’t load tickets just now. We’ll try again in a minute."));
    }
  }
  refresh();
  const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, REFRESH_MS);
  const onVis = () => { if (document.visibilityState === "visible") refresh(); };
  document.addEventListener("visibilitychange", onVis);
  return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
}
