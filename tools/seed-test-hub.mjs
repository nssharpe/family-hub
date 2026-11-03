// Seeds a throwaway test hub in Firestore (project sharpe-family) for checking the hub UI.
//   node tools/seed-test-hub.mjs seed           -> writes DEFAULT_SETTINGS and 20 mixed ticket events
//                                                  under a hub-test... code, prints the code
//   node tools/seed-test-hub.mjs clean <code>   -> deletes that hub's tickets and settings (admin token; needs GCLOUD_ACCOUNT set)
// Always run `clean` afterwards. The code looks like hub-testX-xxxxx-xxxxx-xxxxx so it passes isHubCode.
import { execFileSync } from "node:child_process";
import { DEFAULT_SETTINGS } from "../js/balance.js";
import { HUB_API, putHub, createOutbox, isHubCode } from "../js/hub-client.js";

const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
const rnd = n => Array.from({ length: n }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const [cmd, arg] = process.argv.slice(2);

function adminHeaders() {
  const account = process.env.GCLOUD_ACCOUNT;
  if (!account) throw new Error("set GCLOUD_ACCOUNT to Nate's personal Google account");
  const token = execFileSync("gcloud", ["auth", "print-access-token", "--account", account], { encoding: "utf8", shell: true }).trim();
  return { Authorization: `Bearer ${token}`, "x-goog-user-project": "sharpe-family" };
}

if (cmd === "seed") {
  const code = `hub-test${rnd(1)}-${rnd(5)}-${rnd(5)}-${rnd(5)}`;
  if (!isHubCode(code)) throw new Error("bad test code " + code);
  await putHub(code, DEFAULT_SETTINGS, null);
  const mem = {};
  const outbox = createOutbox({ getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } }, "seed");
  const now = Date.now();
  const HOUR = 3600e3;
  // [kid, app, tickets, hours ago, detail]: a mix over the last 6 days, some today
  const rows = [
    ["zyler", "typing", 4, 1, "Lesson 12, 96% accuracy"], ["zyler", "spelling", 3, 2, "Round of 9 words"],
    ["zyler", "french", 2, 3, "8 cards"], ["zyler", "typing", 3, 5, "Lesson 11"],
    ["zyler", "spelling", 5, 26, "Round of 15 words"], ["zyler", "french", 3, 30, "12 cards"],
    ["zyler", "typing", 6, 52, "Lesson 10"], ["zyler", "spelling", 4, 75, "Round of 12 words"],
    ["zyler", "typing", 5, 100, "Lesson 9"], ["zyler", "french", 2, 125, "8 cards"],
    ["kadyn", "spelling", 6, 1, "Round of 18 words"], ["kadyn", "typing", 5, 2, "Lesson 20"],
    ["kadyn", "french", 4, 4, "16 cards"], ["kadyn", "typing", 8, 27, "Lesson 19"],
    ["kadyn", "spelling", 3, 29, "Round of 9 words"], ["kadyn", "french", 5, 51, "20 cards"],
    ["kadyn", "typing", 7, 76, "Lesson 18"], ["kadyn", "spelling", 4, 99, "Round of 12 words"],
    ["kadyn", "french", 2, 126, "8 cards"], ["kadyn", "typing", 3, 140, "Lesson 17"],
  ];
  rows.forEach(([kid, app, tickets, ago, detail], i) =>
    outbox.add({ id: `seed:${code.slice(4, 14)}:${i}`, kid, app, tickets, ts: now - ago * HOUR, detail }));
  const r = await outbox.flush(code);
  if (r.failed) throw new Error(`${r.failed} events failed to write`);
  console.log(code);
} else if (cmd === "clean" && isHubCode(arg)) {
  const headers = adminHeaders();
  const url = `${HUB_API}/hubs/${arg}`;
  const listRes = await fetch(`${url}/tickets?pageSize=300`, { headers });
  const list = listRes.ok ? await listRes.json() : {};
  let n = 0;
  for (const d of list.documents || []) {
    const r = await fetch(`https://firestore.googleapis.com/v1/${d.name}`, { method: "DELETE", headers });
    if (r.ok) n++; else console.error("delete failed", d.name, r.status);
  }
  const r = await fetch(url, { method: "DELETE", headers });
  console.log(`deleted ${n} tickets, hub doc HTTP ${r.status}`);
  if (!r.ok) process.exit(1);
} else {
  console.error("usage: seed | clean <hub code>");
  process.exit(2);
}
