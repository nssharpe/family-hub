# family-hub

Family hub for Nate's kids (Zyler and Kadyn): they earn TV time with "tickets" from the learning apps
(amc8-quest, mamou-french, typing, spelling). Static site on GitHub Pages, no build step, no SDK.
Later tasks add the hub UI and the apps' ticket reporting; this note covers the backend only.

## Firestore

- **Project:** `sharpe-family` on `NATES_PERSONAL_GOOGLE_ACCOUNT` (Firebase added, Firestore `(default)` in `nam5`, Spark plan).
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
`gcloud auth print-access-token --account NATES_PERSONAL_GOOGLE_ACCOUNT` and header `x-goog-user-project: sharpe-family`).
New rules can take up to about a minute to take effect.

## Smoke test

`bash tools/rules-smoke.sh` exercises the rules with unauthenticated curl against a random `hub-test-...` code,
then deletes its test docs with the admin token. Every line should say `OK`, ending in `ALL OK` with exit 0.
Run it after every rules change (wait a minute after deploying if everything is denied).
