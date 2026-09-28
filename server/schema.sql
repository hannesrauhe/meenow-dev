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
CREATE TABLE IF NOT EXISTS group_members (
    group_id   VARCHAR(64)  NOT NULL,
    account    VARCHAR(191) NOT NULL,
    acct       VARCHAR(191) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, account),
    KEY account (account)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
