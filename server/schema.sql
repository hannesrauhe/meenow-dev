-- meenow server schema (MySQL / MariaDB — load with the mysql client)

-- Web Push subscriptions, one row per device subscription.
-- account is the self-asserted owner ("<instance>:<accountId>", empty for rows
-- written before ownership existed). Not a credential — the endpoint URL is the
-- capability — but it makes a row attributable: logout cleanup, and per-account
-- tick gating once the server learns who posted.
CREATE TABLE IF NOT EXISTS subscriptions (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    endpoint   VARCHAR(500) NOT NULL,
    p256dh     VARCHAR(128) NOT NULL,
    auth       VARCHAR(128) NOT NULL,
    tz         VARCHAR(64)  NOT NULL DEFAULT 'Europe/Berlin',
    account    VARCHAR(191) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY endpoint (endpoint(191)),
    KEY account (account)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-IP request counter for the proxy rate limit (one row per IP per minute).
-- ip is stored as text (not inet_pton binary): binary strings through a utf8mb4
-- PDO connection can be rejected as invalid charset data.
CREATE TABLE IF NOT EXISTS rate_hits (
    ip     VARCHAR(45) NOT NULL,
    minute INT UNSIGNED NOT NULL, -- floor(unix_ts / 60)
    cnt    SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    PRIMARY KEY (ip, minute)
) ENGINE=InnoDB DEFAULT CHARSET=ascii;

-- Cron slot dedupe: one row per 30-minute slot per action. Only the daily tick
-- uses the cron now (xkcd refreshes on request), but the action column keeps
-- room for more jobs.
CREATE TABLE IF NOT EXISTS cron_slots (
    slot   BIGINT UNSIGNED NOT NULL, -- floor(unix_ts / 1800)
    action VARCHAR(16) NOT NULL,
    ran_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (slot, action)
) ENGINE=InnoDB;

-- Bootstrap groups: named circles the operator creates (scripts/groups.php) so
-- a new user can join one via an invite link, have the app follow every member,
-- and become a member themselves. Pure bootstrap device — the follower circle
-- itself lives on the instance, not here. `groups` is a MySQL reserved word.
CREATE TABLE IF NOT EXISTS `groups` (
    id         VARCHAR(64) NOT NULL PRIMARY KEY, -- slug carried in invite links
    name       VARCHAR(100) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Membership, keyed on the self-asserted "<instance>:<accountId>" string (same
-- attribution model as subscriptions.account — not a credential). acct holds
-- the fediverse handle (user@instance) so joiners can resolve and follow the
-- member even across instances.
--
-- The ADMIN is not a column: it is the oldest row of a group (ORDER BY
-- created_at, account LIMIT 1 in groups.php). Deriving it means "the first
-- person who joined runs the group" needs no ceremony, and an admin who leaves
-- promotes the next-oldest automatically — a group can never end up adminless
-- while it has members. Caveat: `scripts/groups.php remove` on the admin row
-- silently shifts the role to the next member.
CREATE TABLE IF NOT EXISTS group_members (
    group_id   VARCHAR(64)  NOT NULL,
    account    VARCHAR(191) NOT NULL,
    acct       VARCHAR(191) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, account),
    KEY account (account)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Invite links. The group slug used to BE the link (/?group=<slug>), which made
-- every group reachable by guessing a name. An invite instead carries a random
-- 128-bit token and nothing else, so the slug never appears in a URL and groups
-- are not enumerable at all. Expiry + a use cap are what make a link that got
-- forwarded onward die on its own; guessing a token is not a realistic threat.
-- `uses` counts DISTINCT accounts (see last_used_by), so one person retrying a
-- join after a network hiccup does not burn the whole budget.
CREATE TABLE IF NOT EXISTS group_invites (
    token        CHAR(32) NOT NULL PRIMARY KEY, -- bin2hex(random_bytes(16))
    group_id     VARCHAR(64) NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at   BIGINT UNSIGNED NOT NULL,      -- unix seconds
    max_uses     SMALLINT UNSIGNED NOT NULL DEFAULT 5,
    uses         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    last_used_by VARCHAR(191) NOT NULL DEFAULT '',
    KEY group_id (group_id)
) ENGINE=InnoDB DEFAULT CHARSET=ascii;

-- Group activity log, the transport for everything members' devices need to be
-- told about. One rail, two verbs: kind 'join' makes every member auto-approve
-- and follow the newcomer, kind 'remove' makes them sever the follow. Both ride
-- the same web-push + service-worker + catch-up path, which is why removal works
-- for a device that was offline when it happened.
--
-- `account` is the SUBJECT of the event (who joined / who got removed), `actor`
-- who caused it ('' for a self-join). Rows are never deleted — not even when the
-- subject is removed — so the log doubles as the audit trail behind a kick.
CREATE TABLE IF NOT EXISTS group_events (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    group_id   VARCHAR(64) NOT NULL,
    kind       VARCHAR(16) NOT NULL,  -- 'join' | 'remove'
    account    VARCHAR(191) NOT NULL,
    acct       VARCHAR(191) NOT NULL DEFAULT '',
    actor      VARCHAR(191) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY group_created (group_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Evictions. A removal has to do more than delete a roster row: without this,
-- the kicked person could rejoin with any live invite, and — worse — their next
-- follow request would be AUTO-APPROVED by every member's device, silently
-- undoing the kick. So a ban blocks both rejoining and auto-approval until an
-- admin lifts it.
CREATE TABLE IF NOT EXISTS group_bans (
    group_id   VARCHAR(64)  NOT NULL,
    account    VARCHAR(191) NOT NULL,
    acct       VARCHAR(191) NOT NULL DEFAULT '',
    actor      VARCHAR(191) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, account)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Error capture, the readable replacement for cache/php-error.log (which
-- all-inkl will not show us). Raw rows, pruned by the cron.
-- kind: 'upstream' = a status Pixelfed sent back through the proxy;
--       'php'      = our own uncaught throw or fatal;
--       'cron'     = the scheduled tick went silent.
-- status 0 means the request never got an answer (curl transport error).
-- route is normalised (ids folded to :id) so one broken endpoint is one group.
-- ctx carries file:line, the build VERSION and a truncated sha256 of the
-- Bearer token — enough to group one user's retries without storing a credential.
CREATE TABLE IF NOT EXISTS errors (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    kind       VARCHAR(16) NOT NULL,
    status     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    method     VARCHAR(8)  NOT NULL DEFAULT '',
    route      VARCHAR(191) NOT NULL DEFAULT '',
    upstream   VARCHAR(191) NOT NULL DEFAULT '',
    message    VARCHAR(512) NOT NULL DEFAULT '',
    body       TEXT,
    ctx        TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY created (created_at),
    KEY route_status (route, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
