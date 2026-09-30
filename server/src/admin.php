<?php
declare(strict_types=1);

// Operator read endpoint for the error capture:
//   GET /admin/errors?key=SECRET                 recent rows (?limit= ?kind=)
//   GET /admin/errors?key=SECRET&action=stats    grouped by kind/route/status
//   GET /admin/errors?key=SECRET&action=liveness age of the last cron slot
//   GET /admin/errors?key=SECRET&action=prune    apply the retention policy
// Gate is the same cron_key + hash_equals as /cron. Bare /admin stays a 404 —
// the router only dispatches /admin/*, and the suite pins that.

$cfg = meenow_config();
$key = $_GET['key'] ?? '';
// Empty cron_key must fail closed (hash_equals('', '') would otherwise pass).
if (!is_string($key) || ($cfg['cron_key'] ?? '') === '' || !hash_equals($cfg['cron_key'], $key)) {
    meenow_json_response(403, ['error' => 'bad_key']);
}

$pdo = meenow_db();
$action = $_GET['action'] ?? 'list';
$monitor = meenow_monitor_cfg();

// A broken errors table must answer with a clear message, not a fresh 500.
try {
    $out = match ($action) {
        'stats' => admin_stats($pdo, $monitor),
        'liveness' => admin_liveness($pdo, $monitor),
        'prune' => admin_prune($pdo, $monitor),
        default => admin_list($pdo),
    };
} catch (PDOException $e) {
    meenow_json_response(500, ['error' => 'query_failed', 'detail' => $e->getMessage()]);
}

meenow_json_response(200, ['ok' => true] + $out);

function admin_list(PDO $pdo): array
{
    $limit = min(500, max(1, (int) ($_GET['limit'] ?? 50)));
    $kind = $_GET['kind'] ?? '';
    $where = '';
    $args = [];
    if (in_array($kind, ['upstream', 'php', 'cron'], true)) {
        $where = 'WHERE kind = ?';
        $args[] = $kind;
    }
    $rows = $pdo->prepare(
        "SELECT id, kind, status, method, route, upstream, message, body, ctx, created_at
         FROM errors {$where} ORDER BY id DESC LIMIT {$limit}"
    );
    $rows->execute($args);
    $list = $rows->fetchAll(PDO::FETCH_ASSOC);
    foreach ($list as &$r) {
        $r['status'] = (int) $r['status'];
        $r['ctx'] = $r['ctx'] !== null ? json_decode((string) $r['ctx'], true) : null;
    }
    $total = (int) $pdo->query('SELECT COUNT(*) FROM errors')->fetchColumn();
    return ['total' => $total, 'errors' => $list];
}

function admin_stats(PDO $pdo, array $monitor): array
{
    $days = min(90, max(1, (int) ($_GET['days'] ?? $monitor['retention_days'])));
    $st = $pdo->prepare(
        'SELECT kind, route, status, upstream, COUNT(*) AS n,
                MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
         FROM errors WHERE created_at > NOW() - INTERVAL ? DAY
         GROUP BY kind, route, status, upstream
         ORDER BY MAX(id) DESC LIMIT 100'
    );
    $st->execute([$days]);
    $groups = $st->fetchAll(PDO::FETCH_ASSOC);
    foreach ($groups as &$g) {
        $g['n'] = (int) $g['n'];
        $g['status'] = (int) $g['status'];
    }
    return ['days' => $days, 'groups' => $groups];
}

function admin_liveness(PDO $pdo, array $monitor): array
{
    return ['cron' => meenow_monitor_cron_gap($pdo, $monitor)];
}

function admin_prune(PDO $pdo, array $monitor): array
{
    return ['deleted' => meenow_monitor_prune($pdo, $monitor)];
}
