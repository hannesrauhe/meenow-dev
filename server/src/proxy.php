<?php
declare(strict_types=1);

// Request-body and request-header handling for the proxy in public/app.php.
// Kept separate from the front controller so the awkward parts can be unit
// tested without booting the app (see scripts/test-proxy-body.php).

// Relay the inbound request body upstream; returns [postfields, rebuiltMultipart].
//
// multipart/form-data is the tricky one: PHP consumes it into $_POST/$_FILES and
// leaves php://input EMPTY, so forwarding the raw stream would send a bodyless
// POST upstream — Pixelfed answers 422 "file field is required" and media
// uploads break. Instead the form is rebuilt for curl; an array POSTFIELDS makes
// curl generate its own boundary, which is why proxy_headers() must then drop
// the inbound Content-Type. JSON and urlencoded bodies are not consumed by PHP
// and still go through verbatim.
function proxy_body(): array
{
    $ctype = strtolower($_SERVER['CONTENT_TYPE'] ?? '');
    // PHP only parses multipart bodies on POST; other methods keep the raw stream.
    if (!str_starts_with($ctype, 'multipart/form-data')
        || ($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        return [file_get_contents('php://input') ?: '', false];
    }

    $fields = [];
    foreach ($_POST as $key => $value) {
        proxy_flatten((string) $key, $value, $fields);
    }
    foreach ($_FILES as $key => $file) {
        $key = (string) $key;
        // A `name[]` file field arrives array-shaped. meenow never sends one;
        // refuse loudly rather than silently dropping the upload.
        if (is_array($file['error'] ?? null)) {
            meenow_json_response(400, ['error' => 'unsupported_multipart_field', 'field' => $key]);
        }
        $err = $file['error'] ?? UPLOAD_ERR_NO_FILE;
        if ($err === UPLOAD_ERR_NO_FILE) continue; // upstream validation reports it
        if ($err !== UPLOAD_ERR_OK || !is_string($file['tmp_name'] ?? null)
            || !is_file($file['tmp_name'])) {
            // Almost always upload_max_filesize (see public/.user.ini).
            $cl = $_SERVER['CONTENT_LENGTH'] ?? '?';
            error_log("[proxy] upload '{$key}' rejected by PHP (error {$err}, {$cl} bytes sent)");
            meenow_json_response(413, ['error' => 'upload_too_large', 'field' => $key]);
        }
        $fields[$key] = new CURLFile($file['tmp_name'], $file['type'], $file['name']);
    }

    // Nothing parsed at all despite a body: PHP discards the *entire* POST when
    // it exceeds post_max_size, so the data is already gone. Say so rather than
    // relay an empty form and get a confusing 422 from upstream.
    if ($fields === [] && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
        error_log('[proxy] multipart body of ' . ($_SERVER['CONTENT_LENGTH'] ?? 0)
            . ' bytes exceeded post_max_size and was discarded by PHP');
        meenow_json_response(413, ['error' => 'body_too_large']);
    }
    return [$fields === [] ? '' : $fields, true];
}

// Nested POST arrays become curl's bracket-notation keys (poll[options][0]),
// which Laravel parses back into the original structure.
function proxy_flatten(string $prefix, mixed $value, array &$out): void
{
    if (is_array($value)) {
        foreach ($value as $k => $v) proxy_flatten("{$prefix}[{$k}]", $v, $out);
        return;
    }
    $out[$prefix] = is_bool($value) ? ($value ? 'true' : 'false') : (string) $value;
}

// $rebuiltMultipart: curl picked the body type itself because it built the body,
// so the inbound Content-Type — carrying a boundary that no longer exists — must
// not be forwarded.
function proxy_headers(bool $rebuiltMultipart = false): array
{
    // Accept-Encoding stays identity so the body can be forwarded verbatim;
    // an empty Expect stops curl's 100-continue stall on multi-MB uploads.
    $out = ['Accept-Encoding: identity', 'Expect:'];
    // Content-Type is added explicitly rather than left to the loop: under Apache
    // it only exists as CONTENT_TYPE (not HTTP_*), where the loop cannot see it —
    // and without it, JSON POST bodies (e.g. POST /api/v1/apps) reach upstream as
    // form-encoded and are rejected.
    if (!$rebuiltMultipart && !empty($_SERVER['CONTENT_TYPE'])) {
        $out[] = 'Content-Type: ' . $_SERVER['CONTENT_TYPE'];
    }
    foreach ($_SERVER as $k => $v) {
        if (!str_starts_with($k, 'HTTP_')) continue;
        $name = strtolower(str_replace('_', '-', substr($k, 5)));
        // Strip cookies + host + anything that would let a client pivot the request.
        // accept-encoding is stripped so our identity default is the only one sent.
        // content-type/content-length are stripped unconditionally: php -S (and any
        // CGI-ish SAPI) mirrors them into HTTP_*, where they would duplicate the
        // explicit Content-Type above — with a stale boundary for rebuilt multipart —
        // and a stale Content-Length for a body curl rebuilt itself.
        if (in_array($name, ['cookie', 'host', 'origin', 'referer', 'accept-encoding',
                             'content-type', 'content-length',
                             'x-forwarded-for', 'x-forwarded-host'], true)) continue;
        $out[] = $name . ': ' . $v;
    }
    return $out;
}
