<?php
declare(strict_types=1);

// Operator CLI for the error capture (see src/monitor.php).
//
// Usage: php scripts/errors.php <command> ...
//   list [--limit=N] [--kind=K]     newest first (default 30)
//   show <id>                       one row, full body/ctx
//   stats [--days=N]                grouped by kind/route/status
//   prune [--keep-days=N] [--max-rows=N]
//   liveness                        when the scheduled tick last ran
//
// Rows are raw, so `stats` is the view you want most of the time: one broken
// endpoint under a retry loop is many rows, one line here.

$configPath = __DIR__ . '/../config/config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "errors: no config at {$configPath}\n");
    exit(1);
}
$cfg = require $configPath;
require __DIR__ . '/../src/monitor.php';
$db = $cfg['db'] ?? [];
try {
    $pdo = new PDO(
        "mysql:host={$db['host']};dbname={$db['name']};charset=utf8mb4",
        $db['user'],
        $db['pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
} catch (PDOException $e) {
    fwrite(STDERR, "errors: cannot connect to db: {$e->getMessage()}\n");
    exit(1);
}

$monitor = meenow_monitor_cfg($cfg);
$cmd = $argv[1] ?? 'list';
$opt = static function (string $name, mixed $default) use ($argv): mixed {
    foreach ($argv as $a) {
        if (str_starts_with($a, "--{$name}=")) return substr($a, strlen($name) + 3);
    }
    return $default;
};

switch ($cmd) {
    case 'list': {
        $limit = min(500, max(1, (int) $opt('limit', 30)));
        $kind = (string) $opt('kind', '');
        $where = in_array($kind, ['upstream', 'php', 'cron'], true) ? "WHERE kind = '{$kind}'" : '';
        $rows = $pdo->query(
            "SELECT id, kind, status, method, route, upstream, message, created_at
             FROM errors {$where} ORDER BY id DESC LIMIT {$limit}"
        )->fetchAll(PDO::FETCH_ASSOC);
        if ($rows === []) { echo "no errors recorded\n"; break; }
        foreach ($rows as $r) {
            printf(
                "#%-6s %-8s %4s %-40s %s%s\n       %s\n",
                $r['id'], $r['kind'], $r['status'] ?: '-',
                $r['route'], $r['created_at'],
                $r['upstream'] !== '' ? ' @' . $r['upstream'] : '',
                $r['message']
            );
        }
        break;
    }

    case 'show': {
        $id = (int) ($argv[2] ?? 0);
        $st = $pdo->prepare('SELECT * FROM errors WHERE id = ?');
        $st->execute([$id]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        if ($row === false) {
            fwrite(STDERR, "errors: no row #{$id}\n");
            exit(1);
        }
        foreach ($row as $k => $v) echo str_pad($k, 10) . ': ' . $v . "\n";
        break;
    }

    case 'stats': {
        $days = min(90, max(1, (int) $opt('days', $monitor['retention_days'])));
        $st = $pdo->prepare(
            'SELECT kind, route, status, upstream, COUNT(*) n,
                    MIN(created_at) first_seen, MAX(created_at) last_seen
             FROM errors WHERE created_at > NOW() - INTERVAL ? DAY
             GROUP BY kind, route, status, upstream ORDER BY MAX(id) DESC LIMIT 100'
        );
        $st->execute([$days]);
        $groups = $st->fetchAll(PDO::FETCH_ASSOC);
        if ($groups === []) { echo "no errors in the last {$days} day(s)\n"; break; }
        foreach ($groups as $g) {
            printf(
                "%5d  %-8s %4s %-40s %s\n       %s .. %s\n",
                $g['n'], $g['kind'], $g['status'] ?: '-', $g['route'],
                $g['upstream'] !== '' ? '@' . $g['upstream'] : '',
                $g['first_seen'], $g['last_seen']
            );
        }
        break;
    }

    case 'prune': {
        $monitor['retention_days'] = (int) $opt('keep-days', $monitor['retention_days']);
        $monitor['max_rows'] = (int) $opt('max-rows', $monitor['max_rows']);
        $n = meenow_monitor_prune($pdo, $monitor);
        echo "pruned {$n} row(s)\n";
        break;
    }

    case 'liveness': {
        $l = meenow_monitor_cron_gap($pdo, $monitor);
        echo 'last tick:  ' . ($l['last_tick'] ?? 'never') . "\n";
        echo 'gap:        ' . ($l['gap_s'] !== null ? $l['gap_s'] . 's' : '-') . "\n";
        echo 'stalled:    ' . ($l['stalled'] ? 'YES' : 'no') . "\n";
        break;
    }

    default:
        fwrite(STDERR, "errors: unknown command '{$cmd}' (list|show|stats|prune|liveness)\n");
        exit(1);
}
