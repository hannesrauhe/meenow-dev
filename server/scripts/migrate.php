<?php
declare(strict_types=1);

// Apply the database schema to the configured MySQL/MariaDB database.
// Idempotent — safe (and intended) to run on every deploy:
//   * baseline: schema.sql, whose CREATE TABLE IF NOT EXISTS creates any
//     missing table and never touches an existing one;
//   * migrations below: ALTERs for changes that postdate schema.sql, each
//     guarded by an information_schema lookup so re-running is a no-op.
// (schema.sql alone can never change an EXISTING table — that is exactly what
// the migration list is for. New column/table change = new entry at the bottom.)
//
// Usage: php scripts/migrate.php [path/to/config.php]
// install.sh runs it BEFORE swapping in the new build, so a DB failure leaves
// the previous build in place. Additive-only: rolling the app back to an older
// build with a migrated schema is fine (old code ignores new columns).

$configPath = $argv[1] ?? __DIR__ . '/../config/config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "migrate: no config at {$configPath}\n");
    exit(1);
}
$cfg = require $configPath;
$db = $cfg['db'] ?? [];
if (empty($db['name']) || empty($db['user'])) {
    fwrite(STDERR, "migrate: config db.name/db.user are empty — fill in config/config.php first\n");
    exit(1);
}
try {
    $pdo = new PDO(
        "mysql:host={$db['host']};dbname={$db['name']};charset=utf8mb4",
        $db['user'],
        $db['pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
} catch (PDOException $e) {
    fwrite(STDERR, "migrate: cannot connect to db '{$db['name']}' on {$db['host']}: {$e->getMessage()}\n");
    exit(1);
}
$dbName = $db['name'];

$hasColumn = function (string $table, string $column) use ($pdo, $dbName): bool {
    $st = $pdo->prepare(
        'SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?'
    );
    $st->execute([$dbName, $table, $column]);
    return (bool) $st->fetchColumn();
};
$hasIndex = function (string $table, string $index) use ($pdo, $dbName): bool {
    $st = $pdo->prepare(
        'SELECT 1 FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1'
    );
    $st->execute([$dbName, $table, $index]);
    return (bool) $st->fetchColumn();
};

// --- baseline: schema.sql -------------------------------------------------------
// Statements end at a ";" at end of line; "--" lines are comments.
$sql = (string) file_get_contents(__DIR__ . '/../schema.sql');
$statements = preg_split(
    '/;\s*$/m',
    (string) preg_replace('/^\s*--.*$/m', '', $sql)
);
foreach ($statements as $statement) {
    $statement = trim($statement);
    if ($statement !== '') $pdo->exec($statement);
}
echo "schema   baseline applied (schema.sql)\n";

// --- migrations: additive-only, each guarded so re-running is a no-op ----------
$migrations = [
    // subscriptions.account — the self-asserted owner of a push subscription
    // ("<instance>:<accountId>"); see the comment in schema.sql. Column and
    // index are guarded separately so a half-applied state repairs itself.
    [
        'name' => 'subscriptions.account column',
        'needed' => fn(): bool => !$hasColumn('subscriptions', 'account'),
        'sql' => "ALTER TABLE subscriptions ADD COLUMN account VARCHAR(191) NOT NULL DEFAULT '' AFTER tz",
    ],
    [
        'name' => 'subscriptions.account index',
        'needed' => fn(): bool => !$hasIndex('subscriptions', 'account'),
        'sql' => 'ALTER TABLE subscriptions ADD KEY account (account)',
    ],
];

$applied = 0;
foreach ($migrations as $m) {
    if (!($m['needed'])()) {
        echo "skip     {$m['name']} (already present)\n";
        continue;
    }
    $pdo->exec($m['sql']);
    $applied++;
    echo "apply    {$m['name']}\n";
}

echo "migrate: done, {$applied} migration(s) applied.\n";
