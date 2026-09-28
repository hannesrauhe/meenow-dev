<?php
declare(strict_types=1);

// /groups/* — bootstrap groups: named circles the operator creates (see
// scripts/groups.php) so a new user can join one via an invite link, have the
// app follow every member, and become a member themselves. Membership is
// keyed on the self-asserted "<instance>:<accountId>" string — the same
// attribution model as subscriptions.account: the Bearer token is required
// but validated by the instance, not here, so planting a fake member row is
// possible for a determined bad actor. Accepted for a bootstrap device in a
// small community; the circle itself lives on the instance, not in this DB.

return function (string $path): void {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    // Same rule as the proxy and /push: no anonymous traffic.
    if (empty($_SERVER['HTTP_AUTHORIZATION'])) {
        meenow_json_response(401, ['error' => 'authorization_required']);
    }
    meenow_rate_limit();

    $pdo = meenow_db();

    if ($path === '/groups/mine' && $method === 'GET') {
        groups_mine($pdo, $_GET['account'] ?? '');
    }
    if (preg_match('#^/groups/([a-z0-9][a-z0-9-]{0,63})$#', $path, $m) === 1
        && $method === 'GET') {
        groups_show($pdo, $m[1]);
    }
    if (preg_match('#^/groups/([a-z0-9][a-z0-9-]{0,63})/(join|leave)$#', $path, $m) === 1
        && $method === 'POST') {
        $body = meenow_json_input();
        $account = groups_account_key($body['account'] ?? '');
        if ($account === null) {
            meenow_json_response(400, ['error' => 'invalid_account']);
        }
        if ($m[2] === 'leave') groups_leave($pdo, $m[1], $account);
        groups_join($pdo, $m[1], $account, $body['acct'] ?? null);
    }
    meenow_json_response(404, ['error' => 'not_found']);
};

// "<instance>:<accountId>" — self-asserted, so only shape-checked (same
// posture as the push subscribe endpoint).
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

function groups_exist(PDO $pdo, string $id): bool
{
    $st = $pdo->prepare('SELECT 1 FROM `groups` WHERE id = ?');
    $st->execute([$id]);
    return (bool) $st->fetchColumn();
}

function groups_show(PDO $pdo, string $id): void
{
    $st = $pdo->prepare('SELECT id, name FROM `groups` WHERE id = ?');
    $st->execute([$id]);
    $group = $st->fetch(PDO::FETCH_ASSOC);
    if (!$group) meenow_json_response(404, ['error' => 'group_not_found']);

    $st = $pdo->prepare('SELECT account, acct FROM group_members WHERE group_id = ? ORDER BY created_at');
    $st->execute([$id]);
    meenow_json_response(200, [
        'id' => $group['id'],
        'name' => $group['name'],
        'members' => $st->fetchAll(PDO::FETCH_ASSOC),
    ]);
}

function groups_mine(PDO $pdo, mixed $accountRaw): void
{
    $account = groups_account_key($accountRaw);
    if ($account === null) meenow_json_response(400, ['error' => 'invalid_account']);

    $st = $pdo->prepare(
        'SELECT g.id, g.name FROM `groups` g
         JOIN group_members m ON m.group_id = g.id
         WHERE m.account = ? ORDER BY g.name'
    );
    $st->execute([$account]);
    meenow_json_response(200, ['groups' => $st->fetchAll(PDO::FETCH_ASSOC)]);
}

function groups_join(PDO $pdo, string $id, string $account, mixed $acctRaw): void
{
    if (!groups_exist($pdo, $id)) meenow_json_response(404, ['error' => 'group_not_found']);
    $acct = groups_acct($acctRaw, $account);
    if ($acct === null) meenow_json_response(400, ['error' => 'invalid_acct']);

    // Idempotent; the acct refresh self-heals account renames.
    $st = $pdo->prepare(
        'INSERT INTO group_members (group_id, account, acct) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE acct = VALUES(acct)'
    );
    $st->execute([$id, $account, $acct]);
    meenow_json_response(200, ['ok' => true]);
}

function groups_leave(PDO $pdo, string $id, string $account): void
{
    $st = $pdo->prepare('DELETE FROM group_members WHERE group_id = ? AND account = ?');
    $st->execute([$id, $account]);
    meenow_json_response(200, ['ok' => true]);
}
