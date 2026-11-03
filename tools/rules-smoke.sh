#!/usr/bin/env bash
# Smoke test for firestore.rules (project sharpe-family). Unauthenticated REST calls as a kid device
# would make them, then cleanup with the gcloud admin token. Exits non-zero on any failure.
set -u
P=sharpe-family
BASE="https://firestore.googleapis.com/v1/projects/$P/databases/(default)/documents"
CODE="hub-test-$(python -c 'import secrets;print(secrets.token_hex(12))')"
FAILS=0
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

# req METHOD URL [JSON] -> sets STATUS and prints nothing; body in $BODY
req() {
  if [ $# -ge 3 ]; then
    STATUS=$(curl -s -o "$BODY" -w '%{http_code}' -X "$1" -H 'Content-Type: application/json' -d "$3" "$2")
  else
    STATUS=$(curl -s -o "$BODY" -w '%{http_code}' -X "$1" "$2")
  fi
}
# check NAME EXPECTED_STATUS [BODY_SUBSTRING]
check() {
  local ok=1
  [ "$STATUS" = "$2" ] || ok=0
  if [ -n "${3:-}" ] && ! grep -q "$3" "$BODY"; then ok=0; fi
  if [ $ok = 1 ]; then echo "OK   $1 (HTTP $STATUS)"; else
    echo "FAIL $1 (HTTP $STATUS, wanted $2 ${3:-})"; head -c 300 "$BODY"; echo; FAILS=$((FAILS+1)); fi
}
ticket() { # kid app tickets detail
  printf '{"fields":{"kid":{"stringValue":"%s"},"app":{"stringValue":"%s"},"tickets":{"integerValue":"%s"},"ts":{"integerValue":"1762200000000"},"detail":{"stringValue":"%s"}}}' "$1" "$2" "$3" "$4"
}
HUB='{"fields":{"data":{"stringValue":"{}"},"v":{"integerValue":"1"},"updated":{"integerValue":"1762200000000"}}}'

echo "test code: $CODE"
req PATCH "$BASE/hubs/$CODE" "$HUB";                         check "create hub doc" 200
req GET   "$BASE/hubs/$CODE";                                check "get hub doc" 200
req PATCH "$BASE/hubs/$CODE/tickets/t1?currentDocument.exists=false" "$(ticket zyler french 5 'smoke')"
                                                             check "create ticket" 200
req PATCH "$BASE/hubs/$CODE/tickets/t1?currentDocument.exists=false" "$(ticket zyler french 5 'smoke')"
                                                             check "duplicate ticket id -> ALREADY_EXISTS" 409 ALREADY_EXISTS
req GET   "$BASE/hubs/$CODE/tickets";                        check "list tickets" 200 '"tickets"'
req PATCH "$BASE/hubs/$CODE/tickets/t2?currentDocument.exists=false" "$(ticket kadyn amc 0 'zero')"
                                                             check "tickets=0 denied" 403 PERMISSION_DENIED
req GET   "$BASE/hubs";                                      check "list hubs denied" 403 PERMISSION_DENIED
req PATCH "$BASE/hubs/$CODE/tickets/t1" "$(ticket zyler french 9 'changed')"
                                                             check "update ticket denied" 403 PERMISSION_DENIED
# extra checks beyond the brief
req PATCH "$BASE/hubs/hub-short/tickets/t3?currentDocument.exists=false" "$(ticket zyler amc 5 'x')"
                                                             check "short code denied" 403 PERMISSION_DENIED
req PATCH "$BASE/hubs/$CODE/tickets/t4?currentDocument.exists=false" "$(ticket zyler other 5 'x')"
                                                             check "bad app denied" 403 PERMISSION_DENIED
req PATCH "$BASE/hubs/$CODE/tickets/t5?currentDocument.exists=false" "$(ticket someone amc 5 'x')"
                                                             check "bad kid denied" 403 PERMISSION_DENIED
req PATCH "$BASE/hubs/$CODE/tickets/t6?currentDocument.exists=false" "$(ticket zyler amc 201 'x')"
                                                             check "tickets=201 denied" 403 PERMISSION_DENIED
req PATCH "$BASE/hubs/$CODE/tickets/t7?currentDocument.exists=false" "$(ticket zyler amc 5 "$(python -c 'print("x"*81)')")"
                                                             check "detail>80 denied" 403 PERMISSION_DENIED
req PATCH "$BASE/hubs/$CODE/tickets/t8?currentDocument.exists=false" '{"fields":{"kid":{"stringValue":"zyler"},"app":{"stringValue":"amc"},"tickets":{"integerValue":"5"},"ts":{"integerValue":"1"},"detail":{"stringValue":"x"},"extra":{"stringValue":"y"}}}'
                                                             check "extra ticket key denied" 403 PERMISSION_DENIED
req PATCH "$BASE/hubs/$CODE" '{"fields":{"data":{"stringValue":"{}"},"v":{"integerValue":"1"}}}'
                                                             check "hub missing key denied" 403 PERMISSION_DENIED
req PATCH "$BASE/typing/$CODE" "$HUB";                       check "create typing doc" 200
req PATCH "$BASE/spelling/$CODE" "$HUB";                     check "create spelling doc" 200
req GET   "$BASE/typing";                                    check "list typing denied" 403 PERMISSION_DENIED
req DELETE "$BASE/hubs/$CODE";                               check "delete hub denied" 403 PERMISSION_DENIED

# Cleanup with the admin token (bypasses rules)
ACCOUNT="${GCLOUD_ACCOUNT:?set GCLOUD_ACCOUNT to Nate's personal Google account}"
T=$(gcloud auth print-access-token --account "$ACCOUNT")
for path in "hubs/$CODE/tickets/t1" "hubs/$CODE" "typing/$CODE" "spelling/$CODE"; do
  s=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $T" -H "x-goog-user-project: $P" "$BASE/$path")
  if [ "$s" = 200 ]; then echo "OK   cleanup $path"; else echo "FAIL cleanup $path (HTTP $s)"; FAILS=$((FAILS+1)); fi
done

if [ $FAILS -eq 0 ]; then echo "ALL OK"; exit 0; else echo "$FAILS FAILED"; exit 1; fi
