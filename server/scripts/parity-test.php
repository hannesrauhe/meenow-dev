<?php
declare(strict_types=1);

// Prints trigger-math outputs for a fixed corpus, one line per case, in the
// same format as scripts/parity-test.mjs. Diff the two outputs to prove the
// PHP port matches the JS original bit-for-bit. Run: php scripts/parity-test.php

require __DIR__ . '/../src/Trigger.php';

$dates = [];
foreach ([2026] as $y) {
    foreach (range(1, 12) as $m) {
        foreach ([1, 7, 15, 20, 28] as $d) {
            $dates[] = sprintf('%04d-%02d-%02d', $y, $m, $d);
        }
    }
}
$dates[] = '2027-01-01';
$dates[] = '2025-12-31';

foreach ($dates as $d) {
    echo "offset {$d} " . Trigger::triggerOffsetMinutes($d) . "\n";
}

$zones = ['Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'Australia/Lord_Howe',
          'America/Santiago', 'Pacific/Chatham', 'Asia/Kathmandu', 'UTC'];
// Fixed instants incl. DST transition hours (March/October EU, March/November US).
$instants = [
    1774300000, // 2026-03-22 ~03:26 UTC — inside EU DST gap/overlap zone
    1761300000, // 2025-10-24 — EU DST end weekend
    1773600000, // 2026-03-15
    1783900000, // 2026-07-12
    1751000000, // 2025-06-27
];
foreach ($instants as $ts) {
    foreach ($zones as $tz) {
        echo "date {$ts} {$tz} " . Trigger::dateStringInZone($ts, $tz) . "\n";
        echo "trig {$ts} {$tz} " . Trigger::triggerEpochInZone($ts, $tz) . "\n";
    }
}
