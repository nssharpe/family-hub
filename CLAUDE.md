# family-hub

Family hub for Nate's kids (Zyler and Kadyn): they earn TV time with "tickets" from the learning apps
(amc8-quest, mamou-french, typing, spelling). Static site on GitHub Pages, no build step, no SDK.
The hub UI is the kid view and the grown-ups' corner below; the apps' ticket reporting comes in later tasks.
Live at https://nssharpe.github.io/family-hub/ (GitHub Pages from `main`, repo root).

## Firestore

- **Project:** `sharpe-family` on Nate's personal Google account (Firebase added, Firestore `(default)` in `nam5`, Spark plan).
- **Access:** unauthenticated REST from the kids' devices, `https://firestore.googleapis.com/v1/projects/sharpe-family/databases/(default)/documents/...`.
  The hub code (`hub-...`, 24+ chars) is the secret. Rules never allow listing `hubs` or deleting anything.
- **Collections** (see `firestore.rules`):
  - `hubs/{code}`: sync doc with exactly `data` (string < 200000), `v`, `updated`.
  - `hubs/{code}/tickets/{id}`: create-only ticket with exactly `kid` (zyler|kadyn), `app` (amc|french|typing|spelling),
    `tickets` (int 1-200), `ts` (int), `detail` (string <= 80). Clients create with `PATCH ...?currentDocument.exists=false`
    so a duplicate id returns `ALREADY_EXISTS`. Listing `hubs/{code}/tickets` is allowed.
  - `typing/{code}`, `spelling/{code}`: progress sync docs of those apps, same shape as `hubs`, `data` < 900000.
- Typed REST values: `stringValue`, and `integerValue` as a string.

## Redeploying the rules

The firebase CLI here is logged into other accounts, so use gcloud: `bash tools/deploy-rules.sh`
(creates a ruleset from `firestore.rules` and PATCHes `releases/cloud.firestore`, using
`gcloud auth print-access-token --account "$GCLOUD_ACCOUNT"` (set `GCLOUD_ACCOUNT` to Nate's personal Google account) and header `x-goog-user-project: sharpe-family`).
New rules can take up to about a minute to take effect.

## Smoke test

`bash tools/rules-smoke.sh` exercises the rules with unauthenticated curl against a random `hub-test-...` code,
then deletes its test docs with the admin token. Every line should say `OK`, ending in `ALL OK` with exit 0.
Both scripts and `tools/seed-test-hub.mjs clean` need `GCLOUD_ACCOUNT` (Nate's personal Google account) in the environment.
Run it after every rules change (wait a minute after deploying if everything is denied).

## Kid view (hub UI)

- **Files:** `index.html`, `css/hub.css`, `js/main.js` (hash router), `js/app.js` (state + `loadKidData`), `js/amc-sheet.js`,
  `js/view-model.js` (pure helpers), `js/dom.js`, `js/settings-form.js` (pure form helpers), `js/screens/{pick,kid,grownups}.js`. No build step, relative URLs only.
- **Routes:** `#/` picker, `#/kid/<id>`, `#/grown-ups`, `#join=<hub code>`
  (replaces the URL with `#/grown-ups` so the code doesn't linger in the address bar, then asks "Join this family hub?" and stores the code only on a yes).
- **State:** one localStorage key `family-hub:v1` = `{ v, hub, settingsDoc, cache: { hub: {events, at}, amc: {[kid]: {answers, at}} } }`.
  Settings come from the hub doc (`settings.kids`), falling back to `DEFAULT_SETTINGS` with no hub.
- **Tickets (R8):** the hub log is fetched from exactly `ticketsSince(now)`; AMC tickets are derived from the Sheet with
  `amcTicketEvents`; `countTickets` runs per kid (events are filtered by kid first). If a source fails, its cached copy is used,
  and the screen says "Tickets may still be arriving, showing what we had at <time>".
- **AMC Sheet:** `js/amc-sheet.js` reads it by gviz JSONP (`tqx=responseHandler:<cb>`, `select * where B='<kid>'`).
  The Sheet's kid column holds the lowercase kid id (`zyler`), the same id the extension queries with. `parseGviz` and
  `countedAnswers` are verbatim copies from `amc8-quest/extension/src/lib/ladder.js`; the JSONP payload object is wrapped back
  into `setResponse(...)` text so `parseGviz` stays unchanged.
- **Refresh:** on load, every 60 s while the tab is visible, and on `visibilitychange`.
- **Grown-ups' corner** (`js/screens/grownups.js`, pure helpers in `js/settings-form.js`):
  - Password gate: SHA-256 of the input against the AMC 8 Quest `PARENT_HASH`; unlocked for the browser session only
    (`sessionStorage` key `family-hub:v1:unlocked`). A soft gate: the hub code is the real secret. Joining needs no password.
  - "Create the family hub" makes a code (`makeHubCode`), `putHub(code, DEFAULT_SETTINGS, null)`, joins this device, and shows the join link
    `https://nssharpe.github.io/family-hub/#join=<code>` (also what the extension's options page accepts). Never create the real hub from tests.
  - Settings form: per kid min/max per app (step 5) with the live guaranteed share and the `guaranteedShares` warnings verbatim,
    the rates, the baseline week and the ladder (add/remove rows). Save = `formToSettings` -> `validateSettings` -> `withPendingChange` -> `putHub`
    with the `updateTime` precondition. The change is stored as `pending` and starts at the next local midnight (banner shows the date).
  - On `HubConflict` it re-reads the hub, keeps the user's own edits (fields that differ from what the form loaded) on top of the latest
    settings, and asks to press Save again.
  - Today's unlocks, +15 / +30 and end-now stay in the extension's options page; the hub shows minutes earned, not minutes left.
  - To test: `sessionStorage.setItem("family-hub:v1:unlocked","1")` skips the gate locally. A hub created through the UI has a random code,
    so for tests prefer `tools/seed-test-hub.mjs seed` (or override `crypto.getRandomValues` to start the code with `hub-test`) and always
    clean up with `GCLOUD_ACCOUNT=<Nate's personal Google account> node tools/seed-test-hub.mjs clean <code>`.
- **Testing the UI:** `node tools/seed-test-hub.mjs seed` writes `DEFAULT_SETTINGS` and 20 mixed events under a `hub-testX-...` code
  and prints it; open `index.html#join=<code>`. Always finish with `node tools/seed-test-hub.mjs clean <code>` (admin token, needs `GCLOUD_ACCOUNT`).
  Serve with a no-cache server (browsers cache ES modules hard).
- **Colours:** every text/background pair and the contrast ratios are listed at the top of `css/hub.css`
  (all >= 4.5:1 text, >= 3:1 UI). Light theme only. Keep that table current when you change a token.
