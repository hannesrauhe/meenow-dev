<?php
declare(strict_types=1);

// Generates a VAPID keypair (P-256) using the web-push library's own generator
// and stores it as base64url JSON in config/vapid.json (the library's native
// format — no PEM round-trip needed). Run once on the server:
//   php scripts/gen-vapid.php
// Existing keys are not overwritten.

require __DIR__ . '/../vendor/autoload.php';

use Minishlink\WebPush\VAPID;

$configDir = __DIR__ . '/../config';
if (!is_dir($configDir)) mkdir($configDir, 0775);
$keyFile = $configDir . '/vapid.json';

if (is_file($keyFile)) {
    fwrite(STDERR, "Refusing to overwrite existing {$keyFile}\n");
    exit(1);
}

$keys = VAPID::createVapidKeys();
file_put_contents($keyFile, json_encode($keys, JSON_PRETTY_PRINT) . "\n");
chmod($keyFile, 0600);

echo "keys written to: {$keyFile} (chmod 600)\n";
echo "public key (for reference): {$keys['publicKey']}\n";
