<?php
declare(strict_types=1);

// GET /xkcd.json — the current xkcd comic, served same-origin from a
// server-side cache. xkcd.com sends no CORS headers, so the browser cannot
// fetch it directly. The cache refreshes on the first request after the TTL
// (~one upstream fetch per 6 h regardless of user count); everything else is
// served from the cache file. Fail-soft: a fetch error serves the stale cache,
// and a short back-off marker keeps a broken upstream from being hammered by
// every request.

return function (): void {
    meenow_rate_limit();
    $cfg = meenow_config();
    $cache = $cfg['xkcd_cache'] ?? (__DIR__ . '/../cache/xkcd.json');
    $maxAge = (int) ($cfg['xkcd_ttl_s'] ?? 21600); // 6 h
    $failTtl = 600;                                 // back-off after a failed fetch

    // Serve the cache file if it holds a usable payload. The client re-validates
    // every field (src/api/xkcd.ts); this endpoint never invents data.
    $serve = function () use ($cache): bool {
        if (!is_file($cache)) return false;
        $data = json_decode((string) file_get_contents($cache), true);
        if (!is_array($data) || !isset($data['num'])) return false;
        header('Content-Type: application/json');
        header('Cache-Control: public, max-age=300');
        echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
        return true;
    };

    clearstatcache(true, $cache);
    $age = is_file($cache) && (int) filesize($cache) > 0
        ? time() - (int) filemtime($cache) : PHP_INT_MAX;
    if ($age < $maxAge && $serve()) return;

    // Stale or missing: exactly one request refreshes; the others block on the
    // lock and then serve whatever the winner produced (or stale).
    $dir = dirname($cache);
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $fh = @fopen($cache, 'c'); // 'c' never truncates — stale content stays readable
    if ($fh === false) meenow_json_response(500, ['error' => 'cache_unwritable']);
    if (flock($fh, LOCK_EX)) {
        clearstatcache(true, $cache);
        $age = (int) filesize($cache) > 0 ? time() - (int) filemtime($cache) : PHP_INT_MAX;
        $fail = $cache . '.fail';
        $failAge = is_file($fail) ? time() - (int) filemtime($fail) : PHP_INT_MAX;
        if ($age >= $maxAge && $failAge >= $failTtl) {
            $fresh = meenow_xkcd_fetch();
            if ($fresh !== null) {
                file_put_contents($cache,
                    json_encode($fresh, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
                @unlink($fail);
            } else {
                @touch($fail);
            }
            clearstatcache(true, $cache);
        }
        flock($fh, LOCK_UN);
    }
    fclose($fh);

    if ($serve()) return;
    meenow_json_response(502, ['error' => 'xkcd_unavailable']);
};

// Fetch + validate the upstream payload. Returns null on any problem — the
// caller decides between stale-serving and 502. Same field caps as before.
function meenow_xkcd_fetch(): ?array
{
    try {
        $ch = curl_init('https://xkcd.com/info.0.json');
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_USERAGENT => 'meenow/1.0 (https://meenow.de)',
        ]);
        $raw = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($raw === false || $status !== 200) return null;

        $data = json_decode((string) $raw, true);
        if (!is_array($data)) return null;
        $num = $data['num'] ?? null;
        $img = $data['img'] ?? '';
        if (!is_int($num) || $num <= 0 || !str_starts_with((string) $img, 'https://imgs.xkcd.com/')) {
            return null;
        }
        return [
            'num' => $num,
            'title' => mb_substr((string) ($data['title'] ?? ''), 0, 300),
            'img' => $img,
            'alt' => mb_substr((string) ($data['alt'] ?? ''), 0, 2000),
        ];
    } catch (Throwable $e) {
        error_log('[xkcd] fetch failed: ' . $e->getMessage());
        return null;
    }
}
