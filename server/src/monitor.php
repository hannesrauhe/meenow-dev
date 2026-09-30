<?php
declare(strict_types=1);

// Error capture into the `errors` table — the readable replacement for
// cache/php-error.log, which all-inkl will not show us.
//
// Two triggers: a status Pixelfed sent back through the proxy that we did not
// expect, and our own uncaught throw or fatal. Both are queued and written by a
// single shutdown hook, because meenow_json_response() ends in `exit` — a
// try/catch around the router cannot see ~40 of the error paths.
//
// Every row is mirrored to error_log() first: a DB failure is exactly the case
// that cannot be written to the DB.

// $cfg may be passed by the CLI, which loads config/config.php itself and does
// not boot bootstrap.php (that would need vendor/).
function meenow_monitor_cfg(?array $cfg = null): array
{
    $e = ($cfg ?? meenow_config())['errors'] ?? [];
    return [
        // Upstream 4xx worth a row. 401/403/429 are deliberately absent: those
        // are expired tokens and abuse, not bugs.
        'log_statuses' => $e['log_statuses'] ?? [400, 404, 422],
        // Insert cap per (kind, route, status) per hour, so a flood stays cheap.
        'sample_cap_per_hour' => $e['sample_cap_per_hour'] ?? 20,
        'retention_days' => $e['retention_days'] ?? 7,
        'max_rows' => $e['max_rows'] ?? 5000,
        // A tick slot older than this means the host stopped firing the cron.
        'cron_max_gap_s' => $e['cron_max_gap_s'] ?? 7200,
    ];
}

// Install the capture handlers. Called from the front controller on every
// request, unlike the old debug-only handlers: production must record too.
function meenow_monitor_init(): void
{
    // app.php calls this and meenow_debug_handlers() calls it too; a second
    // shutdown hook would flush an already-drained queue and a second exception
    // handler would be dead code anyway.
    static $installed = false;
    if ($installed) return;
    $installed = true;

    set_exception_handler(static function (Throwable $e): void {
        $at = basename($e->getFile()) . ':' . $e->getLine();
        $msg = get_class($e) . ': ' . $e->getMessage();
        meenow_monitor_queue([
            'kind' => 'php',
            'message' => $msg,
            'ctx' => json_encode([
                'at' => $at,
                'build' => meenow_monitor_build(),
                'acct' => meenow_monitor_acct(),
            ]),
        ]);
        $GLOBALS['_meenow_monitor_handled'] = true;
        meenow_json_response(500, meenow_monitor_error_body($msg, $at));
    });

    register_shutdown_function(static function (): void {
        $e = error_get_last();
        // The exception handler already recorded and answered when it ran, so
        // the flag — not error_get_last() — decides whether anything is left.
        // error_get_last() reports the last error of ANY type, so the fatal
        // check must be explicit or a benign earlier warning reads as a fatal.
        $handled = $GLOBALS['_meenow_monitor_handled'] ?? false;
        $fatal = !$handled && $e !== null
            && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true);
        if ($fatal) {
            $at = basename($e['file']) . ':' . $e['line'];
            meenow_monitor_queue([
                'kind' => 'php',
                'message' => 'fatal: ' . $e['message'],
                'ctx' => json_encode([
                    'at' => $at,
                    'build' => meenow_monitor_build(),
                    'acct' => meenow_monitor_acct(),
                ]),
            ]);
        }
        // Before the 500, not after: meenow_json_response() ends in `exit`, and
        // an exit inside a shutdown function skips everything that follows.
        meenow_monitor_flush();
        if ($fatal && !headers_sent()) {
            meenow_json_response(500, meenow_monitor_error_body('fatal: ' . $e['message'], $at));
        }
    });
}

// The 500 body. The real message only goes out with config debug — the app
// shows it on screen, which is how a failure becomes debuggable without a
// server log. Never on production: it leaks paths and query internals.
function meenow_monitor_error_body(string $message, string $at): array
{
    $body = ['error' => 'server_error'];
    if (meenow_config()['debug'] ?? false) $body['debug'] = $message . ' in ' . $at;
    return $body;
}

// Fold ids into ':id' so one broken endpoint is one groupable route instead of
// one row shape per status id.
function meenow_monitor_route(?string $path = null): string
{
    $path ??= parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    $parts = explode('/', $path);
    foreach ($parts as $i => $p) {
        if ($p !== '' && (ctype_digit($p) || preg_match('/^[0-9a-f]{16,}$/i', $p) === 1)) {
            $parts[$i] = ':id';
        }
    }
    return substr(implode('/', $parts), 0, 191);
}

// Is this upstream status one we record? Exposed so the caller can skip
// parsing the body at all — a timeline response is hundreds of KB and the vast
// majority of proxied requests are fine.
function meenow_monitor_watching(int $status): bool
{
    return $status >= 500
        || in_array($status, meenow_monitor_cfg()['log_statuses'], true);
}

// Queue an unexpected status coming back from an instance. 5xx always; the
// configured 4xx set as the "Pixelfed changed" signal.
function meenow_monitor_upstream(int $status, string $host, string $message = '', string $body = ''): void
{
    if (!meenow_monitor_watching($status)) return;
    meenow_monitor_queue([
        'kind' => 'upstream',
        'status' => $status,
        'upstream' => $host,
        'message' => $message !== '' ? $message : "upstream returned {$status}",
        'body' => meenow_monitor_scrub($body),
    ]);
}

// $GLOBALS, not a static: the shutdown hook that drains this lives in another
// function, and `exit` means nothing else gets a chance to.
function meenow_monitor_queue(array $row): void
{
    $GLOBALS['_meenow_monitor_queue'][] = $row + [
        'status' => 0,
        'method' => strtoupper($_SERVER['REQUEST_METHOD'] ?? ''),
        'route' => meenow_monitor_route(),
        'upstream' => '',
        'message' => '',
        'body' => null,
        'ctx' => null,
    ];
}

// The single write point. Runs once, at shutdown, after the client already has
// its answer — so a slow or dead DB can never slow down or break a request.
function meenow_monitor_flush(): void
{
    static $done = false;
    if ($done) return;
    $done = true;
    $rows = $GLOBALS['_meenow_monitor_queue'] ?? [];
    $GLOBALS['_meenow_monitor_queue'] = [];
    foreach ($rows as $row) {
        error_log(sprintf(
            '[error] %s %d %s %s%s',
            $row['kind'], $row['status'], $row['route'], $row['message'],
            $row['upstream'] !== '' ? ' @' . $row['upstream'] : ''
        ));
        try {
            $pdo = meenow_db();
            if (!meenow_monitor_under_cap($pdo, $row)) continue;
            $pdo->prepare(
                'INSERT INTO errors (kind, status, method, route, upstream, message, body, ctx)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            )->execute([
                substr($row['kind'], 0, 16), $row['status'], substr($row['method'], 0, 8),
                $row['route'], substr($row['upstream'], 0, 191),
                substr($row['message'], 0, 512), $row['body'], $row['ctx'],
            ]);
        } catch (Throwable) {
            // The log line above is the fallback; a broken errors table must
            // never become the request's error.
        }
    }
}

// Raw rows still need a budget: one broken endpoint under a retry loop would
// otherwise write a row per click. Errors are rare, so the extra SELECT is free.
function meenow_monitor_under_cap(PDO $pdo, array $row): bool
{
    $cap = meenow_monitor_cfg()['sample_cap_per_hour'];
    if ($cap <= 0) return true;
    $st = $pdo->prepare(
        'SELECT COUNT(*) FROM errors
         WHERE kind = ? AND route = ? AND status = ? AND created_at > NOW() - INTERVAL 1 HOUR'
    );
    $st->execute([$row['kind'], $row['route'], $row['status']]);
    return (int) $st->fetchColumn() < $cap;
}

// Truncate and strip anything token-shaped before it lands in the DB.
function meenow_monitor_scrub(string $s): string
{
    $s = substr(trim($s), 0, 500);
    return preg_replace('/[A-Za-z0-9_\-]{24,}/', '[redacted]', $s) ?? '';
}

// Truncated hash of the caller's Bearer token: groups one user's retries
// without storing a credential. Never the token itself.
function meenow_monitor_acct(): string
{
    $t = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? '');
    return $t === '' ? '' : substr(hash('sha256', $t), 0, 8);
}

function meenow_monitor_build(): string
{
    $f = dirname(__DIR__) . '/VERSION';
    return is_file($f) ? substr(trim((string) file_get_contents($f)), 0, 64) : 'dev';
}

// Retention: age cap first, then a row cap, so a burst inside the window cannot
// outgrow the shared-host table. Returns the number of rows removed.
function meenow_monitor_prune(PDO $pdo, array $cfg): int
{
    $deleted = $pdo->exec(
        'DELETE FROM errors WHERE created_at < NOW() - INTERVAL '
        . (int) $cfg['retention_days'] . ' DAY'
    );
    $max = (int) $cfg['max_rows'];
    if ($max > 0) {
        $deleted += $pdo->exec(
            'DELETE FROM errors WHERE id <= (
               SELECT id FROM (SELECT id FROM errors ORDER BY id DESC LIMIT 1
                               OFFSET ' . $max . ') t)'
        );
    }
    return $deleted;
}

// The scheduled tick is the only thing that prunes, so a host that silently
// stops firing its CronJob also stops the reminders. Checked at the start of a
// run: it reports the gap that just happened. A fresh install has no slot yet,
// which is not a stall — an in-cron check can only ever measure between two
// fires. /health exposes the same number for an external pinger, which is what
// catches a cron that never comes back at all.
function meenow_monitor_cron_gap(PDO $pdo, array $cfg): array
{
    $slot = (int) $pdo->query(
        "SELECT MAX(slot) FROM cron_slots WHERE action = 'tick'"
    )->fetchColumn();
    $last = $slot > 0 ? $slot * 1800 : 0;
    $gap = $last > 0 ? time() - $last : null;
    return [
        'last_tick' => $last > 0 ? date('c', $last) : null,
        'gap_s' => $gap,
        'stalled' => $gap !== null && $gap > $cfg['cron_max_gap_s'],
    ];
}
