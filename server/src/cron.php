<?php
declare(strict_types=1);

// URL-cron entry point: https://meenow.de/cron?action=tick&key=SECRET
// Shared hosts often only allow scheduled HTTP GETs, so the daily tick is an
// endpoint. Slot dedupe in MySQL makes double-fires (and manual browser hits
// with the key) harmless. ?force=1 bypasses both the slot dedupe and the
// timezone window (manual testing only).

$cfg = meenow_config();
$key = $_GET['key'] ?? '';
// Empty cron_key must fail closed (hash_equals('', '') would otherwise pass).
if (!is_string($key) || $cfg['cron_key'] === '' || !hash_equals($cfg['cron_key'], $key)) {
    meenow_json_response(403, ['error' => 'bad_key']);
}

$action = $_GET['action'] ?? 'tick';
$force = (($_GET['force'] ?? '') === '1');
$now = time();
$pdo = meenow_db();
$monitor = meenow_monitor_cfg($cfg);

// Manual broadcast: push a key-gated message to every subscriber, verbatim.
// Deliberately before the slot dedupe — it is an operator action, not a tick.
// ?to_group=<slug>[,<slug>…] narrows the audience to those groups' members.
if (isset($_GET['message'])) {
    $message = trim((string) $_GET['message']);
    if ($message === '' || mb_strlen($message) > 280) {
        meenow_json_response(400, ['error' => 'bad_message']);
    }
    $opts = ['message' => $message];
    $toGroup = trim((string) ($_GET['to_group'] ?? ''));
    if ($toGroup !== '') {
        $ids = array_values(array_unique(array_filter(array_map(
            fn(string $s): string => strtolower(trim($s)),
            explode(',', $toGroup)
        ))));
        if ($ids === []) meenow_json_response(400, ['error' => 'bad_to_group']);
        $in = implode(',', array_fill(0, count($ids), '?'));
        // An unknown slug is a typo, not an empty audience: fail loud.
        $known = $pdo->prepare("SELECT id FROM `groups` WHERE id IN ($in)");
        $known->execute($ids);
        $unknown = array_values(array_diff($ids, $known->fetchAll(PDO::FETCH_COLUMN)));
        if ($unknown !== []) {
            meenow_json_response(400, ['error' => 'unknown_group', 'groups' => $unknown]);
        }
        $members = $pdo->prepare("SELECT DISTINCT account FROM group_members WHERE group_id IN ($in)");
        $members->execute($ids);
        $opts['accounts'] = $members->fetchAll(PDO::FETCH_COLUMN);
    }
    $log = (require __DIR__ . '/tick.php')($opts);
    meenow_json_response(200, ['ok' => true, 'broadcast' => true] + $log);
}

// Liveness, BEFORE the slot insert: this run is the proof the cron still fires,
// so the gap has to be measured against the previous slot. A row here is the
// only trace of a host that stopped pinging us and later resumed.
if ($action === 'tick' && !$force) {
    $gap = meenow_monitor_cron_gap($pdo, $monitor);
    if ($gap['stalled']) {
        meenow_monitor_queue([
            'kind' => 'cron',
            'route' => '/cron',
            'message' => $gap['last_tick'] === null
                ? 'the scheduled tick has never run'
                : "the scheduled tick was silent for {$gap['gap_s']}s "
                  . "(limit {$monitor['cron_max_gap_s']}s)",
        ]);
    }
}

// Slot dedupe: one run per 30-minute slot per action. The window logic tolerates
// cron jitter; the slot key prevents duplicate pushes from double-fires.
if (!$force) {
    $slot = intdiv($now, 1800);
    try {
        $pdo->prepare('INSERT INTO cron_slots (slot, action) VALUES (?, ?)')->execute([$slot, $action]);
    } catch (PDOException) {
        meenow_json_response(200, ['ok' => true, 'skipped' => 'slot already ran']);
    }
}

// Housekeeping: both tables are counters/dedupe keys, old rows are useless.
$pdo->prepare('DELETE FROM rate_hits WHERE minute < ?')->execute([intdiv($now, 60) - 1440]);
$pdo->prepare('DELETE FROM cron_slots WHERE slot < ?')->execute([intdiv($now, 1800) - 48]);
// The error capture is raw rows by design, so retention lives here too.
meenow_monitor_prune($pdo, $monitor);

$log = match ($action) {
    'tick' => (require __DIR__ . '/tick.php')(['force' => $force]),
    default => meenow_json_response(400, ['error' => 'unknown_action']),
};

meenow_json_response(200, ['ok' => true] + $log);
