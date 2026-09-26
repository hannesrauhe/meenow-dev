<?php
declare(strict_types=1);

// Front controller (reached via the .htaccess rewrite; the PWA's index.html is
// the directory index). Routes:
//   /api/*, /oauth/token -> Pixelfed pass-through proxy (the CORS killer)
//   /push/*              -> Web Push subscription store
//   /xkcd.json           -> cached xkcd mirror (refresh-on-request)
//   /cron                -> URL-cron entry point (daily tick)
//   /health              -> liveness probe
// Note: /oauth/authorize is deliberately NOT proxied — it is a top-level browser
// navigation (not subject to CORS) and proxying its HTML/login form would break.
// Layout: this file lives in <app>/public (the docroot); src/, config/, cache/
// and vendor/ are its siblings and therefore outside the web root. MEENOW_APP
// overrides the app root (used by the local test harness).
$appRoot = getenv('MEENOW_APP') ?: dirname(__DIR__);
if (!is_file($appRoot . '/src/bootstrap.php')) {
    http_response_code(500);
    header('Content-Type: text/plain');
    exit("cannot locate app root (src/bootstrap.php) — set MEENOW_APP\n");
}
require $appRoot . '/src/bootstrap.php';

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

// The PWA is served from this same origin (docroot = public/), so anything that
// is an existing file is served by the webserver itself; this router only sees
// the rewrites from .htaccess.
match (true) {
    $path === '/health' => health(),
    $path === '/cron' => require $appRoot . '/src/cron.php',
    $path === '/xkcd.json' => (require $appRoot . '/src/xkcd.php')(),
    str_starts_with($path, '/api/') || $path === '/oauth/token' => proxy($path),
    str_starts_with($path, '/push/') => push($path),
    default => meenow_json_response(404, ['error' => 'not_found']),
};

function health(): void
{
    meenow_db(); // also proves DB connectivity
    meenow_json_response(200, ['ok' => true, 'php' => PHP_VERSION]);
}

function proxy(string $path): void
{
    $cfg = meenow_config();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    // No anonymous relaying: every proxied request must carry the user's
    // Bearer token (we don't validate it — Pixelfed does; we just refuse to
    // be a free proxy for IP laundering). Abuse therefore requires a real
    // pixelfed.social account and stays attributable to its token.
    // The two bootstrap endpoints run before a token exists and stay open
    // (rate-limited): app registration and the PKCE token exchange, which is
    // useless without the verifier held by the original browser.
    $open = $path === '/oauth/token'
        || ($path === '/api/v1/apps' && $method === 'POST');
    if (!$open && empty($_SERVER['HTTP_AUTHORIZATION'])) {
        meenow_json_response(401, ['error' => 'authorization_required']);
    }
    if ($open) meenow_rate_limit();

    $target = 'https://' . $cfg['home_instance'] . $path;
    $qs = $_SERVER['QUERY_STRING'] ?? '';
    if ($qs !== '') $target .= '?' . $qs;

    if (!in_array($method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], true)) {
        meenow_json_response(405, ['error' => 'method_not_allowed']);
    }

    $ch = curl_init($target);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 120,
        CURLOPT_PROTOCOLS_STR => 'https', // never let the target scheme downgrade
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_HTTPHEADER => proxy_headers(),
        CURLOPT_HEADER => true,
    ]);
    if ($method !== 'GET' && $method !== 'HEAD') {
        // Bodies are small (JSON + a few-MB JPEGs); buffering is fine.
        curl_setopt($ch, CURLOPT_POSTFIELDS, file_get_contents('php://input') ?: '');
    }

    $response = curl_exec($ch);
    if ($response === false) {
        $err = curl_error($ch);
        curl_close($ch);
        error_log("[proxy] curl error for {$target}: {$err}");
        meenow_json_response(502, ['error' => 'upstream_unreachable']);
    }
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);

    $headers = substr($response, 0, $headerSize);
    $body = substr($response, $headerSize);

    http_response_code($status);
    foreach (explode("\r\n", $headers) as $line) {
        if (!preg_match('/^([^:]+):\s*(.*)$/', $line, $m)) continue;
        $name = strtolower($m[1]);
        // Hop-by-hop / curl-managed headers must not be re-sent; content-type
        // and content-length matter, everything else is noise or dangerous.
        if (in_array($name, ['transfer-encoding', 'connection', 'set-cookie', 'content-encoding'], true)) continue;
        header($m[1] . ': ' . $m[2], true);
    }
    echo $body;
}

function proxy_headers(): array
{
    $out = ['Accept-Encoding: identity']; // keep the body plain so we can forward it verbatim
    // Apache/PHP expose Content-Type/Length as CONTENT_TYPE/CONTENT_LENGTH, NOT
    // HTTP_*, so the loop below cannot see them. Without this, JSON POST bodies
    // (e.g. POST /api/v1/apps) reach upstream as form-encoded and are rejected.
    if (!empty($_SERVER['CONTENT_TYPE'])) {
        $out[] = 'Content-Type: ' . $_SERVER['CONTENT_TYPE'];
    }
    foreach ($_SERVER as $k => $v) {
        if (!str_starts_with($k, 'HTTP_')) continue;
        $name = strtolower(str_replace('_', '-', substr($k, 5)));
        // Strip cookies + host + anything that would let a client pivot the request.
        // accept-encoding is stripped so our identity default is the only one sent.
        if (in_array($name, ['cookie', 'host', 'origin', 'referer', 'accept-encoding',
                             'x-forwarded-for', 'x-forwarded-host'], true)) continue;
        $out[] = $name . ': ' . $v;
    }
    // Content-Type for bodies that arrive without an HTTP_ header (rare) is
    // already covered by PHP's normalisation above.
    return $out;
}

function push(string $path): void
{
    if ($path === '/push/public-key') {
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
            meenow_json_response(405, ['error' => 'method_not_allowed']);
        }
        $keys = json_decode(
            (string) file_get_contents(meenow_config()['vapid']['key_file']), true
        );
        meenow_json_response(200, ['publicKey' => $keys['publicKey'] ?? null]);
    }

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'POST') meenow_json_response(405, ['error' => 'method_not_allowed']);
    meenow_rate_limit();

    $body = meenow_json_input();
    $endpoint = $body['endpoint'] ?? null;

    if (!is_string($endpoint) || strlen($endpoint) > 500 || !preg_match('#^https://#', $endpoint)) {
        meenow_json_response(400, ['error' => 'invalid_subscription']);
    }

    if ($path === '/push/unsubscribe') {
        unsubscribe(meenow_db(), $endpoint); // only the endpoint is needed
    }

    $p256dh = $body['keys']['p256dh'] ?? null;
    $auth = $body['keys']['auth'] ?? null;
    $tz = $body['tz'] ?? null;

    if (!is_string($p256dh) || !is_string($auth)
        || strlen($p256dh) > 128 || strlen($auth) > 128) {
        meenow_json_response(400, ['error' => 'invalid_subscription']);
    }
    if (!is_string($tz) || strlen($tz) > 64 || !preg_match('#^[A-Za-z0-9_+/-]+$#', $tz)) {
        $tz = 'Europe/Berlin';
    }
    // Reject unknown zones so a typo doesn't silently fall back and mis-gate ticks.
    try {
        new DateTimeZone($tz);
    } catch (Exception) {
        $tz = 'Europe/Berlin';
    }

    $pdo = meenow_db();
    match ($path) {
        '/push/subscribe' => subscribe($pdo, $endpoint, $p256dh, $auth, $tz),
        '/push/unsubscribe' => unsubscribe($pdo, $endpoint),
        default => meenow_json_response(404, ['error' => 'not_found']),
    };
}

function subscribe(PDO $pdo, string $endpoint, string $p256dh, string $auth, string $tz): void
{
    $stmt = $pdo->prepare(
        'INSERT INTO subscriptions (endpoint, p256dh, auth, tz) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth), tz = VALUES(tz)'
    );
    $stmt->execute([$endpoint, $p256dh, $auth, $tz]);
    meenow_json_response(200, ['ok' => true]);
}

function unsubscribe(PDO $pdo, string $endpoint): void
{
    $stmt = $pdo->prepare('DELETE FROM subscriptions WHERE endpoint = ?');
    $stmt->execute([$endpoint]);
    meenow_json_response(200, ['ok' => true]);
}
