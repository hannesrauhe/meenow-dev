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

$log = match ($action) {
    'tick' => (require __DIR__ . '/tick.php')(['force' => $force]),
    default => meenow_json_response(400, ['error' => 'unknown_action']),
};

meenow_json_response(200, ['ok' => true] + $log);
