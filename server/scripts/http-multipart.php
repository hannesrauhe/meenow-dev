<?php
declare(strict_types=1);

// Multipart POST client for the local test harness (php -S has no curl CLI, and
// PHP's http stream context needs the body assembled by hand). Sends one real
// file field named "file" plus plain fields, like the PWA's media upload.
// Usage: php scripts/http-multipart.php URL /path/file [field=value ...]
// Prints "STATUS <code>" then the body.
[$_, $url, $filePath] = array_pad($argv, 3, null);
if (!$url || !$filePath || !is_file($filePath)) {
    fwrite(STDERR, "usage: http-multipart.php URL /path/file [field=value ...]\n");
    exit(2);
}
$fieldName = 'file';

$boundary = 'meenowtest' . bin2hex(random_bytes(8));
$parts = "--{$boundary}\r\n"
    . "Content-Disposition: form-data; name=\"{$fieldName}\"; filename=\"meenow.jpg\"\r\n"
    . "Content-Type: image/jpeg\r\n\r\n"
    . file_get_contents($filePath) . "\r\n";
foreach (array_slice($argv, 3) as $kv) {
    [$k, $v] = explode('=', $kv, 2);
    $parts .= "--{$boundary}\r\nContent-Disposition: form-data; name=\"{$k}\"\r\n\r\n{$v}\r\n";
}
$parts .= "--{$boundary}--\r\n";

$header = "Content-Type: multipart/form-data; boundary={$boundary}\r\n"
        . "Content-Length: " . strlen($parts) . "\r\n";
if (($auth = getenv('MEENOW_AUTH')) !== false && $auth !== '') {
    $header .= "Authorization: {$auth}\r\n";
}
$ctx = stream_context_create(['http' => [
    'method' => 'POST',
    'header' => $header,
    'content' => $parts,
    'ignore_errors' => true,   // read body even on 4xx/5xx
    'timeout' => 60,
]]);
$resp = @file_get_contents($url, false, $ctx);
$status = 0;
foreach ($http_response_header ?? [] as $h) {
    if (preg_match('#^HTTP/\S+ (\d{3})#', $h, $m)) $status = (int) $m[1];
}
echo "STATUS {$status}\n" . ($resp === false ? '' : $resp) . "\n";
