<?php
declare(strict_types=1);

// Unit test for the proxy's body/header handling (src/proxy.php) — the part the
// integration suite cannot reach: it needs a real multipart upload and a way to
// inspect what curl would be handed. Run: php scripts/test-proxy-body.php
// Exits non-zero on failure.

require __DIR__ . '/../src/proxy.php';

$GLOBALS['PASS'] = 0; $GLOBALS['FAIL'] = 0;
function ok(string $name): void { $GLOBALS['PASS']++; echo "OK   {$name}\n"; }
function bad(string $name, string $why): void { $GLOBALS['FAIL']++; echo "FAIL {$name} — {$why}\n"; }
function same(string $name, mixed $want, mixed $got): void
{
    $want === $got ? ok($name)
        : bad($name, 'expected ' . var_export($want, true) . ', got ' . var_export($got, true));
}

// proxy_body()/proxy_headers() read superglobals; reset them per scenario.
function reset_server(array $server = []): void
{
    $_SERVER = $server + ['REQUEST_METHOD' => 'POST', 'REMOTE_ADDR' => '127.0.0.1'];
    $_POST = []; $_FILES = [];
}

function upload(string $tmp, int $err = UPLOAD_ERR_OK): array
{
    return ['name' => 'meenow.jpg', 'type' => 'image/jpeg', 'tmp_name' => $tmp,
            'error' => $err, 'size' => 4096];
}

// The error paths call meenow_json_response(), which exits — so run those in a
// subprocess and assert on what it printed. "UNREACHABLE" after proxy_body()
// proves the request was refused instead of relayed. The stub mirrors the real
// one in bootstrap.php (requiring that would drag in vendor/ and config/).
function child(string $superglobals): string
{
    $code = "<?php\nfunction meenow_json_response(int \$s, array \$b): void {"
        . " echo json_encode(\$b); exit; }\n"
        . "require " . var_export(__DIR__ . '/../src/proxy.php', true) . ";\n"
        . $superglobals . "\nproxy_body();\necho 'UNREACHABLE';\n";
    $file = tempnam(sys_get_temp_dir(), 'pbt') . '.php';
    file_put_contents($file, $code);
    $out = [];
    exec('php ' . escapeshellarg($file) . ' 2>/dev/null', $out);
    unlink($file);
    return implode('', $out);
}

// --- multipart: PHP consumes the body, so it must be rebuilt ----------------
$tmp = tempnam(sys_get_temp_dir(), 'up');
file_put_contents($tmp, str_repeat('x', 4096));

reset_server(['CONTENT_TYPE' => 'multipart/form-data; boundary=abc']);
$_POST = ['description' => 'meenow — daily photo'];
$_FILES = ['file' => upload($tmp)];
[$body, $rebuilt] = proxy_body();
same('multipart: rebuilt flag', true, $rebuilt);
same('multipart: file forwarded', true, $body['file'] instanceof CURLFile);
same('multipart: text field kept', 'meenow — daily photo', $body['description']);
same('multipart: filename preserved', 'meenow.jpg', $body['file']->getPostFilename());
same('multipart: mime preserved', 'image/jpeg', $body['file']->getMIMEType());
same('multipart: readable from disk', 4096, filesize($body['file']->getFilename()));
// The inbound boundary is stale once curl rebuilds the body — forwarding it
// would leave upstream parsing an empty form (the original 422).
$hasCtype = (bool) array_filter(proxy_headers($rebuilt),
    fn($h) => stripos($h, 'content-type:') === 0);
same('multipart: stale boundary header dropped', false, $hasCtype);

// --- nested fields (polls) keep Laravel's bracket notation ------------------
reset_server(['CONTENT_TYPE' => 'multipart/form-data; boundary=abc']);
$_POST = ['poll' => ['options' => ['a', 'b'], 'expires_in' => 86400], 'sensitive' => false];
[$body] = proxy_body();
same('nested arrays flattened',
    ['poll[options][0]' => 'a', 'poll[options][1]' => 'b',
     'poll[expires_in]' => '86400', 'sensitive' => 'false'], $body);

// --- an empty upload field is skipped, not an error -------------------------
reset_server(['CONTENT_TYPE' => 'multipart/form-data; boundary=abc']);
$_FILES = ['file' => upload('', UPLOAD_ERR_NO_FILE)];
[$body, $rebuilt] = proxy_body();
same('no-file field skipped', '', $body);
same('no-file still multipart', true, $rebuilt);

// --- a file PHP refused (upload_max_filesize) is a clear 413 ---------------
$out = child(
    "\$_SERVER = ['REQUEST_METHOD'=>'POST','CONTENT_TYPE'=>'multipart/form-data; boundary=a',"
    . "'CONTENT_LENGTH'=>'99000000']; \$_POST = [];"
    . "\$_FILES = ['file'=>['name'=>'x.jpg','type'=>'image/jpeg','tmp_name'=>'',"
    . "'error'=>UPLOAD_ERR_INI_SIZE,'size'=>0]];"
);
same('oversized upload: 413 body', true, str_contains($out, '"error":"upload_too_large"'));
same('oversized upload: nothing relayed', false, str_contains($out, 'UNREACHABLE'));

// --- body past post_max_size: PHP discarded everything, say 413 -------------
$out = child(
    "\$_SERVER = ['REQUEST_METHOD'=>'POST','CONTENT_TYPE'=>'multipart/form-data; boundary=a',"
    . "'CONTENT_LENGTH'=>'99000000']; \$_POST = []; \$_FILES = [];"
);
same('post_max_size overflow: 413 body', true, str_contains($out, '"error":"body_too_large"'));

// --- JSON / urlencoded: not consumed by PHP, forwarded verbatim -------------
reset_server(['CONTENT_TYPE' => 'application/json']);
same('json: not rebuilt', false, proxy_body()[1]);
reset_server(['CONTENT_TYPE' => 'application/x-www-form-urlencoded']);
same('urlencoded: not rebuilt', false, proxy_body()[1]);
// PHP only parses multipart on POST, so other methods keep the raw stream.
reset_server(['CONTENT_TYPE' => 'multipart/form-data; boundary=a',
              'REQUEST_METHOD' => 'PATCH']);
same('multipart on PATCH: raw stream', false, proxy_body()[1]);

// --- header hygiene ---------------------------------------------------------
// php -S (unlike Apache) also mirrors Content-Type/Length into HTTP_*, where a
// second content-type would reach upstream with a stale boundary (Cloudflare
// 400s on that) and a stale content-length would contradict curl's own body.
reset_server(['CONTENT_TYPE' => 'application/json', 'HTTP_COOKIE' => 'session=secret',
              'HTTP_HOST' => 'meenow.de', 'HTTP_AUTHORIZATION' => 'Bearer t',
              'HTTP_X_FORWARDED_FOR' => '1.2.3.4', 'HTTP_ACCEPT_ENCODING' => 'gzip',
              'HTTP_CONTENT_TYPE' => 'application/json', 'HTTP_CONTENT_LENGTH' => '17']);
$hdrs = proxy_headers(false);
$joined = strtolower(implode("\n", $hdrs));
same('json: content-type forwarded', true,
    str_contains($joined, 'content-type: application/json'));
same('auth forwarded', true, str_contains($joined, 'authorization: bearer t'));
foreach (['cookie:', 'host:', 'x-forwarded-for:', 'accept-encoding: gzip',
          'content-length:'] as $leaky) {
    same("stripped {$leaky}", false, str_contains($joined, $leaky));
}
same('identity encoding set', true, str_contains($joined, 'accept-encoding: identity'));
same('100-continue disabled', true, in_array('Expect:', $hdrs, true));
same('no duplicate content-type', 1, count(array_filter(
    $hdrs, fn($h) => stripos($h, 'content-type:') === 0)));
// Rebuilt multipart: even the explicit one must go; curl supplies its own.
$mp = proxy_headers(true);
same('rebuilt multipart: no content-type at all', 0, count(array_filter(
    $mp, fn($h) => stripos($h, 'content-type:') === 0)));

unlink($tmp);
echo "\nPASS={$GLOBALS['PASS']} FAIL={$GLOBALS['FAIL']}\n";
exit($GLOBALS['FAIL'] === 0 ? 0 : 1);
