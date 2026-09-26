#!/bin/sh
# Runs INSIDE the php test container (compose service "php"). Exercises the full
# server against the compose "db". Exit non-zero on any failure.
set -eu
cd /app

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "OK   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL $1 — $2"; }
# check NAME EXPECTED ACTUAL_SUBSTRING
check() { case "$3" in *"$2"*) ok "$1";; *) bad "$1" "expected '$2' in: $3";; esac; }

export COMPOSER_HOME=/tmp/composer
mkdir -p config
composer install --no-interaction --no-progress --quiet

# --- VAPID keys + config + schema --------------------------------------------
php scripts/gen-vapid.php > /tmp/gen.out
[ -s config/vapid.json ] && ok "vapid keys generated" || bad "vapid keys generated" "$(cat /tmp/gen.out)"

DBH="${DB_HOST:-db}" php -r '
$cfg = ["home_instance" => "pixelfed.social",
  "db" => ["host" => getenv("DBH"), "name" => "meenow", "user" => "meenow", "pass" => "meenowpw"],
  "vapid" => ["subject" => "mailto:test@meenow.de",
              "key_file" => "/app/config/vapid.json"],
  "cron_key" => "testkey123",
  "rate_limit" => ["window_s" => 60, "max" => 5],
  "xkcd_cache" => "/tmp/xkcd.json"];
file_put_contents("/app/config/config.php", "<?php return " . var_export($cfg, true) . ";");'
[ -s config/config.php ] && ok "config written" || bad "config written" "empty"

php -r '
$pdo = new PDO("mysql:host=" . getenv("DB_HOST") . ";dbname=meenow", "meenow", "meenowpw");
$pdo->exec(file_get_contents("schema.sql"));'
ok "schema loaded"

# --- smoke test ---------------------------------------------------------------
SMOKE=$(php scripts/smoke.php 2>&1) && check "smoke.php" "All checks passed" "$SMOKE" || bad "smoke.php" "$SMOKE"

# --- web endpoints ------------------------------------------------------------
php -S 127.0.0.1:8080 scripts/router.php > /tmp/websrv.log 2>&1 &
WEB=$!
sleep 2
H() { php scripts/http.php "$@"; }

check "health" '"ok":true' "$(H GET http://127.0.0.1:8080/health)"
check "cron bad key" 'bad_key' "$(H GET 'http://127.0.0.1:8080/cron?key=nope')"
check "push invalid body" 'invalid_subscription' "$(H POST http://127.0.0.1:8080/push/subscribe '{}')"
check "push subscribe" '"ok":true' "$(H POST http://127.0.0.1:8080/push/subscribe \
  '{"endpoint":"https://example.org/p/abc","keys":{"p256dh":"BKdZ","auth":"d2hhdGV2ZXI"},"tz":"Europe/Berlin"}')"
check "push bad tz" '"ok":true' "$(H POST http://127.0.0.1:8080/push/subscribe \
  '{"endpoint":"https://example.org/p/def","keys":{"p256dh":"BKdZ","auth":"d2hhdGV2ZXI"},"tz":"Not/AZone!!"}')"
check "push unsubscribe" '"ok":true' "$(H POST http://127.0.0.1:8080/push/unsubscribe \
  '{"endpoint":"https://example.org/p/abc"}')"

# Proxy against the real home instance (unauthenticated public endpoint).
# Fresh rate-limit budget: the push checks above consumed it (max=5/min here).
php -r '$c=require "config/config.php"; $p=new PDO("mysql:host=".$c["db"]["host"].";dbname=".$c["db"]["name"], $c["db"]["user"], $c["db"]["pass"]); $p->exec("DELETE FROM rate_hits");'
check "proxy passthrough" '"uri"' "$(MEENOW_AUTH='Bearer testtoken' H GET http://127.0.0.1:8080/api/v1/instance)"
# No anonymous relaying: /api without a Bearer token is refused by us (401),
# while the two bootstrap endpoints stay open (apps POST, oauth/token).
check "proxy 401 no auth" 'authorization_required' "$(H GET http://127.0.0.1:8080/api/v1/timelines/home)"
# Regression: JSON POST bodies must keep Content-Type: application/json when
# forwarded (Apache/PHP hide it from HTTP_*; without the fix upstream sees
# form-encoded and rejects with 422 "client_name field is required").
check "proxy JSON POST" '"client_id"' "$(H POST http://127.0.0.1:8080/api/v1/apps \
  "{\"client_name\":\"meenow-test-$$\",\"redirect_uris\":\"http://127.0.0.1:8080/\",\"scopes\":\"read\"}")"
# xkcd: on-demand endpoint populates the cache on first hit, serves it after.
rm -f /tmp/xkcd.json
check "xkcd fetch" '"num"' "$(H GET http://127.0.0.1:8080/xkcd.json)"
[ -s /tmp/xkcd.json ] && ok "xkcd cache written" || bad "xkcd cache written" "missing"
check "xkcd cached" '"num"' "$(H GET http://127.0.0.1:8080/xkcd.json)"
check "unknown path 404" 'not_found' "$(H GET http://127.0.0.1:8080/admin)"

# Cron: tick runs (1 sub left), immediate rerun dedupes.
check "cron tick" '"subscriptions":1' "$(H GET 'http://127.0.0.1:8080/cron?action=tick&key=testkey123')"
check "cron dedupe" 'slot already ran' "$(H GET 'http://127.0.0.1:8080/cron?action=tick&key=testkey123')"

# Rate limit (max=5/min): earlier push/proxy calls consumed the budget; hammer.
RL=""
for i in 1 2 3 4 5 6; do
  RL=$(H POST http://127.0.0.1:8080/push/subscribe \
       '{"endpoint":"https://example.org/p/rl","keys":{"p256dh":"a","auth":"b"}}')
  case "$RL" in *STATUS\ 429*) break;; esac
done
check "rate limiter" "STATUS 429" "$RL"

kill $WEB 2>/dev/null || true
rm -f config/config.php config/vapid.json
echo
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
