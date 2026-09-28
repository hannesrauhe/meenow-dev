<?php
declare(strict_types=1);

// /groups/* — bootstrap groups: named circles the operator creates (see
// scripts/groups.php) so a new user can join one via an invite link, have the
// app follow every member, and become a member themselves. Membership is
// keyed on the "<instance>:<accountId>" string — the same attribution model
// as subscriptions.account: the Bearer token is required but validated by the
// instance, not here. The circle itself lives on the instance, not in this DB.
//
// Three things run on top of that roster, and they share one rail:
//
//   1. INVITES. A link carries a random 128-bit token, never the group slug,
//      so groups cannot be enumerated and a forwarded link expires on its own.
//   2. AUTO-APPROVE. A join writes a group_events row and web-pushes the other
//      members, whose devices then approve the newcomer's follow request and
//      follow back. The server CANNOT do this itself — it holds no instance
//      credentials, only the members' devices do.
//   3. REMOVAL. The oldest member is the admin (derived, never stored) and can
//      evict anyone, which writes a 'remove' event down the same rail so every
//      member's device severs the follow — plus a ban, so the kick is not
//      silently undone by the next auto-approved follow request.
//
// Because the server can only notify, every endpoint here is a roster write
// plus an optional push. The single exception is groups_verify_account(),
// which relays the CALLER's own Bearer token to their instance's
// verify_credentials purely to check an identity claim.

return function (string $path): void {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    // Same rule as the proxy and /push: no anonymous traffic.
    if (empty($_SERVER['HTTP_AUTHORIZATION'])) {
        meenow_json_response(401, ['error' => 'authorization_required']);
    }
    meenow_rate_limit();

    $pdo = meenow_db();
    $bearer = groups_bearer();

    // Literal routes FIRST: 'mine', 'events', 'invite' and 'redeem' are all
    // valid group slugs, so the /groups/<id> patterns below would otherwise
    // swallow them (and /groups/events would answer with a group named events).
    if ($path === '/groups/mine' && $method === 'GET') {
        groups_mine($pdo, $_GET['account'] ?? '');
    }
    if ($path === '/groups/events' && $method === 'GET') {
        groups_events($pdo, $_GET['account'] ?? '', $_GET['since'] ?? '0');
    }
    if ($path === '/groups/invite' && $method === 'POST') {
        $body = meenow_json_input();
        groups_invite($pdo, (string) ($body['group'] ?? ''), $body['account'] ?? '');
    }
    if ($path === '/groups/redeem' && $method === 'POST') {
        $body = meenow_json_input();
        groups_redeem($pdo, (string) ($body['token'] ?? ''), $body['account'] ?? null);
    }

    if (preg_match('#^/groups/([a-z0-9][a-z0-9-]{0,63})$#', $path, $m) === 1
        && $method === 'GET') {
        groups_show($pdo, $m[1], $_GET['account'] ?? '');
    }
    if (preg_match('#^/groups/([a-z0-9][a-z0-9-]{0,63})/(join|leave|remove|unban|announce)$#', $path, $m) === 1
        && $method === 'POST') {
        $body = meenow_json_input();
        $group = $m[1];
        // For join/leave `account` is the caller; for remove/unban it is the
        // TARGET and `actor` is the caller (only an admin may act). Keeping the
        // victim in `account` lets the ban/event code stay verb-agnostic.
        $account = groups_account_key($body['account'] ?? '');
        if ($account === null) {
            meenow_json_response(400, ['error' => 'invalid_account']);
        }
        switch ($m[2]) {
            case 'leave':
                groups_leave($pdo, $group, $account);
                break; // unreachable — leave exits — but correct if it ever returns
            case 'remove':
            case 'unban':
                $actor = groups_account_key($body['actor'] ?? '');
                if ($actor === null) {
                    meenow_json_response(400, ['error' => 'invalid_actor']);
                }
                if ($m[2] === 'remove') groups_remove($pdo, $group, $account, $actor);
                groups_unban($pdo, $group, $account, $actor);
                break;
            case 'announce':
                groups_announce($pdo, $group);
                break;
            default: // 'join'
                groups_join($pdo, $group, $account, $body['acct'] ?? null,
                    (string) ($body['token'] ?? ''), $bearer);
        }
    }
    meenow_json_response(404, ['error' => 'not_found']);
};

// The caller's Bearer token, needed only to relay an identity check to their
// own instance. Never logged, never stored.
function groups_bearer(): string
{
    $h = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    return preg_match('#^Bearer\s+(\S+)$#i', $h, $m) === 1 ? $m[1] : '';
}

// Respond, then keep working. The push fan-out in groups_notify() is N network
// round-trips to push services, and the person who tapped Join must not wait on
// them. Content-Length is set explicitly so the client can treat the response
// as complete while this script carries on; fastcgi_finish_request() is the
// real release (all-inkl runs PHP-FPM), the flush loop covers php -S and CLI.
function groups_respond_then(int $status, array $body, callable $then): void
{
    ignore_user_abort(true);
    $json = json_encode($body);
    http_response_code($status);
    header('Content-Type: application/json');
    header('Content-Length: ' . strlen((string) $json));
    echo $json;
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    } else {
        while (ob_get_level() > 0) ob_end_flush();
        flush();
    }
    try {
        $then();
    } catch (Throwable $e) {
        // The roster write already succeeded and the client already has its
        // answer; a failed push is recoverable through the events catch-up
        // endpoint, so it must not surface as a failed join.
        error_log('[groups] post-response work failed: ' . $e->getMessage());
    }
    exit;
}

// "<instance>:<accountId>" — self-asserted, so only shape-checked (same
// posture as the push subscribe endpoint). groups_verify_account() is what
// turns the claim into something the admin check can be trusted against.
function groups_account_key(mixed $account): ?string
{
    if (!is_string($account) || strlen($account) > 191) return null;
    return preg_match('#^[a-z0-9.-]+:[a-z0-9]+$#i', $account) === 1 ? $account : null;
}

// Fediverse handle (user@instance), normalised: lowercase, no leading @, and
// a bare same-instance username gets its domain from the account key.
function groups_acct(mixed $acct, string $account): ?string
{
    if (!is_string($acct)) return null;
    $acct = strtolower(ltrim(trim($acct), '@'));
    if ($acct === '' || strlen($acct) > 191) return null;
    if (!str_contains($acct, '@')) $acct .= '@' . explode(':', $account, 2)[0];
    if (strlen($acct) > 191
        || preg_match('#^[a-z0-9._%-]+@[a-z0-9.-]+$#i', $acct) !== 1) return null;
    return $acct;
}

// An invite token as carried in ?join=. Fixed 32 lowercase hex chars — anything
// else is a typo or a probe, and rejecting it on shape keeps lookups (and the
// rate limiter) free for real traffic.
function groups_token(mixed $token): ?string
{
    if (!is_string($token) || strlen($token) !== 32) return null;
    return ctype_xdigit($token) && strtolower($token) === $token ? $token : null;
}

function groups_exist(PDO $pdo, string $id): bool
{
    $st = $pdo->prepare('SELECT 1 FROM `groups` WHERE id = ?');
    $st->execute([$id]);
    return (bool) $st->fetchColumn();
}

function groups_show(PDO $pdo, string $id, mixed $accountRaw): void
{
    $st = $pdo->prepare('SELECT id, name FROM `groups` WHERE id = ?');
    $st->execute([$id]);
    $group = $st->fetch(PDO::FETCH_ASSOC);
    if (!$group) meenow_json_response(404, ['error' => 'group_not_found']);

    // Same ORDER BY as groups_is_admin: the first row IS the admin.
    $st = $pdo->prepare('SELECT account, acct FROM group_members WHERE group_id = ? ORDER BY created_at, account');
    $st->execute([$id]);

    // The caller identity is optional here: the roster is readable by any
    // signed-in user, but `admin` and the ban list are only ever about the
    // caller, and the ban list is only ever shown to the admin.
    $account = groups_account_key($accountRaw);
    $isAdmin = $account !== null && groups_is_admin($pdo, $id, $account);
    $body = [
        'id' => $group['id'],
        'name' => $group['name'],
        'members' => $st->fetchAll(PDO::FETCH_ASSOC),
        'admin' => $isAdmin,
    ];
    if ($isAdmin) {
        $st = $pdo->prepare('SELECT account, acct FROM group_bans WHERE group_id = ? ORDER BY created_at');
        $st->execute([$id]);
        $body['bans'] = $st->fetchAll(PDO::FETCH_ASSOC);
    }
    meenow_json_response(200, $body);
}

function groups_mine(PDO $pdo, mixed $accountRaw): void
{
    $account = groups_account_key($accountRaw);
    if ($account === null) meenow_json_response(400, ['error' => 'invalid_account']);

    // `admin` rides along because the Circle screen renders the admin affordance
    // straight from this list; without it it would need one /groups/<id> request
    // per group just to learn who runs it. Same derivation as groups_is_admin().
    // Positional params, in binding order: the subquery's comparison comes first.
    $st = $pdo->prepare(
        'SELECT g.id, g.name,
                (SELECT m2.account FROM group_members m2
                 WHERE m2.group_id = g.id ORDER BY m2.created_at, m2.account LIMIT 1) = ? AS admin
         FROM `groups` g
         JOIN group_members m ON m.group_id = g.id
         WHERE m.account = ? ORDER BY g.name'
    );
    $st->execute([$account, $account]);
    $rows = $st->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$row) {
        $row['admin'] = (bool) $row['admin'];
    }
    meenow_json_response(200, ['groups' => $rows]);
}

// The admin is DERIVED, never stored: the oldest member of the group. That is
// what makes "whoever joined first runs it" need no ceremony, and what makes
// an admin leaving promote the next-oldest with no code at all — the row that
// answers this query simply changes. `account` breaks a created_at tie so the
// answer is deterministic.
function groups_is_admin(PDO $pdo, string $groupId, string $account): bool
{
    $st = $pdo->prepare(
        'SELECT account FROM group_members WHERE group_id = ?
         ORDER BY created_at, account LIMIT 1'
    );
    $st->execute([$groupId]);
    return $st->fetchColumn() === $account;
}

function groups_need_admin(PDO $pdo, string $groupId, string $actor): void
{
    if (!groups_is_admin($pdo, $groupId, $actor)) {
        meenow_json_response(403, ['error' => 'not_admin']);
    }
}

function groups_is_banned(PDO $pdo, string $groupId, string $account): bool
{
    $st = $pdo->prepare('SELECT 1 FROM group_bans WHERE group_id = ? AND account = ?');
    $st->execute([$groupId, $account]);
    return (bool) $st->fetchColumn();
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

// Mint an invite. Any member may do it — the group is a small-community
// bootstrap device, not a hierarchy — but a non-member may not, which is what
// keeps link distribution inside the circle.
function groups_invite(PDO $pdo, string $groupId, mixed $accountRaw): void
{
    $account = groups_account_key($accountRaw);
    if ($account === null) meenow_json_response(400, ['error' => 'invalid_account']);
    if (!groups_exist($pdo, $groupId)) meenow_json_response(404, ['error' => 'group_not_found']);

    $st = $pdo->prepare('SELECT 1 FROM group_members WHERE group_id = ? AND account = ?');
    $st->execute([$groupId, $account]);
    if (!$st->fetchColumn()) meenow_json_response(403, ['error' => 'not_member']);

    $cfg = meenow_config();
    $ttl = max(60, (int) ($cfg['invite_ttl_s'] ?? 14400));
    $maxUses = max(1, (int) ($cfg['invite_max_uses'] ?? 5));
    $token = bin2hex(random_bytes(16));
    $expires = time() + $ttl;

    $pdo->prepare(
        'INSERT INTO group_invites (token, group_id, expires_at, max_uses) VALUES (?, ?, ?, ?)'
    )->execute([$token, $groupId, $expires, $maxUses]);

    meenow_json_response(200, [
        'ok' => true,
        'token' => $token,
        'group' => $groupId,
        'expires_at' => $expires,
        'max_uses' => $maxUses,
    ]);
}

// Look an invite up and hand back what the join screen previews. Deliberately
// does NOT consume a use: the budget is spent by the join, so a link can be
// opened, abandoned and reopened without burning anyone's allowance.
//
// The caller's account is optional (the preview works before the app has settled
// who you are), but when present a ban is answered HERE rather than at join
// time — "you can't join this group" is worth showing before someone reads the
// member list and taps Join.
function groups_redeem(PDO $pdo, string $tokenRaw, mixed $accountRaw): void
{
    $token = groups_token($tokenRaw);
    if ($token === null) meenow_json_response(404, ['error' => 'invite_not_found']);

    $st = $pdo->prepare(
        'SELECT i.group_id, i.expires_at, i.uses, i.max_uses, g.name
         FROM group_invites i JOIN `groups` g ON g.id = i.group_id WHERE i.token = ?'
    );
    $st->execute([$token]);
    $invite = $st->fetch(PDO::FETCH_ASSOC);
    if (!$invite) meenow_json_response(404, ['error' => 'invite_not_found']);
    if ((int) $invite['expires_at'] < time()) {
        meenow_json_response(410, ['error' => 'invite_expired']);
    }

    $account = groups_account_key($accountRaw);
    if ($account !== null && groups_is_banned($pdo, (string) $invite['group_id'], $account)) {
        meenow_json_response(403, ['error' => 'banned']);
    }

    $st = $pdo->prepare('SELECT account, acct FROM group_members WHERE group_id = ? ORDER BY created_at, account');
    $st->execute([$invite['group_id']]);

    meenow_json_response(200, [
        'id' => $invite['group_id'],
        'name' => $invite['name'],
        'members' => $st->fetchAll(PDO::FETCH_ASSOC),
        'expires_at' => (int) $invite['expires_at'],
        // The screen can warn before the join fails: uses counts distinct
        // accounts, so this is "probably spent", not a hard verdict.
        'probably_spent' => (int) $invite['uses'] >= (int) $invite['max_uses'],
    ]);
}

// Consume one use of an invite, in the caller's name. Must run inside a
// transaction (the FOR UPDATE serialises concurrent joins on one token).
//
// `uses` counts DISTINCT accounts, tracked through last_used_by: someone whose
// join failed halfway (network, 5xx) retries against the same token and must
// not watch a 5-use link shrink tap by tap. The cap guards against a link being
// passed around, not against retries.
function groups_consume_invite(PDO $pdo, string $token, string $account): array
{
    $st = $pdo->prepare('SELECT * FROM group_invites WHERE token = ? FOR UPDATE');
    $st->execute([$token]);
    $invite = $st->fetch(PDO::FETCH_ASSOC);
    if (!$invite) meenow_json_response(404, ['error' => 'invite_not_found']);
    if ((int) $invite['expires_at'] < time()) {
        meenow_json_response(410, ['error' => 'invite_expired']);
    }
    if ($invite['last_used_by'] !== $account) {
        if ((int) $invite['uses'] >= (int) $invite['max_uses']) {
            meenow_json_response(410, ['error' => 'invite_exhausted']);
        }
        $pdo->prepare('UPDATE group_invites SET uses = uses + 1, last_used_by = ? WHERE token = ?')
            ->execute([$account, $token]);
    }
    return $invite;
}

// ---------------------------------------------------------------------------
// Roster writes
// ---------------------------------------------------------------------------

function groups_join(PDO $pdo, string $id, string $account, mixed $acctRaw, string $tokenRaw, string $bearer): void
{
    if (!groups_exist($pdo, $id)) meenow_json_response(404, ['error' => 'group_not_found']);
    if (groups_is_banned($pdo, $id, $account)) {
        meenow_json_response(403, ['error' => 'banned']);
    }
    $acct = groups_acct($acctRaw, $account);
    if ($acct === null) meenow_json_response(400, ['error' => 'invalid_acct']);

    // Prove the claim before anything is written. Membership drives auto-approve
    // and the admin check, both of which act on the STORED string, so an
    // unverified join is a planted row everyone would then follow and approve.
    $verified = groups_verify_account($account, $bearer, $acct);
    if ($verified === false) meenow_json_response(403, ['error' => 'account_mismatch']);
    if ($verified !== null) $acct = $verified; // authoritative handle, self-heals renames

    $st = $pdo->prepare('SELECT 1 FROM group_members WHERE group_id = ? AND account = ?');
    $st->execute([$id, $account]);
    $alreadyMember = (bool) $st->fetchColumn();

    // A token is required to ENTER, not to stay: a member re-joining (new
    // device, reinstall, acct self-heal) must keep working without one,
    // otherwise an expired link could lock someone out of their own group.
    $token = groups_token($tokenRaw);
    if (!$alreadyMember && $token === null) {
        meenow_json_response(403, ['error' => 'invite_required']);
    }

    $eventId = 0;
    if (!$alreadyMember) {
        $pdo->beginTransaction();
        try {
            groups_consume_invite($pdo, (string) $token, $account);
            // Idempotent; the acct refresh self-heals account renames.
            $st = $pdo->prepare(
                'INSERT INTO group_members (group_id, account, acct) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE acct = VALUES(acct)'
            );
            $st->execute([$id, $account, $acct]);
            $st = $pdo->prepare(
                'INSERT INTO group_events (group_id, kind, account, acct, actor) VALUES (?, ?, ?, ?, ?)'
            );
            $st->execute([$id, 'join', $account, $acct, '']);
            $eventId = (int) $pdo->lastInsertId();
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }
    } else {
        // Already a member: refresh the acct, and spend the use if they did
        // arrive through a live link (log nothing — the roster did not change).
        $pdo->prepare('UPDATE group_members SET acct = ? WHERE group_id = ? AND account = ?')
            ->execute([$acct, $id, $account]);
        if ($token !== null) {
            $pdo->beginTransaction();
            try {
                groups_consume_invite($pdo, $token, $account);
                $pdo->commit();
            } catch (Throwable $e) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                throw $e;
            }
        }
        meenow_json_response(200, ['ok' => true, 'joined' => false]);
    }

    groups_respond_then(200, ['ok' => true, 'joined' => true, 'event' => $eventId],
        static function () use ($eventId): void { groups_notify(meenow_db(), $eventId); });
}

function groups_leave(PDO $pdo, string $id, string $account): void
{
    $st = $pdo->prepare('DELETE FROM group_members WHERE group_id = ? AND account = ?');
    $st->execute([$id, $account]);
    // Deliberately inert: leaving a group never unfollows anyone and is not
    // announced. Removal is the imposed version of this and does both.
    meenow_json_response(200, ['ok' => true]);
}

// Evict + ban. Admin-only, and idempotent by design: the target may already
// have left, in which case banning them is still the right thing to do. A
// double tap is therefore harmless rather than a 404.
function groups_remove(PDO $pdo, string $id, string $account, string $actor): void
{
    if (!groups_exist($pdo, $id)) meenow_json_response(404, ['error' => 'group_not_found']);
    groups_need_admin($pdo, $id, $actor);
    if ($account === $actor) {
        // Removing yourself is leaving — with the difference that leaving does
        // not ban you or sever anything.
        meenow_json_response(400, ['error' => 'cannot_remove_self']);
    }

    $st = $pdo->prepare('SELECT acct FROM group_members WHERE group_id = ? AND account = ?');
    $st->execute([$id, $account]);
    $acct = (string) ($st->fetchColumn() ?: '');
    if ($acct === '') {
        // Not (or no longer) a member: fall back to any handle a previous ban
        // recorded, so the announcement still names a person.
        $st = $pdo->prepare('SELECT acct FROM group_bans WHERE group_id = ? AND account = ?');
        $st->execute([$id, $account]);
        $acct = (string) ($st->fetchColumn() ?: $account);
    }

    $pdo->beginTransaction();
    try {
        $pdo->prepare('DELETE FROM group_members WHERE group_id = ? AND account = ?')->execute([$id, $account]);
        $pdo->prepare(
            'INSERT INTO group_bans (group_id, account, acct, actor) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE acct = VALUES(acct), actor = VALUES(actor)'
        )->execute([$id, $account, $acct, $actor]);
        $st = $pdo->prepare(
            'INSERT INTO group_events (group_id, kind, account, acct, actor) VALUES (?, ?, ?, ?, ?)'
        );
        $st->execute([$id, 'remove', $account, $acct, $actor]);
        $eventId = (int) $pdo->lastInsertId();
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }

    groups_respond_then(200, ['ok' => true, 'event' => $eventId],
        static function () use ($eventId): void { groups_notify(meenow_db(), $eventId); });
}

// Lift a ban. The member row is NOT restored — they come back the way anyone
// does, through a fresh invite link, which is also what proves they still want in.
function groups_unban(PDO $pdo, string $id, string $account, string $actor): void
{
    if (!groups_exist($pdo, $id)) meenow_json_response(404, ['error' => 'group_not_found']);
    groups_need_admin($pdo, $id, $actor);
    $st = $pdo->prepare('DELETE FROM group_bans WHERE group_id = ? AND account = ?');
    $st->execute([$id, $account]);
    meenow_json_response(200, ['ok' => true]);
}

// Re-push a group's newest event. The escape hatch for a device that was
// offline past the push TTL; the events endpoint already covers it on next
// open, so this is an operator convenience, not a correctness mechanism.
function groups_announce(PDO $pdo, string $id): void
{
    if (!groups_exist($pdo, $id)) meenow_json_response(404, ['error' => 'group_not_found']);
    $st = $pdo->prepare('SELECT id FROM group_events WHERE group_id = ? ORDER BY id DESC LIMIT 1');
    $st->execute([$id]);
    $eventId = (int) $st->fetchColumn();
    if ($eventId === 0) meenow_json_response(404, ['error' => 'no_events']);
    meenow_json_response(200, ['ok' => true] + groups_notify($pdo, $eventId));
}

// ---------------------------------------------------------------------------
// Catch-up: the same information the push carries, for a device that missed it
// ---------------------------------------------------------------------------

// Events this account still needs, oldest first, plus the bans that apply to
// it. The recipient rule MIRRORS groups_event_recipients() on purpose — if the
// two ever disagree, a device that was offline ends up in a different state
// from one that received the push, which is the worst kind of bug for a social
// graph. Keep the two in sync.
function groups_events(PDO $pdo, mixed $accountRaw, mixed $sinceRaw): void
{
    $account = groups_account_key($accountRaw);
    if ($account === null) meenow_json_response(400, ['error' => 'invalid_account']);
    $since = max(0, (int) $sinceRaw);

    $st = $pdo->prepare(
        "SELECT e.id, e.group_id, e.kind, e.account, e.acct, e.actor, g.name
         FROM group_events e
         JOIN `groups` g ON g.id = e.group_id
         WHERE e.id > ? AND (
             (e.kind = 'join' AND e.account <> ?
              AND EXISTS (SELECT 1 FROM group_members m
                          WHERE m.group_id = e.group_id AND m.account = ?))
             OR (e.kind = 'remove' AND (
                    e.account = ?
                    OR (e.actor <> ? AND EXISTS (SELECT 1 FROM group_members m
                                                 WHERE m.group_id = e.group_id AND m.account = ?))))
         )
         ORDER BY e.id ASC LIMIT 50"
    );
    $st->execute([$since, $account, $account, $account, $account, $account]);
    $events = $st->fetchAll(PDO::FETCH_ASSOC);

    // The client needs the CURRENT ban set, not just the events: a banned
    // account's follow request outlives their membership, and auto-approving it
    // would undo the kick. Sent wholesale (it is tiny) so the client's set
    // self-heals any gap.
    $st = $pdo->prepare(
        'SELECT b.group_id, b.account, b.acct FROM group_bans b
         JOIN group_members m ON m.group_id = b.group_id WHERE m.account = ?'
    );
    $st->execute([$account]);
    $bans = $st->fetchAll(PDO::FETCH_ASSOC);

    meenow_json_response(200, ['events' => $events, 'bans' => $bans]);
}

// ---------------------------------------------------------------------------
// Identity verification
// ---------------------------------------------------------------------------

// Prove that the caller really is "<instance>:<accountId>". The instance must
// be on the proxy allowlist and is compared EXACTLY (same posture as
// proxy_instance()), so this can never be pointed at an arbitrary host; the
// caller's own token is relayed and nothing is stored. Returns the
// authoritative handle on success, false on a mismatch, null when
// verification is disabled (the Docker suite runs on dummy tokens).
//
// Why this is not optional in practice: membership is otherwise a
// self-asserted string, and both auto-approve and the admin check act on what
// is STORED. An unverified join is a row everyone follows and approves; an
// unverified `actor` is anyone claiming to be the admin.
function groups_verify_account(string $account, string $bearer, string $acct): bool|null
{
    $cfg = meenow_config();
    if (!($cfg['verify_group_accounts'] ?? true)) return null;
    if ($bearer === '') return false;

    $sep = strrpos($account, ':');
    $instance = strtolower(substr($account, 0, (int) $sep));
    $accountId = substr($account, $sep + 1);

    $allowed = array_map('strtolower', array_merge(
        [$cfg['home_instance'] ?? ''],
        $cfg['proxied_instances'] ?? []
    ));
    if ($instance === '' || !in_array($instance, $allowed, true)) return false;

    $ctx = stream_context_create(['http' => [
        'method' => 'GET',
        'header' => "Authorization: Bearer {$bearer}\r\nAccept: application/json\r\n",
        'ignore_errors' => true,
        'timeout' => 8,
    ]]);
    $raw = @file_get_contents("https://{$instance}/api/v1/accounts/verify_credentials", false, $ctx);
    if ($raw === false) return false;
    $me = json_decode($raw, true);
    if (!is_array($me) || !isset($me['id'])) return false;

    // The id is the claim that matters. The handle travels too so a stored acct
    // cannot drift from its account — and the returned value is what gets
    // written, which is how an account rename self-heals.
    if ((string) $me['id'] !== $accountId) return false;
    $trueAcct = groups_acct($me['acct'] ?? '', $account);
    return $trueAcct === $acct ? $trueAcct : false;
}

// ---------------------------------------------------------------------------
// Push fan-out
// ---------------------------------------------------------------------------

// Who must hear about an event. The actor never does (they caused it) and a
// join is not sent to the joiner. A removal DOES go to its subject: they are no
// longer in group_members, so the membership query below would otherwise never
// reach them.
function groups_event_recipients(PDO $pdo, array $event): array
{
    $st = $pdo->prepare('SELECT account FROM group_members WHERE group_id = ?');
    $st->execute([$event['group_id']]);
    $members = $st->fetchAll(PDO::FETCH_COLUMN);

    $recipients = array_values(array_diff(
        $members,
        array_filter([$event['actor']]),
        $event['kind'] === 'remove' ? [] : [$event['account']]
    ));
    if ($event['kind'] === 'remove') $recipients[] = $event['account'];

    return array_values(array_unique(array_filter($recipients)));
}

function groups_notify(PDO $pdo, int $eventId): array
{
    $st = $pdo->prepare(
        'SELECT e.*, g.name FROM group_events e JOIN `groups` g ON g.id = e.group_id WHERE e.id = ?'
    );
    $st->execute([$eventId]);
    $event = $st->fetch(PDO::FETCH_ASSOC);
    if (!$event) return ['pushed' => 0, 'reason' => 'event_not_found'];

    $recipients = groups_event_recipients($pdo, $event);
    if ($recipients === []) return ['pushed' => 0, 'reason' => 'no_recipients'];

    // subscriptions.account is exactly the "<instance>:<accountId>" key the
    // roster stores — the join that makes per-member targeting possible without
    // the server ever talking to an instance.
    $in = implode(',', array_fill(0, count($recipients), '?'));
    $st = $pdo->prepare(
        "SELECT id, endpoint, p256dh, auth FROM subscriptions WHERE account IN ({$in})"
    );
    $st->execute($recipients);
    $subs = $st->fetchAll(PDO::FETCH_ASSOC);
    if ($subs === []) return ['pushed' => 0, 'reason' => 'no_subscriptions'];

    $cfg = meenow_config();
    $vapid = json_decode((string) file_get_contents($cfg['vapid']['key_file']), true);
    $webPush = new Minishlink\WebPush\WebPush(['VAPID' => [
        'subject' => $cfg['vapid']['subject'],
        'publicKey' => $vapid['publicKey'],
        'privateKey' => $vapid['privateKey'],
    ]], [
        // Long enough that a phone which was merely asleep still gets it. The
        // events endpoint is the backstop for anything longer than this.
        'TTL' => 6 * 3600,
        'urgency' => 'high',
    ]);

    $payload = json_encode(['group_event' => [
        'id' => (int) $event['id'],
        'kind' => $event['kind'],
        'group' => $event['group_id'],
        'name' => $event['name'],
        'account' => $event['account'],
        'acct' => $event['acct'],
        'actor' => $event['actor'],
    ]]);

    $sent = 0; $expired = 0; $failed = 0;
    foreach ($subs as $sub) {
        $subscription = Minishlink\WebPush\Subscription::create([
            'endpoint' => $sub['endpoint'],
            'publicKey' => $sub['p256dh'],
            'authToken' => $sub['auth'],
        ]);
        try {
            $response = $webPush->sendOneNotification($subscription, $payload);
            if ($response->isSuccess()) { $sent++; continue; }
            // 404/410 = expired/unregistered, same rule as the daily tick.
            if ($response->isSubscriptionExpired()) {
                $pdo->prepare('DELETE FROM subscriptions WHERE id = ?')->execute([$sub['id']]);
                $expired++;
            } else {
                error_log("[groups] push failed {$sub['endpoint']}: " . $response->getReason());
                $failed++;
            }
        } catch (Throwable $e) {
            error_log('[groups] push error: ' . $e->getMessage());
            $failed++;
        }
    }

    return ['pushed' => $sent, 'expired' => $expired, 'failed' => $failed];
}
