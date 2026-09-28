<?php
declare(strict_types=1);

// Operator CLI for bootstrap groups (there is deliberately no create UI or
// admin endpoint — groups are a small-community bootstrap device).
//
// Usage: php scripts/groups.php <command> ...
//   create  <id> <name>                      add a group (slug + display name)
//   delete  <id>                             remove a group, its members, invites, bans
//   list                                     all groups with member counts + admin
//   members <id>                             members of a group (admin marked)
//   add     <id> <account> <acct>            seed a member ("<instance>:<id>", user@instance)
//   remove  <id> <account>                   drop a member row — BREAK GLASS, see below
//   invite  <id>                             mint an invite token, print the link
//   invites <id>                             that group's invites and their state
//   prune                                    delete expired invites
//   ban     <id> <account>                   block an account from joining
//   unban   <id> <account>                   lift a block
//
// Seeding example (founding members are added by the operator, everyone else
// joins through the app):
//   php scripts/groups.php create crew "Weekend crew"
//   php scripts/groups.php add crew pixelfed.social:123 alice@pixelfed.social
//   php scripts/groups.php invite crew
//
// `remove` is a plain row delete: no event, no push, no ban. It exists for
// cleanup and for undoing a bad `add`, and it is NOT the in-app removal — which
// also bans the person and tells every member's device to sever the follow. Use
// the app for that. Note the admin is the oldest member row, so removing it
// silently hands the role to whoever is next.

$configPath = __DIR__ . '/../config/config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "groups: no config at {$configPath}\n");
    exit(1);
}
$cfg = require $configPath;
$db = $cfg['db'] ?? [];
try {
    $pdo = new PDO(
        "mysql:host={$db['host']};dbname={$db['name']};charset=utf8mb4",
        $db['user'],
        $db['pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
} catch (PDOException $e) {
    fwrite(STDERR, "groups: cannot connect to db: {$e->getMessage()}\n");
    exit(1);
}

[$cmd, $a, $b, $c] = [$argv[1] ?? '', $argv[2] ?? '', $argv[3] ?? '', $argv[4] ?? ''];

$validId = fn(string $id): bool => preg_match('#^[a-z0-9][a-z0-9-]{0,63}$#', $id) === 1;
$validAccount = fn(string $s): bool => strlen($s) <= 191
    && preg_match('#^[a-z0-9.-]+:[a-z0-9]+$#i', $s) === 1;
$validAcct = fn(string $s): bool => strlen($s) <= 191
    && preg_match('#^[a-z0-9._%-]+@[a-z0-9.-]+$#i', ltrim($s, '@')) === 1;

$needGroup = function (string $id) use ($pdo): array {
    $st = $pdo->prepare('SELECT id, name FROM `groups` WHERE id = ?');
    $st->execute([$id]);
    $g = $st->fetch(PDO::FETCH_ASSOC);
    if (!$g) {
        fwrite(STDERR, "groups: no group '{$id}'\n");
        exit(1);
    }
    return $g;
};

// The admin is derived, exactly as src/groups.php derives it — the oldest
// member row. Kept as a literal copy of that query so CLI output and the app
// can never disagree about who runs a group.
$adminOf = function (string $id) use ($pdo): string {
    $st = $pdo->prepare(
        'SELECT account FROM group_members WHERE group_id = ?
         ORDER BY created_at, account LIMIT 1'
    );
    $st->execute([$id]);
    return (string) ($st->fetchColumn() ?: '');
};

$tokenLink = fn(string $token): string => 'https://meenow.de/?join=' . $token;

switch ($cmd) {
    case 'create':
        if (!$validId($a)) {
            fwrite(STDERR, "groups: id must match [a-z0-9][a-z0-9-]{0,63}\n");
            exit(1);
        }
        $name = trim($b);
        if ($name === '' || strlen($name) > 100) {
            fwrite(STDERR, "groups: name required (max 100 chars)\n");
            exit(1);
        }
        $st = $pdo->prepare('INSERT INTO `groups` (id, name) VALUES (?, ?)');
        try {
            $st->execute([$a, $name]);
        } catch (PDOException) {
            fwrite(STDERR, "groups: group '{$a}' already exists\n");
            exit(1);
        }
        echo "created group {$a} ({$name})\n";
        break;

    case 'delete':
        $needGroup($a);
        $pdo->prepare('DELETE FROM group_members WHERE group_id = ?')->execute([$a]);
        // Invites die with the group: a token must never outlive the thing it
        // points at, and a stale row would make a deleted group redeemable.
        $pdo->prepare('DELETE FROM group_invites WHERE group_id = ?')->execute([$a]);
        $pdo->prepare('DELETE FROM group_bans WHERE group_id = ?')->execute([$a]);
        $pdo->prepare('DELETE FROM group_events WHERE group_id = ?')->execute([$a]);
        $pdo->prepare('DELETE FROM `groups` WHERE id = ?')->execute([$a]);
        echo "deleted group {$a}\n";
        break;

    case 'list':
        $rows = $pdo->query(
            'SELECT g.id, g.name, COUNT(m.account) AS members,
                    (SELECT m2.account FROM group_members m2
                     WHERE m2.group_id = g.id ORDER BY m2.created_at, m2.account LIMIT 1) AS admin
             FROM `groups` g LEFT JOIN group_members m ON m.group_id = g.id
             GROUP BY g.id, g.name ORDER BY g.name'
        )->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $r) {
            echo "{$r['id']}\t{$r['members']}\t{$r['name']}\tadmin={$r['admin']}\n";
        }
        break;

    case 'members':
        $g = $needGroup($a);
        $admin = $adminOf((string) $g['id']);
        $st = $pdo->prepare('SELECT account, acct FROM group_members WHERE group_id = ? ORDER BY created_at, account');
        $st->execute([$g['id']]);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            echo $r['account'] === $admin ? "{$r['account']}\t{$r['acct']}\tADMIN\n"
                                          : "{$r['account']}\t{$r['acct']}\n";
        }
        $st = $pdo->prepare('SELECT account, acct FROM group_bans WHERE group_id = ? ORDER BY created_at');
        $st->execute([$g['id']]);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            echo "{$r['account']}\t{$r['acct']}\tBANNED\n";
        }
        break;

    case 'add':
        $needGroup($a);
        if (!$validAccount($b)) {
            fwrite(STDERR, "groups: account must be \"<instance>:<accountId>\"\n");
            exit(1);
        }
        $acct = strtolower(ltrim($c, '@'));
        if (!$validAcct($acct)) {
            fwrite(STDERR, "groups: acct must be a full handle, user@instance\n");
            exit(1);
        }
        $st = $pdo->prepare(
            'INSERT INTO group_members (group_id, account, acct) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE acct = VALUES(acct)'
        );
        $st->execute([$a, $b, $acct]);
        echo "added {$acct} to {$a}\n";
        break;

    case 'remove':
        // Break glass: row delete only. No event, no push, no ban — see the
        // header. The in-app removal is the one that actually severs follows.
        $needGroup($a);
        $st = $pdo->prepare('DELETE FROM group_members WHERE group_id = ? AND account = ?');
        $st->execute([$a, $b]);
        echo $st->rowCount() > 0 ? "removed {$b} from {$a}\n" : "was not a member\n";
        if ($adminOf($a) === '') {
            fwrite(STDERR, "groups: {$a} now has no members, so it has no admin\n");
        }
        break;

    case 'invite':
        $needGroup($a);
        $ttl = max(60, (int) ($cfg['invite_ttl_s'] ?? 14400));
        $maxUses = max(1, (int) ($cfg['invite_max_uses'] ?? 5));
        $token = bin2hex(random_bytes(16));
        $pdo->prepare(
            'INSERT INTO group_invites (token, group_id, expires_at, max_uses) VALUES (?, ?, ?, ?)'
        )->execute([$token, $a, time() + $ttl, $maxUses]);
        echo "token  {$token}\n";
        echo "link   " . $tokenLink($token) . "\n";
        echo "valid  {$ttl}s, up to {$maxUses} accounts\n";
        break;

    case 'invites':
        $needGroup($a);
        $st = $pdo->prepare(
            'SELECT token, expires_at, uses, max_uses, last_used_by
             FROM group_invites WHERE group_id = ? ORDER BY created_at DESC'
        );
        $st->execute([$a]);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $left = (int) $r['expires_at'] - time();
            $state = $left <= 0 ? 'expired'
                : ((int) $r['uses'] >= (int) $r['max_uses'] ? 'spent' : 'live');
            printf(
                "%s\t%s\t%d/%d\t%dm left\tby=%s\n",
                $r['token'], $state, (int) $r['uses'], (int) $r['max_uses'],
                intdiv(max(0, $left), 60), $r['last_used_by'] !== '' ? $r['last_used_by'] : '-'
            );
        }
        break;

    case 'prune':
        $st = $pdo->prepare('DELETE FROM group_invites WHERE expires_at < ?');
        $st->execute([time()]);
        echo "pruned {$st->rowCount()} expired invite(s)\n";
        break;

    case 'ban':
        $needGroup($a);
        if (!$validAccount($b)) {
            fwrite(STDERR, "groups: account must be \"<instance>:<accountId>\"\n");
            exit(1);
        }
        // Mirrors the app's removal: a ban is what stops a kicked person's next
        // follow request being auto-approved, so it is the part that matters.
        $acct = strtolower(ltrim($c, '@'));
        $pdo->prepare(
            'INSERT INTO group_bans (group_id, account, acct, actor) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE acct = VALUES(acct)'
        )->execute([$a, $b, $validAcct($acct) ? $acct : '', 'cli']);
        $pdo->prepare('DELETE FROM group_members WHERE group_id = ? AND account = ?')->execute([$a, $b]);
        echo "banned {$b} from {$a} (no members were notified — use the app to sever follows)\n";
        break;

    case 'unban':
        $needGroup($a);
        $st = $pdo->prepare('DELETE FROM group_bans WHERE group_id = ? AND account = ?');
        $st->execute([$a, $b]);
        echo $st->rowCount() > 0 ? "unbanned {$b} in {$a}\n" : "was not banned\n";
        break;

    default:
        fwrite(STDERR, "usage: groups.php create|delete|list|members|add|remove|invite|invites|prune|ban|unban ...\n");
        exit(1);
}
