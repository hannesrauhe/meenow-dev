<?php
// Router for `php -S` local testing: mimics the .htaccess rewrite. Existing
// files are served as-is; everything else goes through the front controller.
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$file = __DIR__ . '/../public' . $path;
if ($path !== '/' && is_file($file)) {
    // Let the built-in server handle static files (incl. correct MIME).
    return false;
}
require __DIR__ . '/../public/app.php';
