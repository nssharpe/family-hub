#!/usr/bin/env bash
# Deploy firestore.rules to project sharpe-family via the Firebase Rules REST API (gcloud token).
set -euo pipefail
cd "$(dirname "$0")/.."
P=sharpe-family
ACCOUNT="${GCLOUD_ACCOUNT:?set GCLOUD_ACCOUNT to the personal Google account that owns sharpe-family}"
T=$(gcloud auth print-access-token --account "$ACCOUNT")
H=(-H "Authorization: Bearer $T" -H "x-goog-user-project: $P" -H "Content-Type: application/json")
BODY=$(python -c 'import json;print(json.dumps({"source":{"files":[{"name":"firestore.rules","content":open("firestore.rules",encoding="utf-8").read()}]}}))')
RS=$(curl -s "${H[@]}" -d "$BODY" "https://firebaserules.googleapis.com/v1/projects/$P/rulesets")
NAME=$(printf '%s' "$RS" | python -c 'import sys,json;d=json.load(sys.stdin);print(d["name"])') || { echo "ruleset create failed: $RS"; exit 1; }
echo "ruleset: $NAME"
REL=$(curl -s -X PATCH "${H[@]}" -d "{\"release\":{\"name\":\"projects/$P/releases/cloud.firestore\",\"rulesetName\":\"$NAME\"}}" "https://firebaserules.googleapis.com/v1/projects/$P/releases/cloud.firestore")
if printf '%s' "$REL" | grep -q '"rulesetName"'; then echo "released"; else
  # first release: create instead of patch
  REL=$(curl -s -X POST "${H[@]}" -d "{\"name\":\"projects/$P/releases/cloud.firestore\",\"rulesetName\":\"$NAME\"}" "https://firebaserules.googleapis.com/v1/projects/$P/releases")
  printf '%s' "$REL" | grep -q '"rulesetName"' && echo "released (created)" || { echo "release failed: $REL"; exit 1; }
fi
