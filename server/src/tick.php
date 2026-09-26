<?php
declare(strict_types=1);

// Per-subscription timezone-gated daily reminder, run from the URL-cron.
// Same window logic: send while now ∈ [trigger, trigger + 120min),
// plus one 20:30–21:00 local "last call" (payload late:true) when the trigger
// window already closed before it. Returns a summary array for the cron JSON.

use Minishlink\WebPush\Subscription;
use Minishlink\WebPush\WebPush;

require_once __DIR__ . '/Trigger.php';

const TICK_WINDOW_MIN = 120;
const LAST_CALL_HOUR = 20;
const LAST_CALL_MIN = 30;
const LAST_CALL_ACCEPT_MIN = 30;
const DEFAULT_TZ = 'Europe/Berlin';

function tick_decision(int $now, string $tz): array
{
    $trigger = Trigger::triggerEpochInZone($now, $tz);
    $windowEnd = $trigger + TICK_WINDOW_MIN * 60;
    if ($now >= $trigger && $now < $windowEnd) return ['send' => true, 'late' => false];

    $dateStr = Trigger::dateStringInZone($now, $tz);
    $lastCall = Trigger::zonedEpochSec($dateStr, LAST_CALL_HOUR, LAST_CALL_MIN, $tz);
    if ($windowEnd <= $lastCall && $now >= $lastCall && $now < $lastCall + LAST_CALL_ACCEPT_MIN * 60) {
        return ['send' => true, 'late' => true];
    }
    return ['send' => false, 'late' => false];
}

return function (array $opts = []): array {
    $cfg = meenow_config();
    $now = time();
    $force = (bool) ($opts['force'] ?? false);

    $vapidKeys = json_decode(file_get_contents($cfg['vapid']['key_file']), true);
    $auth = ['VAPID' => [
        'subject' => $cfg['vapid']['subject'],
        'publicKey' => $vapidKeys['publicKey'],
        'privateKey' => $vapidKeys['privateKey'],
    ]];
    $webPush = new WebPush($auth, ['TTL' => 45 * 60, 'urgency' => 'high']);

    $rows = meenow_db()->query(
        'SELECT id, endpoint, p256dh, auth, tz FROM subscriptions'
    )->fetchAll(PDO::FETCH_ASSOC);

    $sent = 0; $skipped = 0; $expired = 0; $failed = 0;

    foreach ($rows as $row) {
        $tz = $row['tz'] !== '' ? $row['tz'] : DEFAULT_TZ;
        $decision = $force ? ['send' => true, 'late' => false] : tick_decision($now, $tz);
        if (!$decision['send']) { $skipped++; continue; }

        $payloadArr = ['ts' => $now * 1000]; // ms, like the Node script
        if ($decision['late']) $payloadArr['late'] = true;
        if ($force) $payloadArr['force'] = true;
        $payload = json_encode($payloadArr);

        $subscription = Subscription::create([
            'endpoint' => $row['endpoint'],
            'publicKey' => $row['p256dh'],
            'authToken' => $row['auth'],
        ]);

        try {
            $response = $webPush->sendOneNotification($subscription, $payload);
            if ($response->isSuccess()) { $sent++; continue; }
            // 404/410 = expired/unregistered. 400 is not reliable expiry, keep it.
            if ($response->isSubscriptionExpired()) {
                meenow_db()->prepare('DELETE FROM subscriptions WHERE id = ?')->execute([$row['id']]);
                $expired++;
            } else {
                error_log("[tick] push failed {$row['endpoint']}: " . $response->getReason());
                $failed++;
            }
        } catch (Throwable $e) {
            error_log('[tick] push error: ' . $e->getMessage());
            $failed++;
        }
    }

    return ['subscriptions' => count($rows), 'sent' => $sent, 'skipped' => $skipped,
            'expired' => $expired, 'failed' => $failed];
};
