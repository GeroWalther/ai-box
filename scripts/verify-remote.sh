#!/usr/bin/env bash
# Probe a RUNNING companion server to verify its security posture end-to-end.
#
# 1. In the app: Settings -> enable Away mode / Remote access.
# 2. Read the URL and token off that panel.
# 3. Run:  BASE_URL="http://192.168.x.x:8787" TOKEN="<token>" ./scripts/verify-remote.sh
#
# Checks: auth is enforced, the API key is NOT exposed to the phone, the remote
# filesystem is confined, and SSRF is blocked. Exits non-zero on any failure.
set -uo pipefail

: "${BASE_URL:?set BASE_URL, for example http://192.168.1.20:8787}"
: "${TOKEN:?set TOKEN from the app Away-mode panel}"

pass=0
fail=0

ok() {
  echo "PASS - $1"
  pass=$((pass + 1))
}
bad() {
  echo "FAIL - $1"
  fail=$((fail + 1))
}

# rpc <command> <json-body> <auth:yes|no> -> sets CODE and BODY.
# No bash arrays, so it parses under macOS's default bash 3.2.
rpc() {
  local cmd="$1"
  local body="$2"
  local auth="$3"
  if [ "$auth" = "yes" ]; then
    CODE=$(curl -s -o /tmp/vr_body -w "%{http_code}" -X POST \
      -H "Content-Type: application/json" -H "Authorization: Bearer ${TOKEN}" \
      --data "$body" "${BASE_URL}/rpc/${cmd}" 2>/dev/null || echo "000")
  else
    CODE=$(curl -s -o /tmp/vr_body -w "%{http_code}" -X POST \
      -H "Content-Type: application/json" \
      --data "$body" "${BASE_URL}/rpc/${cmd}" 2>/dev/null || echo "000")
  fi
  BODY=$(cat /tmp/vr_body 2>/dev/null)
}

echo "== Probing ${BASE_URL} =="

# 1. Unauthenticated command must be rejected.
rpc system_info '{}' no
if [ "$CODE" = "401" ]; then
  ok "unauthenticated request rejected (401)"
else
  bad "unauthenticated request NOT rejected (got $CODE)"
fi

# 2. Authenticated command works.
rpc system_info '{}' yes
if [ "$CODE" = "200" ] && echo "$BODY" | grep -q "ramGb"; then
  ok "authenticated request works"
else
  bad "authenticated system_info failed (code $CODE)"
fi

# 3. The API key must NOT be exposed to the phone.
rpc get_remote_settings '{}' yes
if echo "$BODY" | grep -Eq '"(openrouterKey|customKey)":"sk-[A-Za-z0-9_-]{8,}'; then
  bad "REAL API KEY exposed to the phone!"
else
  ok "API key not exposed to the phone (sentinel/empty only)"
fi
if echo "$BODY" | grep -q '"remoteToken"'; then
  bad "pairing token leaked to the phone"
else
  ok "pairing token not leaked"
fi

# 4. Remote filesystem is confined to the workspace root.
rpc fs_read '{"path":"/etc/passwd"}' yes
if echo "$BODY" | grep -qi "outside the remote workspace\|can't use\|bad path"; then
  ok "fs_read outside workspace blocked"
else
  bad "fs_read reached outside the workspace! ($BODY)"
fi

rpc fs_read '{"path":"~/.ssh/id_rsa"}' yes
if echo "$BODY" | grep -qi "can't use ~\|outside the remote workspace\|bad path"; then
  ok "fs_read of ~/.ssh blocked"
else
  bad "fs_read of ~/.ssh not blocked ($BODY)"
fi

# 5. SSRF: internal / metadata hosts must be refused.
rpc web_fetch '{"url":"http://169.254.169.254/latest/meta-data/"}' yes
if echo "$BODY" | grep -qi "private/loopback/link-local\|could not resolve\|refusing"; then
  ok "web_fetch SSRF (metadata IP) blocked"
else
  bad "web_fetch reached a link-local address! ($BODY)"
fi

rpc web_fetch '{"url":"http://localhost:11434/"}' yes
if echo "$BODY" | grep -qi "private/loopback/link-local\|refusing"; then
  ok "web_fetch SSRF (localhost) blocked"
else
  bad "web_fetch reached localhost! ($BODY)"
fi

echo "== $pass passed, $fail failed =="
[ "$fail" -eq 0 ]
