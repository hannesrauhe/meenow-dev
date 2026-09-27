<?php
// Tiny HTTP client for the local test harness (php -S has no curl CLI).
// Usage: php scripts/http.php METHOD URL [JSON_BODY]
// Optional MEENOW_AUTH env var is sent as the Authorization header.
// Prints "STATUS <code>" then the body.
[$_, $method, $url, $body] = array_pad($argv, 4, null);
$header = "Content-Type: application/json\r\n";
if (($auth = getenv('MEENOW_AUTH')) !== false && $auth !== '') {
    $header .= "Authorization: {$auth}\r\n";
}
$opts = ['http' => [
    'method' => $method,
    'header' => $header,
    'ignore_errors' => true,   // read body even on 4xx/5xx
    'timeout' => 60,
]];
if ($body !== null) $opts['http']['content'] = $body;
$ctx = stream_context_create($opts);
$resp = @file_get_contents($url, false, $ctx);
$status = 0;
foreach ($http_response_header ?? [] as $h) {
    if (preg_match('#^HTTP/\S+ (\d{3})#', $h, $m)) $status = (int) $m[1];
}
echo "STATUS {$status}\n" . ($resp === false ? '' : $resp) . "\n";
