// #/grown-ups : the parents' corner. Behind a password gate (kept for this browser session only) it
// creates the family hub, shows the join link, and edits each kid's weekly share ranges, the ticket
// rates, the baseline week and the daily ticket ladder. Edits are saved as a pending change that
// starts at the next local midnight (balance.js withPendingChange).
// `#join=<code>` lands here with { join: code }: a "Join this family hub?" prompt that needs no password.
import { h } from "../dom.js";
import { APPS, APP_NAMES, DEFAULT_SETTINGS, effectiveSettings, withPendingChange, validateSettings } from "../balance.js";
import { getHub, putHub, makeHubCode, HubConflict } from "../hub-client.js";
import { getHubCode, joinHub, refreshSettings, withTimeout } from "../app.js";
import {
  isParentPassword, joinLink, formToSettings, settingsToForm, kidGuarantees, pendingInfo, summarizeSettings,
} from "../settings-form.js";

const UNLOCK_KEY = "family-hub:v1:unlocked"; // sessionStorage: gone when the browser session ends
let unlockedMem = false;

function isUnlocked() {
  try { if (sessionStorage.getItem(UNLOCK_KEY) === "1") return true; } catch { /* blocked: memory flag below */ }
  return unlockedMem;
}
function setUnlocked(on) {
  unlockedMem = on;
  try { if (on) sessionStorage.setItem(UNLOCK_KEY, "1"); else sessionStorage.removeItem(UNLOCK_KEY); } catch { /* ignore */ }
}

const RATE_FIELDS = [
  ["amcBase", "AMC: tickets for problem 0", "1"],
  ["amcPerNum", "AMC: extra tickets per problem number", "0.2"],
  ["amc10Mult", "AMC 10 multiplier", "1.5"],
  ["frenchCardsPerTicket", "French: cards per ticket", "4"],
  ["typingCharsPerTicket", "Typing: correct characters per ticket", "100"],
  ["typingMasteredFactor", "Typing: replay factor for a 3-star lesson (0 to 1)", "0.5"],
  ["spellingWordsPerTicket", "Spelling: first-try words per ticket", "3"],
];

const msg = (kind, text) => h("p", { class: `notice notice-${kind}`, role: kind === "err" ? "alert" : "status" }, text);

export function render(root, params = {}) {
  const view = h("div", {});
  root.append(h("main", { class: "page" },
    h("a", { class: "back", href: "#/" }, "← Back"),
    h("h1", { class: "title" }, "Grown-ups"),
    params.notice && h("p", { class: "banner", role: "alert" }, params.notice),
    params.join && joinPrompt(params.join),
    view));
  let live = true;

  const showGate = () => {
    const input = h("input", { id: "pw", type: "password", autocomplete: "off", required: true });
    const out = h("div", {});
    const form = h("form", { class: "card g gate", novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        let ok = false;
        try { ok = await isParentPassword(input.value); } catch { out.replaceChildren(msg("err", "This browser can’t check passwords on this page. Open the hub over https.")); return; }
        if (!live) return;
        if (ok) { setUnlocked(true); showHub(); }
        else { input.value = ""; out.replaceChildren(msg("err", "That isn’t the right password.")); input.focus(); }
      } },
      h("p", { class: "lead" }, "Parents only. Enter the grown-ups’ password."),
      h("label", { class: "field", for: "pw" }, h("span", {}, "Password"), input),
      h("button", { class: "btn", type: "submit" }, "Unlock"),
      out);
    view.replaceChildren(form);
  };

  const lockButton = () => h("button", { class: "btn secondary", type: "button", onclick: () => { setUnlocked(false); showGate(); } }, "Lock");

  const showHub = () => {
    if (!getHubCode()) return showCreate();
    const code = getHubCode();
    view.replaceChildren(h("p", { class: "muted", role: "status" }, "Loading the hub…"));
    loadEditor(code);
  };

  const showCreate = (error) => {
    const out = h("div", {}, error && msg("err", error));
    const btn = h("button", { class: "btn", type: "button" }, "Create the family hub");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      out.replaceChildren();
      let failed = "Couldn’t create the hub. Check the connection and try again.";
      for (let i = 0; i < 3; i++) {
        const code = makeHubCode();
        try {
          await withTimeout(putHub(code, DEFAULT_SETTINGS, null));
          joinHub(code);
          await refreshSettings();
          if (live) loadEditor(code, true);
          return;
        } catch (e) {
          if (!(e instanceof HubConflict)) break; // a code clash is retried with a new code; anything else stops
        }
      }
      if (live) { btn.disabled = false; out.replaceChildren(msg("err", failed)); }
    });
    view.replaceChildren(
      h("div", { class: "toolbar" }, lockButton()),
      h("div", { class: "card g" },
        h("h2", {}, "Set up the family hub"),
        h("p", { class: "lead" }, "No hub is connected on this device yet. Creating one makes a new secret hub code and joins this device to it. You’ll get a link to open on the kids’ devices."),
        btn, out));
  };

  async function loadEditor(code, justCreated = false) {
    let hub;
    try { hub = await withTimeout(getHub(code)); }
    catch {
      view.replaceChildren(
        h("div", { class: "toolbar" }, lockButton()),
        msg("err", "Couldn’t reach the hub. Check the connection."),
        h("button", { class: "btn", type: "button", onclick: showHub }, "Try again"));
      return;
    }
    if (!live) return;
    if (!hub) {
      view.replaceChildren(
        h("div", { class: "toolbar" }, lockButton()),
        msg("err", "This device points at a hub that doesn’t exist any more. Open a valid join link here, or create a new hub."),
        h("button", { class: "btn", type: "button", onclick: () => showCreate() }, "Create a new hub"));
      return;
    }
    showEditor(code, hub, justCreated);
  }

  function showEditor(code, hub, justCreated) {
    let doc = hub.settings;           // the hub document, pending change included
    let updateTime = hub.updateTime;  // precondition for the next save
    const now0 = Date.now();
    const start = pendingInfo(doc, now0) ? doc.pending.settings : effectiveSettings(doc, now0);
    const f0 = settingsToForm(start);
    const kidIds = Object.keys(start.kids);

    // ----- status: banner + effective vs pending -----
    const statusBox = h("div", {});
    const renderStatus = () => {
      const now = Date.now();
      const pend = pendingInfo(doc, now);
      const eff = effectiveSettings(doc, now);
      const list = lines => h("dl", { class: "summary" }, lines.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
      statusBox.replaceChildren(
        pend && h("p", { class: "banner", role: "status" }, pend.text),
        h("details", { class: "card g", open: pend ? true : null },
          h("summary", {}, pend ? "In force now, and starting later" : "In force now"),
          h("h3", {}, "In force now"), list(summarizeSettings(eff)),
          pend && h("h3", {}, pend.text.replace(/^Changes take effect /, "Starting ")),
          pend && list(summarizeSettings(doc.pending.settings))));
    };

    // ----- kid ranges -----
    const rangeInputs = {}; // kidId -> app -> { min, max }
    const refreshKid = {};  // kidId -> redraws that kid's guaranteed chips and warnings
    const kidSections = kidIds.map(id => {
      rangeInputs[id] = {};
      const guar = {}; // app -> chip
      const warnBox = h("div", {});
      const refresh = () => {
        const g = kidGuarantees(Object.fromEntries(APPS.map(a => [a, { min: rangeInputs[id][a].min.value, max: rangeInputs[id][a].max.value }])));
        const warns = [];
        for (const a of APPS) {
          const short = !!g[a].warning;
          guar[a].className = "chip " + (short ? "chip-needs" : "chip-ok");
          guar[a].textContent = `Guaranteed ${g[a].guaranteed}%`;
          if (short) warns.push(h("li", {}, g[a].warning)); // shown verbatim
        }
        warnBox.replaceChildren(...(warns.length ? [h("ul", { class: "warn-list banner", role: "status" }, warns)] : []));
      };
      const rows = APPS.map(a => {
        const mk = (which, label) => {
          const input = h("input", { type: "number", inputmode: "numeric", step: "5", min: "0", max: "100", value: f0.kids[id].ranges[a][which],
            "aria-label": `${start.kids[id].name}, ${APP_NAMES[a]}, ${label} percent`, oninput: refresh });
          return input;
        };
        const min = mk("min", "minimum"), max = mk("max", "maximum");
        rangeInputs[id][a] = { min, max };
        guar[a] = h("span", { class: "chip chip-ok" });
        return h("li", { class: "range-row" },
          h("span", { class: "range-app" }, APP_NAMES[a]),
          h("label", { class: "num" }, h("span", {}, "Min %"), min),
          guar[a],
          h("label", { class: "num" }, h("span", {}, "Max %"), max));
      });
      refresh();
      refreshKid[id] = refresh;
      return h("section", { class: "card g" },
        h("h2", {}, start.kids[id].name),
        h("p", { class: "muted small" }, "Share of the week’s counted tickets each app should get. Guaranteed is the share an app is certain to reach, whatever the others do."),
        h("ul", { class: "range-list" }, rows),
        warnBox);
    });

    // ----- rates and baseline -----
    const rateInputs = {};
    const rateRows = RATE_FIELDS.map(([k, label]) => {
      rateInputs[k] = h("input", { id: "rate-" + k, type: "text", inputmode: "decimal", value: f0.rates[k] });
      return h("label", { class: "field", for: "rate-" + k }, h("span", {}, label), rateInputs[k]);
    });
    const baselineInput = h("input", { id: "baseline", type: "text", inputmode: "numeric", value: f0.baseline });

    // ----- ladder -----
    let ladder = f0.ladder.map(r => ({ ...r }));
    const ladderBox = h("ul", { class: "ladder-list" });
    const addBtn = h("button", { class: "btn secondary", type: "button" }, "Add a row");
    const readLadder = () => Array.from(ladderBox.children, li => ({ tickets: li.querySelector(".lt").value, minutes: li.querySelector(".lm").value }));
    const drawLadder = () => {
      ladderBox.replaceChildren(...ladder.map((row, i) => h("li", { class: "ladder-row" },
        h("span", { class: "ladder-n" }, `Unlock ${i + 1}`),
        h("label", { class: "num" }, h("span", {}, "Tickets"), h("input", { class: "lt", type: "number", inputmode: "numeric", min: "1", value: row.tickets, "aria-label": `Unlock ${i + 1}, tickets` })),
        h("label", { class: "num" }, h("span", {}, "Minutes"), h("input", { class: "lm", type: "number", inputmode: "numeric", min: "1", value: row.minutes, "aria-label": `Unlock ${i + 1}, minutes` })),
        h("button", { class: "btn secondary", type: "button", disabled: ladder.length <= 1, "aria-label": `Remove unlock ${i + 1}`,
          onclick: () => { ladder = readLadder(); ladder.splice(i, 1); drawLadder(); } }, "Remove"))));
      addBtn.disabled = ladder.length >= 20;
    };
    addBtn.addEventListener("click", () => {
      ladder = readLadder();
      const last = ladder[ladder.length - 1] || { tickets: "40", minutes: "5" };
      ladder.push({ ...last });
      drawLadder();
    });
    drawLadder();

    // ----- save -----
    const result = h("div", {});
    let baseForm = f0; // what the form held when it was loaded or last saved: the reference for "what did the user edit?"
    const writeForm = (fv) => {
      for (const id of kidIds) for (const a of APPS) {
        rangeInputs[id][a].min.value = fv.kids[id].ranges[a].min;
        rangeInputs[id][a].max.value = fv.kids[id].ranges[a].max;
      }
      for (const [k, el] of Object.entries(rateInputs)) el.value = fv.rates[k];
      baselineInput.value = fv.baseline;
      ladder = fv.ladder.map(r => ({ ...r }));
      drawLadder();
      for (const id of kidIds) refreshKid[id]();
    };
    // After a conflict: the other device's latest settings, with this user's own edits (fields that differ
    // from baseForm) put back on top, so a retry never silently undoes the other device's change.
    const mergeEdits = (mine, old, fresh) => {
      const pick = (m, o, f) => (m !== o ? m : f);
      return {
        kids: Object.fromEntries(kidIds.map(id => [id, { ranges: Object.fromEntries(APPS.map(a => [a, {
          min: pick(mine.kids[id].ranges[a].min, old.kids[id].ranges[a].min, fresh.kids[id].ranges[a].min),
          max: pick(mine.kids[id].ranges[a].max, old.kids[id].ranges[a].max, fresh.kids[id].ranges[a].max),
        }])) }])),
        rates: Object.fromEntries(Object.keys(mine.rates).map(k => [k, pick(mine.rates[k], old.rates[k], fresh.rates[k])])),
        baseline: pick(mine.baseline, old.baseline, fresh.baseline),
        ladder: JSON.stringify(mine.ladder) !== JSON.stringify(old.ladder) ? mine.ladder : fresh.ladder,
      };
    };
    const saveBtn = h("button", { class: "btn", type: "submit" }, "Save changes");
    const readForm = () => ({
      kids: Object.fromEntries(kidIds.map(id => [id, { ranges: Object.fromEntries(APPS.map(a =>
        [a, { min: rangeInputs[id][a].min.value, max: rangeInputs[id][a].max.value }])) }])),
      rates: Object.fromEntries(Object.entries(rateInputs).map(([k, el]) => [k, el.value])),
      baseline: baselineInput.value,
      ladder: readLadder(),
    });
    const form = h("form", { novalidate: true, onsubmit: async (e) => {
      e.preventDefault();
      result.replaceChildren();
      const now = Date.now();
      const next = formToSettings(readForm(), effectiveSettings(doc, now));
      const problem = validateSettings(next);
      if (problem) { result.replaceChildren(msg("err", problem)); return; }
      saveBtn.disabled = true;
      try {
        const nextDoc = withPendingChange(doc, next, now);
        updateTime = await withTimeout(putHub(code, nextDoc, updateTime));
        doc = nextDoc;
        baseForm = readForm();
        refreshSettings();
        renderStatus();
        const p = pendingInfo(doc, Date.now());
        result.replaceChildren(msg("ok", p ? `Saved. ${p.text}.` : "Saved."));
      } catch (err) {
        if (err instanceof HubConflict) {
          try {
            const fresh = await withTimeout(getHub(code));
            if (!fresh) throw new Error("gone");
            doc = fresh.settings; updateTime = fresh.updateTime;
            const t = Date.now();
            const freshForm = settingsToForm(pendingInfo(doc, t) ? doc.pending.settings : effectiveSettings(doc, t));
            writeForm(mergeEdits(readForm(), baseForm, freshForm));
            baseForm = freshForm;
            renderStatus();
            result.replaceChildren(msg("err", "Another device saved changes just now. The summary above shows its latest settings, and your edits are still on top of them. Check the form, then press Save again."));
          } catch { result.replaceChildren(msg("err", "The settings changed on another device and the latest couldn’t be loaded. Try again in a moment.")); }
        } else {
          result.replaceChildren(msg("err", "Couldn’t save. Check the connection and press Save again."));
        }
      } finally { if (live) saveBtn.disabled = false; }
    } },
      kidSections,
      h("section", { class: "card g" },
        h("h2", {}, "Ticket rates"),
        h("div", { class: "fields" }, rateRows),
        h("label", { class: "field", for: "baseline" }, h("span", {}, "Baseline week (tickets)"), baselineInput),
        h("p", { class: "muted small" }, "Shares are measured against at least this many tickets, so a slow week doesn’t make one app’s max bite early.")),
      h("section", { class: "card g" },
        h("h2", {}, "Daily TV ladder"),
        h("p", { class: "muted small" }, "Each unlock costs that many counted tickets and gives that many minutes. The last row repeats."),
        ladderBox, addBtn),
      h("p", { class: "muted small" }, "Saved changes start at the next midnight. Adding time or ending TV now is done in the Streaming Lock extension’s options."),
      result,
      saveBtn);

    // ----- join link -----
    const link = joinLink(code);
    const linkInput = h("input", { id: "join-link", type: "text", readonly: true, value: link, "aria-label": "Join link" });
    const copyNote = h("span", { class: "muted small", role: "status" });
    const copyBtn = h("button", { class: "btn secondary", type: "button", onclick: async () => {
      try { await navigator.clipboard.writeText(link); copyNote.textContent = "Copied."; }
      catch { linkInput.focus(); linkInput.select(); copyNote.textContent = "Press Ctrl+C (or hold and copy) to copy it."; }
    } }, "Copy link");

    view.replaceChildren(
      h("div", { class: "toolbar" }, lockButton()),
      justCreated && msg("ok", "Hub created and this device has joined it. Open the link below on each device that should use it."),
      statusBox,
      h("section", { class: "card g" },
        h("h2", {}, "Join link"),
        h("p", { class: "muted small" }, "Open this on a device to connect it to the family hub. The Streaming Lock extension’s options page accepts it too. Keep it private."),
        h("div", { class: "copy-row" }, linkInput, copyBtn), copyNote),
      form);
    renderStatus();
  }

  if (isUnlocked()) showHub(); else showGate();
  return () => { live = false; };
}

function joinPrompt(code) {
  const same = getHubCode() === code;
  const box = h("section", { class: "card g join" });
  const done = (text) => box.replaceChildren(h("p", { role: "status" }, text));
  box.append(
    h("h2", {}, "Join this family hub?"),
    h("p", { class: "lead" }, same
      ? "This device has already joined that hub."
      : getHubCode()
        ? "This device is on a different hub. Joining switches it to this one."
        : "This device will show this hub’s tickets and TV time."),
    h("div", { class: "row" },
      !same && h("button", { class: "btn", type: "button", onclick: () => { joinHub(code); location.hash = "#/"; } }, "Join"),
      h("button", { class: "btn secondary", type: "button", onclick: () => (same ? (location.hash = "#/") : done("Not joined.")) }, same ? "Go to the hub" : "Not now")));
  return box;
}
