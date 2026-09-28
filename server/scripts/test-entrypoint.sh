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
  "proxied_instances" => ["pixelfed.de"],
  "db" => ["host" => getenv("DBH"), "name" => "meenow", "user" => "meenow", "pass" => "meenowpw"],
  "vapid" => ["subject" => "mailto:test@meenow.de",
              "key_file" => "/app/config/vapid.json"],
  "cron_key" => "testkey123",
  "rate_limit" => ["window_s" => 60, "max" => 5],
  "xkcd_cache" => "/tmp/xkcd.json",
  // The suite runs on dummy Bearer tokens with no reachable instance, so the
  // identity check that production relies on has to be off here. Everything else
  // about invites, admin and bans is exercised for real.
  "verify_group_accounts" => false,
  "invite_ttl_s" => 14400,
  "invite_max_uses" => 5,
  // Lets the last checks prove errors surface in the response body (the app
  // shows this text so failures are debuggable without server logs).
  "debug" => true];
file_put_contents("/app/config/config.php", "<?php return " . var_export($cfg, true) . ";");'
[ -s config/config.php ] && ok "config written" || bad "config written" "empty"

# Schema through migrate.php — the exact path install.sh uses, so the migration
# code (not just schema.sql) is exercised on every run.
php scripts/migrate.php > /tmp/migrate.out 2>&1 && ok "migrate baseline" || bad "migrate baseline" "$(cat /tmp/migrate.out)"
# Simulate an install predating subscriptions.account, then re-run: the guarded
# ALTER must fire again and keep existing rows (schema.sql alone can't do this).
php -r '
$p = new PDO("mysql:host=".getenv("DB_HOST").";dbname=meenow","meenow","meenowpw",[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
$p->exec("ALTER TABLE subscriptions DROP KEY account");
$p->exec("ALTER TABLE subscriptions DROP COLUMN account");
$p->exec("INSERT INTO subscriptions (endpoint,p256dh,auth) VALUES (\"https://legacy/p\",\"a\",\"b\")");'
UP=$(php scripts/migrate.php 2>&1) || true
check "migrate upgrade fires" 'apply' "$UP"
LEG=$(php -r '$p=new PDO("mysql:host=".getenv("DB_HOST").";dbname=meenow","meenow","meenowpw"); $c=$p->query("SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=\"subscriptions\" AND COLUMN_NAME=\"account\"")->fetchColumn(); echo $c.":".$p->query("SELECT account=\"\" FROM subscriptions WHERE endpoint=\"https://legacy/p\"")->fetchColumn();')
check "migrate kept legacy row + column" '1:1' "$LEG"
# Drop the legacy row so it doesn't skew the later cron-tick subscription count.
php -r '$p=new PDO("mysql:host=".getenv("DB_HOST").";dbname=meenow","meenow","meenowpw"); $p->exec("DELETE FROM subscriptions WHERE endpoint=\"https://legacy/p\"");'

# --- smoke test ---------------------------------------------------------------
SMOKE=$(php scripts/smoke.php 2>&1) && check "smoke.php" "All checks passed" "$SMOKE" || bad "smoke.php" "$SMOKE"

# --- web endpoints ------------------------------------------------------------
php -S 127.0.0.1:8080 scripts/router.php > /tmp/websrv.log 2>&1 &
WEB=$!
sleep 2
H() { php scripts/http.php "$@"; }
H2() { php scripts/http-multipart.php "$@"; }

check "health" '"ok":true' "$(H GET http://127.0.0.1:8080/health)"
check "cron bad key" 'bad_key' "$(H GET 'http://127.0.0.1:8080/cron?key=nope')"
# /push/subscribe + /push/unsubscribe need a Bearer token (public-key stays open).
check "push 401 no auth" 'authorization_required' "$(H POST http://127.0.0.1:8080/push/subscribe \
  '{"endpoint":"https://example.org/p/zz","keys":{"p256dh":"a","auth":"b"}}')"
check "push invalid body" 'invalid_subscription' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/push/subscribe '{}')"
check "push subscribe" '"ok":true' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/push/subscribe \
  '{"endpoint":"https://example.org/p/abc","keys":{"p256dh":"BKdZ","auth":"d2hhdGV2ZXI"},"tz":"Europe/Berlin","account":"pixelfed.social:42"}')"
check "push bad tz" '"ok":true' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/push/subscribe \
  '{"endpoint":"https://example.org/p/def","keys":{"p256dh":"BKdZ","auth":"d2hhdGV2ZXI"},"tz":"Not/AZone!!"}')"
# The owning account is stored on subscribe (empty when not sent).
ACCT=$(php -r '$c=require "config/config.php"; echo (new PDO("mysql:host=".$c["db"]["host"].";dbname=".$c["db"]["name"], $c["db"]["user"], $c["db"]["pass"]))->query("SELECT account FROM subscriptions WHERE endpoint=\"https://example.org/p/abc\"")->fetchColumn();')
check "push account stored" 'pixelfed.social:42' "$ACCT"
check "push unsubscribe" '"ok":true' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/push/unsubscribe \
  '{"endpoint":"https://example.org/p/abc"}')"

# Proxy against the real home instance (unauthenticated public endpoint).
# Fresh rate-limit budget: the push checks above consumed it (max=5/min here).
php -r '$c=require "config/config.php"; $p=new PDO("mysql:host=".$c["db"]["host"].";dbname=".$c["db"]["name"], $c["db"]["user"], $c["db"]["pass"]); $p->exec("DELETE FROM rate_hits");'
check "proxy passthrough" '"uri"' "$(MEENOW_AUTH='Bearer testtoken' H GET http://127.0.0.1:8080/api/v1/instance)"
# No anonymous relaying: /api without a Bearer token is refused by us (401),
# while the two bootstrap endpoints stay open (apps POST, oauth/token).
check "proxy 401 no auth" 'authorization_required' "$(H GET http://127.0.0.1:8080/api/v1/timelines/home)"
# Second-instance routing: allowlisted host passes through, others 404, and the
# auth gate applies under /i/ too.
check "proxy /i passthrough" '"uri"' "$(MEENOW_AUTH='Bearer testtoken' H GET http://127.0.0.1:8080/i/pixelfed.de/api/v1/instance)"
check "proxy /i 401 no auth" 'authorization_required' "$(H GET http://127.0.0.1:8080/i/pixelfed.de/api/v1/timelines/home)"
check "proxy /i not allowed" 'not_found' "$(MEENOW_AUTH='Bearer t' H GET http://127.0.0.1:8080/i/evil.example/api/v1/timelines/home)"
# Regression: JSON POST bodies must keep Content-Type: application/json when
# forwarded (Apache exposes it only as CONTENT_TYPE, invisible to the HTTP_*
# loop; without the explicit add upstream sees form-encoded and rejects with
# 422 "client_name field is required").
check "proxy JSON POST" '"client_id"' "$(H POST http://127.0.0.1:8080/api/v1/apps \
  "{\"client_name\":\"meenow-test-$$\",\"redirect_uris\":\"http://127.0.0.1:8080/\",\"scopes\":\"read\"}")"
# Regression: multipart POST bodies (media uploads). PHP consumes them into
# $_POST/$_FILES and leaves php://input empty, so a raw-stream relay sends an
# empty form upstream — Pixelfed 422s "client_name field is required". The
# proxy must rebuild the form; the apps endpoint proves the fields arrive.
head -c 20000 /dev/urandom > /tmp/upload.jpg
check "proxy multipart POST" '"client_id"' "$(H2 http://127.0.0.1:8080/api/v1/apps \
  /tmp/upload.jpg client_name=meenow-mp-test-$$ redirect_uris=http://127.0.0.1:8080/ scopes=read)"
# xkcd: on-demand endpoint populates the cache on first hit, serves it after.
rm -f /tmp/xkcd.json
check "xkcd fetch" '"num"' "$(H GET http://127.0.0.1:8080/xkcd.json)"
[ -s /tmp/xkcd.json ] && ok "xkcd cache written" || bad "xkcd cache written" "missing"
check "xkcd cached" '"num"' "$(H GET http://127.0.0.1:8080/xkcd.json)"
check "unknown path 404" 'not_found' "$(H GET http://127.0.0.1:8080/admin)"

# --- bootstrap groups -----------------------------------------------------
# The Bearer token is not validated here (the instance does that), so a dummy
# one exercises the endpoints. Budget clears: this config caps at 5 req/min.
CLR() { php -r '$c=require "config/config.php"; $p=new PDO("mysql:host=".$c["db"]["host"].";dbname=".$c["db"]["name"], $c["db"]["user"], $c["db"]["pass"]); $p->exec("DELETE FROM rate_hits");'; }
GOUT=$(php scripts/groups.php create test "Test group" 2>&1) && ok "groups CLI create" || bad "groups CLI create" "$GOUT"
GOUT=$(php scripts/groups.php add test pixelfed.social:1 alice@pixelfed.social 2>&1) && ok "groups CLI add" || bad "groups CLI add" "$GOUT"
check "groups 401 no auth" 'authorization_required' "$(H GET http://127.0.0.1:8080/groups/test)"
CLR
check "groups show" 'alice@pixelfed.social' "$(MEENOW_AUTH='Bearer t' H GET http://127.0.0.1:8080/groups/test)"
# The admin is derived, never stored: the oldest member row. Alice was seeded,
# so she runs the group, and a later joiner does not.
check "groups admin is oldest" '"admin":true' "$(MEENOW_AUTH='Bearer t' H GET 'http://127.0.0.1:8080/groups/test?account=pixelfed.social:1')"
check "groups non-admin" '"admin":false' "$(MEENOW_AUTH='Bearer t' H GET 'http://127.0.0.1:8080/groups/test?account=pixelfed.social:7')"
CLR

# --- invites: a link carries a token, never the group slug ------------------
GOUT=$(php scripts/groups.php invite test 2>&1) && ok "groups CLI invite" || bad "groups CLI invite" "$GOUT"
TOKEN=$(printf '%s' "$GOUT" | sed -n 's/^token  *//p')
case "$TOKEN" in *[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ok "invite token minted";; *) bad "invite token minted" "$GOUT";; esac
check "redeem previews roster" 'alice@pixelfed.social' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/redeem "{\"token\":\"$TOKEN\"}")"
check "redeem unknown token" 'invite_not_found' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/redeem '{"token":"00000000000000000000000000000000"}')"
# A wrong-length token is rejected on shape, without a lookup: probes and typos
# cannot spend rate-limit budget on the database.
check "redeem malformed token" 'invite_not_found' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/redeem '{"token":"nope"}')"
CLR
# Redeeming must not consume anything — a link can be opened, abandoned, reopened.
check "redeem does not consume" '0' "$(php -r '$c=require "config/config.php"; echo (new PDO("mysql:host=".$c["db"]["host"].";dbname=".$c["db"]["name"], $c["db"]["user"], $c["db"]["pass"]))->query("SELECT uses FROM group_invites WHERE token=\"'"$TOKEN"'\"")->fetchColumn();')"

# --- expiry and exhaustion --------------------------------------------------
php -r '$c=require "config/config.php"; $p=new PDO("mysql:host=".$c["db"]["host"].";dbname=".$c["db"]["name"],$c["db"]["user"],$c["db"]["pass"]); $p->prepare("INSERT INTO group_invites (token,group_id,expires_at,max_uses) VALUES (?,?,?,?)")->execute(["deadbeefdeadbeefdeadbeefdeadbeef","test",time()-10,5]); $p->prepare("INSERT INTO group_invites (token,group_id,expires_at,max_uses,uses,last_used_by) VALUES (?,?,?,?,?,?)")->execute(["beefbeefbeefbeefbeefbeefbeefbeef","test",time()+3600,1,1,"pixelfed.social:99"]);'
check "expired invite" 'invite_expired' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/redeem '{"token":"deadbeefdeadbeefdeadbeefdeadbeef"}')"
check "exhausted invite" 'invite_exhausted' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/join \
  '{"account":"pixelfed.social:8","acct":"carol@pixelfed.social","token":"beefbeefbeefbeefbeefbeefbeefbeef"}')"
CLR

# A stranger needs a token to enter; a member does not need one to stay.
check "join needs token" 'invite_required' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/join \
  '{"account":"pixelfed.social:7","acct":"bob@pixelfed.social"}')"
check "groups join" '"joined":true' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/join \
  "{\"account\":\"pixelfed.social:7\",\"acct\":\"bob@pixelfed.social\",\"token\":\"$TOKEN\"}")"
# Re-joining is idempotent and says so, so the app can skip the follow-all.
check "groups join idempotent" '"joined":false' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/join \
  "{\"account\":\"pixelfed.social:7\",\"acct\":\"bob@pixelfed.social\",\"token\":\"$TOKEN\"}")"
check "groups mine" '"test"' "$(MEENOW_AUTH='Bearer t' H GET 'http://127.0.0.1:8080/groups/mine?account=pixelfed.social:7')"
# uses counts DISTINCT accounts (last_used_by), so Bob's retry did not shrink a
# 5-use link. The cap guards against a link being passed around, not retries.
USES=$(php -r '$c=require "config/config.php"; echo (new PDO("mysql:host=".$c["db"]["host"].";dbname=".$c["db"]["name"], $c["db"]["user"], $c["db"]["pass"]))->query("SELECT uses FROM group_invites WHERE token=\"'"$TOKEN"'\"")->fetchColumn();')
check "invite use counted once per account" '1' "$USES"
CLR

# --- events: what a member's device must act on -----------------------------
check "events reach members" '"kind":"join"' "$(MEENOW_AUTH='Bearer t' H GET 'http://127.0.0.1:8080/groups/events?account=pixelfed.social:1&since=0')"
# A newcomer is not told about their own join.
check "events skip own join" '"events":[]' "$(MEENOW_AUTH='Bearer t' H GET 'http://127.0.0.1:8080/groups/events?account=pixelfed.social:7&since=0')"
# The high-water mark works: asking from the newest id returns nothing.
check "events since respected" '"events":[]' "$(MEENOW_AUTH='Bearer t' H GET 'http://127.0.0.1:8080/groups/events?account=pixelfed.social:1&since=999999')"
CLR

# --- removal: admin-only, and it bans ---------------------------------------
check "remove by non-admin" 'not_admin' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/remove \
  '{"account":"pixelfed.social:1","actor":"pixelfed.social:7"}')"
# Removing yourself is leaving, which is a different verb with different effects.
check "remove self refused" 'cannot_remove_self' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/remove \
  '{"account":"pixelfed.social:1","actor":"pixelfed.social:1"}')"
check "groups remove" '"ok":true' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/remove \
  '{"account":"pixelfed.social:7","actor":"pixelfed.social:1"}')"
CLR
# A ban blocks both doors, so a kick cannot be undone with the same link — and
# redeem refuses before the join screen even shows the roster.
check "banned cannot join" 'banned' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/join \
  "{\"account\":\"pixelfed.social:7\",\"acct\":\"bob@pixelfed.social\",\"token\":\"$TOKEN\"}")"
check "banned cannot redeem" 'banned' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/redeem \
  "{\"token\":\"$TOKEN\",\"account\":\"pixelfed.social:7\"}")"
check "bans listed for admin" 'bob@pixelfed.social' "$(MEENOW_AUTH='Bearer t' H GET 'http://127.0.0.1:8080/groups/test?account=pixelfed.social:1')"
check "bans hidden from member" '"admin":false' "$(MEENOW_AUTH='Bearer t' H GET 'http://127.0.0.1:8080/groups/test?account=pixelfed.social:7')"
CLR
# The removal must reach the remaining members AND its subject: the subject is no
# longer in group_members, so this is the only way their device learns about it.
check "remove event for admin" '"kind":"remove"' "$(MEENOW_AUTH='Bearer t' H GET 'http://127.0.0.1:8080/groups/events?account=pixelfed.social:1&since=0')"
check "remove event for target" '"kind":"remove"' "$(MEENOW_AUTH='Bearer t' H GET 'http://127.0.0.1:8080/groups/events?account=pixelfed.social:7&since=0')"
# The ban set rides along so a device can refuse to auto-approve the ex-member's
# follow request, which is what would otherwise silently undo the kick.
check "bans ride with events" '"bans":[{' "$(MEENOW_AUTH='Bearer t' H GET 'http://127.0.0.1:8080/groups/events?account=pixelfed.social:1&since=0')"
CLR

# Unban, then the same token lets Bob back in — proving the block, not the link,
# was what refused him. The member row is not restored by the unban.
check "groups unban" '"ok":true' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/unban \
  '{"account":"pixelfed.social:7","actor":"pixelfed.social:1"}')"
check "unban by non-admin" 'not_admin' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/unban \
  '{"account":"pixelfed.social:7","actor":"pixelfed.social:8"}')"
check "unbanned can rejoin" '"joined":true' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/join \
  "{\"account\":\"pixelfed.social:7\",\"acct\":\"bob@pixelfed.social\",\"token\":\"$TOKEN\"}")"
# No member here has a push subscription, so the fan-out reports finding nobody
# rather than reaching the network.
check "groups announce" '"ok":true' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/announce)"
CLR

check "groups leave" '"ok":true' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/leave \
  '{"account":"pixelfed.social:7"}')"
check "groups leave removed" '"groups":[]' "$(MEENOW_AUTH='Bearer t' H GET 'http://127.0.0.1:8080/groups/mine?account=pixelfed.social:7')"
check "groups join unknown" 'group_not_found' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/nope/join \
  '{"account":"pixelfed.social:7","acct":"bob@pixelfed.social"}')"
check "groups join bad account" 'invalid_account' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/test/join \
  '{"account":"not-an-account"}')"
check "groups invite by stranger" 'not_member' "$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/groups/invite \
  '{"group":"test","account":"pixelfed.social:8"}')"
CLR

# --- operator CLI over the churned-up group ---------------------------------
GOUT=$(php scripts/groups.php invite test 2>&1) && ok "invite after churn" 'token' "$GOUT" || bad "invite after churn" "$GOUT"
# The joiner left; the seeded founding member remains, and holds the admin role.
GMEM=$(php scripts/groups.php members test 2>&1)
check "groups CLI members" 'alice@pixelfed.social' "$GMEM"
case "$GMEM" in *bob*) bad "groups leave (CLI view)" "bob still present: $GMEM";; *) ok "groups leave (CLI view)";; esac
case "$GMEM" in *ADMIN*) ok "CLI marks the admin";; *) bad "CLI marks the admin" "$GMEM";; esac
check "groups CLI invites" 'live' "$(php scripts/groups.php invites test 2>&1)"
check "groups CLI prune" 'pruned' "$(php scripts/groups.php prune 2>&1)"
# The expired row is gone; the live ones survive pruning.
LEFT=$(php -r '$c=require "config/config.php"; echo (new PDO("mysql:host=".$c["db"]["host"].";dbname=".$c["db"]["name"], $c["db"]["user"], $c["db"]["pass"]))->query("SELECT COUNT(*) FROM group_invites WHERE token=\"deadbeefdeadbeefdeadbeefdeadbeef\"")->fetchColumn();')
check "prune removed expired only" '0' "$LEFT"
check "groups CLI ban" 'banned' "$(php scripts/groups.php ban test pixelfed.social:8 carol@pixelfed.social 2>&1)"
check "groups CLI unban" 'unbanned' "$(php scripts/groups.php unban test pixelfed.social:8 2>&1)"
check "groups CLI list admin" 'admin=pixelfed.social:1' "$(php scripts/groups.php list 2>&1)"

# --- debug mode: errors reach the response body (the app shows them) --------
# Both php calls exit non-zero by design (an uncaught throw), hence `|| true`
# under set -e.
DBG=$(php -r 'require "src/bootstrap.php"; meenow_debug_handlers(); throw new RuntimeException("boom");' 2>/dev/null) || true
check "debug: error in body" '"error":"server_error"' "$DBG"
check "debug: message + site" 'boom' "$DBG"
# Without debug the handler is never installed: nothing reaches stdout (stderr
# is the log, not the response).
ND=$(php -r 'require "src/bootstrap.php"; throw new RuntimeException("secret-path");' 2>/dev/null) || true
case "$ND" in *secret-path*) bad "debug off: no leak" "$ND";; *) ok "debug off: no leak";; esac

# --- account verification (pure half — no instance needed) ------------------
# The success path returns a HANDLE, not a bool; a bool|null signature made it
# fatal on every real join. These pin the three outcomes.
VP=$(php -r '
require "src/bootstrap.php"; require "src/groups.php";
$ok = groups_verify_payload(["id"=>"42","acct"=>"Alice@pixelfed.social"], "pixelfed.social:42", "alice@pixelfed.social");
$badId = groups_verify_payload(["id"=>"43","acct"=>"alice@pixelfed.social"], "pixelfed.social:42", "alice@pixelfed.social");
$badAcct = groups_verify_payload(["id"=>"42","acct"=>"mallory@pixelfed.social"], "pixelfed.social:42", "alice@pixelfed.social");
$noId = groups_verify_payload(["acct"=>"alice@pixelfed.social"], "pixelfed.social:42", "alice@pixelfed.social");
printf "ok=%s badId=%s badAcct=%s noId=%s",
  var_export($ok, true), var_export($badId, true), var_export($badAcct, true), var_export($noId, true);
' 2>&1)
check "verify: success returns handle" "ok='alice@pixelfed.social'" "$VP"
check "verify: wrong id rejected" "badId=false" "$VP"
check "verify: wrong handle rejected" "badAcct=false" "$VP"
check "verify: missing id rejected" "noId=false" "$VP"

# Cron: tick runs (1 sub left), immediate rerun dedupes.
check "cron tick" '"subscriptions":1' "$(H GET 'http://127.0.0.1:8080/cron?action=tick&key=testkey123')"
check "cron dedupe" 'slot already ran' "$(H GET 'http://127.0.0.1:8080/cron?action=tick&key=testkey123')"

# Rate limit (max=5/min): earlier push/proxy calls consumed the budget; hammer.
# Authenticated — push() checks the token before the limiter, so an anonymous
# post 401s and never reaches it.
RL=""
for i in 1 2 3 4 5 6; do
  RL=$(MEENOW_AUTH='Bearer t' H POST http://127.0.0.1:8080/push/subscribe \
       '{"endpoint":"https://example.org/p/rl","keys":{"p256dh":"a","auth":"b"}}')
  case "$RL" in *STATUS\ 429*) break;; esac
done
check "rate limiter" "STATUS 429" "$RL"

kill $WEB 2>/dev/null || true
rm -f config/config.php config/vapid.json

# Proxy body/header unit tests (no server needed — they inspect what curl would
# be handed; this is where the multipart 422 regression is pinned down).
UT=$(php scripts/test-proxy-body.php 2>&1) && check "proxy unit tests" "FAIL=0" "$UT" \
  || bad "proxy unit tests" "$UT"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ]
