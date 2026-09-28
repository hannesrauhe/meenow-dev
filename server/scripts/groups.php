<?php
declare(strict_types=1);

// Operator CLI for bootstrap groups (there is deliberately no create UI or
// admin endpoint — groups are a small-community bootstrap device).
//
// Usage: php scripts/groups.php <command> ...
//   create  <id> <name>                      add a group (slug + display name)
//   delete  <id>                             remove a group and its members
//   list                                     all groups with member counts
//   members <id>                             members of a group
//   add     <id> <account> <acct>            seed a member ("<instance>:<id>", user@instance)
//   remove  <id> <account>                   drop a member
//
// Seeding example (founding members are added by the operator, everyone else
// joins through the app):
//   php scripts/groups.php create crew "Weekend crew"
//   php scripts/groups.php add crew pixelfed.social:123 alice@pixelfed.social

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
        $pdo->prepare('DELETE FROM `groups` WHERE id = ?')->execute([$a]);
        echo "deleted group {$a}\n";
        break;

    case 'list':
        $rows = $pdo->query(
            'SELECT g.id, g.name, COUNT(m.account) AS members
             FROM `groups` g LEFT JOIN group_members m ON m.group_id = g.id
             GROUP BY g.id, g.name ORDER BY g.name'
        )->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $r) {
            echo "{$r['id']}\t{$r['members']}\t{$r['name']}\n";
        }
        break;

    case 'members':
        $g = $needGroup($a);
        $st = $pdo->prepare('SELECT account, acct FROM group_members WHERE group_id = ? ORDER BY created_at');
        $st->execute([$g['id']]);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            echo "{$r['account']}\t{$r['acct']}\n";
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
        $needGroup($a);
        $st = $pdo->prepare('DELETE FROM group_members WHERE group_id = ? AND account = ?');
        $st->execute([$a, $b]);
        echo $st->rowCount() > 0 ? "removed {$b} from {$a}\n" : "was not a member\n";
        break;

    default:
        fwrite(STDERR, "usage: groups.php create|delete|list|members|add|remove ...\n");
        exit(1);
}
