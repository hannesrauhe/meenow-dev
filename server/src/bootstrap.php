<?php
declare(strict_types=1);

spl_autoload_register(function (string $class): void {
    $file = __DIR__ . '/' . str_replace('\\', '/', $class) . '.php';
    if (is_file($file)) require $file;
});

$autoload = __DIR__ . '/../vendor/autoload.php';
if (!is_file($autoload)) {
    http_response_code(500);
    header('Content-Type: text/plain');
    exit("vendor/ missing — run `composer install --no-dev` in the app directory\n");
}
require $autoload;

function meenow_config(): array
{
    static $config = null;
    if ($config === null) {
        $file = __DIR__ . '/../config/config.php';
        if (!is_file($file)) {
            http_response_code(500);
            header('Content-Type: text/plain');
            exit("config/config.php missing — copy config.example.php and fill it in\n");
        }
        $config = require $file;
    }
    return $config;
}

function meenow_db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $db = meenow_config()['db'];
        $pdo = new PDO(
            "mysql:host={$db['host']};dbname={$db['name']};charset=utf8mb4",
            $db['user'],
            $db['pass'],
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]
        );
    }
    return $pdo;
}

function meenow_client_ip(): string
{
    // REMOTE_ADDR only: trusted only when the app is the edge (no CDN/proxy in
    // front); X-Forwarded-For would otherwise be attacker-controlled.
    return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}

// Fixed-window counter (one row per IP per minute). Throws a 429 response when
// the configured budget is exhausted.
function meenow_rate_limit(): void
{
    $cfg = meenow_config()['rate_limit'];
    $minute = intdiv(time(), 60);
    $ip = meenow_client_ip();

    $pdo = meenow_db();
    $stmt = $pdo->prepare(
        'INSERT INTO rate_hits (ip, minute, cnt) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE cnt = cnt + 1'
    );
    $stmt->execute([$ip, $minute]);

    $stmt = $pdo->prepare('SELECT cnt FROM rate_hits WHERE ip = ? AND minute = ?');
    $stmt->execute([$ip, $minute]);
    $cnt = (int) $stmt->fetchColumn();

    if ($cnt > $cfg['max']) {
        http_response_code(429);
        header('Retry-After: 60');
        header('Content-Type: application/json');
        echo json_encode(['error' => 'rate_limited']);
        exit;
    }
}

function meenow_json_input(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw ?: '', true);
    if (!is_array($data)) {
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'invalid_json']);
        exit;
    }
    return $data;
}

function meenow_json_response(int $status, array $body): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($body);
    exit;
}
