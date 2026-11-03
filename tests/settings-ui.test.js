import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, validateSettings, withPendingChange, effectiveSettings } from "../js/balance.js";
import {
  parseNum, formToSettings, settingsToForm, kidGuarantees, pendingInfo, dayLabel, summarizeSettings,
  sha256Hex, isParentPassword, joinLink, PARENT_HASH, inputText, BAD_NUMBER_TEXT, newHubSettings, CONFIRM_CREATE_HUB,
} from "../js/settings-form.js";

const NOW = new Date(2026, 10, 3, 16, 30).getTime(); // Tue 3 Nov 2026, 4:30pm local

test("parseNum: percent strings become numbers, blank and junk become NaN", () => {
  assert.equal(parseNum("30"), 30);
  assert.equal(parseNum(" 30% "), 30);
  assert.equal(parseNum("45 %"), 45);
  assert.ok(Number.isNaN(parseNum("")), "a blank box is not a 0");
  assert.ok(Number.isNaN(parseNum("   ")));
  assert.ok(Number.isNaN(parseNum(undefined)));
  assert.ok(Number.isNaN(parseNum("3e")), "half-typed");
  assert.ok(Number.isNaN(parseNum(BAD_NUMBER_TEXT)));
  assert.equal(parseNum("0.2"), 0.2);
  assert.equal(parseNum(".5"), 0.5);
  assert.ok(Number.isNaN(parseNum("abc")));
  assert.ok(Number.isNaN(parseNum("1e3")));
  assert.ok(Number.isNaN(parseNum("0x10")));
});

test("formToSettings: round trip of the defaults is unchanged", () => {
  const back = formToSettings(settingsToForm(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  assert.deepEqual(back, DEFAULT_SETTINGS);
});

test("formToSettings: strings in, numbers out; names, v and untouched kids stay", () => {
  const fv = settingsToForm(DEFAULT_SETTINGS);
  fv.kids.zyler.ranges.typing = { min: "25%", max: "45" };
  fv.kids.zyler.ranges.amc = { min: "0", max: " 30 " };
  fv.rates.amcPerNum = "0.25";
  fv.rates.typingCharsPerTicket = "120";
  fv.baseline = "200";
  fv.ladder = [{ tickets: "10", minutes: "20" }, { tickets: "20", minutes: "0" }];
  const before = JSON.stringify(DEFAULT_SETTINGS);
  const s = formToSettings(fv, DEFAULT_SETTINGS);
  assert.deepEqual(s.kids.zyler.ranges.typing, [25, 45]);
  assert.deepEqual(s.kids.zyler.ranges.amc, [0, 30]);
  assert.equal(s.rates.amcPerNum, 0.25);
  assert.equal(s.rates.typingCharsPerTicket, 120);
  assert.equal(s.baseline, 200);
  assert.deepEqual(s.ladder, [[10, 20], [20, 0]]);
  assert.equal(s.kids.zyler.name, "Zyler");
  assert.deepEqual(s.kids.kadyn, DEFAULT_SETTINGS.kids.kadyn);
  assert.equal(s.v, 1);
  assert.equal(s.pending, null);
  assert.equal(JSON.stringify(DEFAULT_SETTINGS), before, "current is not mutated");
});

test("formToSettings: a pending change on `current` is dropped, bad input fails validateSettings", () => {
  const withPending = { ...DEFAULT_SETTINGS, pending: { effectiveFrom: "2026-11-04", settings: DEFAULT_SETTINGS } };
  const fv = settingsToForm(DEFAULT_SETTINGS);
  assert.equal(formToSettings(fv, withPending).pending, null);
  assert.equal(validateSettings(formToSettings(fv, DEFAULT_SETTINGS)), null);

  fv.kids.kadyn.ranges.french = { min: "abc", max: "10" };
  assert.match(validateSettings(formToSettings(fv, DEFAULT_SETTINGS)), /Kadyn, French/);
  fv.kids.kadyn.ranges.french = { min: "50", max: "10" };
  assert.match(validateSettings(formToSettings(fv, DEFAULT_SETTINGS)), /min can't be more than the max/);
  fv.kids.kadyn.ranges.french = { min: "0", max: "100" };
  fv.ladder = [{ tickets: "", minutes: "30" }]; // blank tickets -> NaN -> rejected, not saved
  assert.match(validateSettings(formToSettings(fv, DEFAULT_SETTINGS)), /Ladder row 1: tickets/);
});

test("saving through withPendingChange keeps today's settings and queues the edit for tomorrow", () => {
  const fv = settingsToForm(DEFAULT_SETTINGS);
  fv.kids.zyler.ranges.typing = { min: "25", max: "45" };
  const next = formToSettings(fv, effectiveSettings(DEFAULT_SETTINGS, NOW));
  const doc = withPendingChange(DEFAULT_SETTINGS, next, NOW);
  assert.deepEqual(doc.kids.zyler.ranges.typing, [25, 50]);
  assert.equal(doc.pending.effectiveFrom, "2026-11-04");
  assert.deepEqual(doc.pending.settings.kids.zyler.ranges.typing, [25, 45]);
});

test("kidGuarantees: Zyler's defaults warn on typing and spelling; max 45 clears the typing warning", () => {
  const f = settingsToForm(DEFAULT_SETTINGS).kids.zyler.ranges;
  const g = kidGuarantees(f);
  assert.equal(g.typing.guaranteed, 0); // others' maxes add up to 110
  assert.ok(g.typing.warning && g.spelling.warning);
  f.typing = { min: "25", max: "45" };
  f.spelling = { min: "25", max: "50" };
  const g2 = kidGuarantees(f);
  // typing's max alone doesn't help typing: it's the OTHER apps' maxes (30 + 30 + 50 = 110) that set its guarantee
  assert.ok(g2.typing.warning);
  f.amc = { min: "0", max: "10" }; f.french = { min: "10", max: "10" }; f.spelling = { min: "25", max: "30" };
  assert.equal(kidGuarantees(f).typing.warning, null);
  assert.equal(kidGuarantees(f).typing.guaranteed, 100 - 10 - 10 - 30);
});

test("kidGuarantees: half-typed values count as 0 instead of NaN", () => {
  const f = settingsToForm(DEFAULT_SETTINGS).kids.zyler.ranges;
  f.french = { min: "1x", max: "" };
  const g = kidGuarantees(f);
  for (const a of Object.keys(g)) assert.ok(Number.isFinite(g[a].guaranteed));
});

test("pendingInfo: banner text while a change waits for midnight, nothing once it is in force", () => {
  const doc = withPendingChange(DEFAULT_SETTINGS, DEFAULT_SETTINGS, NOW);
  assert.deepEqual(pendingInfo(doc, NOW), { effectiveFrom: "2026-11-04", text: "Changes take effect tomorrow (Wed 4 Nov)" });
  assert.equal(pendingInfo(doc, new Date(2026, 10, 4, 0, 1).getTime()), null);
  assert.equal(pendingInfo(DEFAULT_SETTINGS, NOW), null);
  assert.equal(pendingInfo(null, NOW), null);
  const later = { ...doc, pending: { ...doc.pending, effectiveFrom: "2026-11-10" } };
  assert.equal(pendingInfo(later, NOW).text, "Changes take effect on Tue 10 Nov");
  assert.equal(dayLabel("2026-11-04"), "Wed 4 Nov");
});

test("summarizeSettings lists kids, rates, baseline and ladder", () => {
  const lines = Object.fromEntries(summarizeSettings(DEFAULT_SETTINGS));
  assert.equal(lines.Zyler, "AMC 0–30%, French 10–30%, Typing 25–50%, Spelling 25–50%");
  assert.equal(lines["Baseline week"], "150 tickets");
  assert.match(lines.Ladder, /^15 → 30 min, 20 → 25 min/);
  assert.equal(lines.French, "1 ticket per 4 cards");
});

test("password gate hashes with SHA-256", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(PARENT_HASH.length, 64);
  const throwaway = await sha256Hex("not-the-real-password");
  assert.equal(await isParentPassword("not-the-real-password", throwaway), true);
  assert.equal(await isParentPassword("nope", throwaway), false);
  assert.equal(await isParentPassword("", PARENT_HASH), false);
});

test("joinLink points at the Pages site", () => {
  assert.equal(joinLink("hub-abcde-23456-fghjk-mnpqr"), "https://nssharpe.github.io/family-hub/#join=hub-abcde-23456-fghjk-mnpqr");
});

test("a blank or half-typed number is invalid, never a silent 0 (it would turn an app off)", () => {
  const base = () => settingsToForm(DEFAULT_SETTINGS);
  const cases = {
    "range max blank": fv => { fv.kids.zyler.ranges.typing.max = ""; },
    "range min blank": fv => { fv.kids.kadyn.ranges.amc.min = "  "; },
    "range max half-typed": fv => { fv.kids.zyler.ranges.french.max = inputText({ value: "", validity: { badInput: true } }); },
    "rate blank": fv => { fv.rates.frenchCardsPerTicket = ""; },
    "rate half-typed": fv => { fv.rates.amcPerNum = "0.2e"; },
    "baseline blank": fv => { fv.baseline = ""; },
    "ladder minutes half-typed": fv => { fv.ladder[0].minutes = BAD_NUMBER_TEXT; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const fv = base();
    mutate(fv);
    assert.ok(validateSettings(formToSettings(fv, DEFAULT_SETTINGS)), name + " must not validate");
  }
});

test("inputText: a number box with half-typed text reads as bad input, not as blank", () => {
  assert.equal(inputText({ value: "", validity: { badInput: true } }), BAD_NUMBER_TEXT);
  assert.equal(inputText({ value: "", validity: { badInput: false } }), "");
  assert.equal(inputText({ value: "30", validity: { badInput: false } }), "30");
  assert.equal(inputText({ value: "abc" }), "abc", "text inputs have no badInput");
  assert.ok(Number.isNaN(parseNum(inputText({ value: "", validity: { badInput: true } }))));
});

test("newHubSettings: the defaults plus startedAt, validates, and doesn't touch DEFAULT_SETTINGS", () => {
  const s = newHubSettings(NOW);
  assert.equal(s.startedAt, NOW);
  assert.equal(validateSettings(s), null);
  assert.deepEqual({ ...s, startedAt: undefined }, { ...DEFAULT_SETTINGS, startedAt: undefined });
  assert.ok(!("startedAt" in DEFAULT_SETTINGS));
  s.kids.zyler.ranges.amc[1] = 1;
  assert.equal(DEFAULT_SETTINGS.kids.zyler.ranges.amc[1], 30, "a deep copy");
});

test("validateSettings accepts an optional startedAt (R20): present or absent", () => {
  assert.equal(validateSettings(DEFAULT_SETTINGS), null);
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, startedAt: NOW }), null);
});

test("startedAt survives a settings save: form -> pending change -> effective settings", () => {
  const doc = newHubSettings(NOW - 5 * 86400e3);
  const next = formToSettings(settingsToForm(doc), effectiveSettings(doc, NOW));
  assert.equal(next.startedAt, doc.startedAt);
  const saved = withPendingChange(doc, next, NOW);
  assert.equal(saved.startedAt, doc.startedAt);
  assert.equal(saved.pending.settings.startedAt, doc.startedAt);
  const tomorrow = new Date(2026, 10, 4, 0, 5).getTime();
  assert.equal(effectiveSettings(saved, tomorrow).startedAt, doc.startedAt, "still there once the pending change is in force");
});

test("the second-hub confirmation says to use the join link first", () => {
  assert.equal(CONFIRM_CREATE_HUB, "Already have a hub on another device? Open its join link here instead. Create a new hub anyway?");
});
