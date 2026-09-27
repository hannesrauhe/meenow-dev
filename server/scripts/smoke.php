<?php
declare(strict_types=1);

// CLI smoke test on the server: verifies config, DB, VAPID signing, and
// outbound HTTPS to the push services. Run: php scripts/smoke.php
// (Does NOT send a real push — that needs a browser subscription; use the app.)

require __DIR__ . '/../src/bootstrap.php';

$fail = 0;
function check(string $name, callable $fn): void
{
    global $fail;
    try {
        $detail = $fn();
        echo "OK   {$name}" . ($detail !== null ? " — {$detail}" : '') . "\n";
    } catch (Throwable $e) {
        $fail++;
        echo "FAIL {$name} — {$e->getMessage()}\n";
    }
}

check('config readable', function () {
    $cfg = meenow_config();
    foreach (['home_instance', 'cron_key'] as $k) {
        if (empty($cfg[$k])) throw new RuntimeException("config.{$k} is empty");
    }
    if (empty($cfg['vapid']['subject'])) throw new RuntimeException('vapid.subject is empty');
    if (!is_file($cfg['vapid']['key_file'])) throw new RuntimeException('vapid key file missing');
    return $cfg['home_instance'];
});

check('db connect + schema', function () {
    $pdo = meenow_db();
    foreach (['subscriptions', 'rate_hits', 'cron_slots'] as $t) {
        $pdo->query("SELECT 1 FROM {$t} LIMIT 1");
    }
    return 'tables present';
});

check('vapid sign (ES256)', function () {
    $cfg = meenow_config();
    $keys = json_decode(file_get_contents($cfg['vapid']['key_file']), true);
    if (empty($keys['publicKey']) || empty($keys['privateKey'])) throw new RuntimeException('key file incomplete');
    // Same path WebPush takes internally: validate (length checks) then mint
    // the Authorization header.
    $vapid = Minishlink\WebPush\VAPID::validate([
        'subject' => $cfg['vapid']['subject'],
        'publicKey' => $keys['publicKey'],
        'privateKey' => $keys['privateKey'],
    ]);
    $headers = Minishlink\WebPush\VAPID::getVapidHeaders(
        'https://fcm.googleapis.com', $vapid['subject'],
        $vapid['publicKey'], $vapid['privateKey'], 'aes128gcm'
    );
    if (empty($headers['Authorization'])) throw new RuntimeException('no Authorization header minted');
    return 'vapid jwt minted';
});

check('outbound https: pixelfed.social', function () {
    $cfg = meenow_config();
    $ch = curl_init("https://{$cfg['home_instance']}/api/v1/instance");
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15]);
    $ok = curl_exec($ch) !== false;
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if (!$ok) throw new RuntimeException('curl failed');
    return "HTTP {$code}";
});

foreach (['fcm.googleapis.com', 'push.services.mozilla.com', 'web.push.apple.com'] as $host) {
    check("outbound https: {$host}", function () use ($host) {
        $ch = curl_init("https://{$host}/");
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15]);
        $ok = curl_exec($ch) !== false;
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if (!$ok) throw new RuntimeException('TLS/connect failed');
        return "HTTP {$code} (any response = reachable)";
    });
}

echo $fail === 0 ? "\nAll checks passed.\n" : "\n{$fail} check(s) FAILED.\n";
exit($fail === 0 ? 0 : 1);
