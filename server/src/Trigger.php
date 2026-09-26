<?php
declare(strict_types=1);

// PHP port of src/trigger-core.mjs (meenow-dev). The math MUST stay bit-identical
// to the JS implementation — users' trigger times are derived from it. Verified by
// scripts/parity-test.php against the Node original.

final class Trigger
{
    public const WINDOW_START_HOUR = 9;          // 9:00 AM local
    public const WINDOW_MINUTES = 12 * 60;       // 9:00 AM – 9:00 PM = 720 min

    /** djb2 with Math.imul semantics: 32-bit truncated product, unsigned result. */
    private static function djb2(string $s): int
    {
        $h = 5381;
        $len = strlen($s);
        for ($i = 0; $i < $len; $i++) {
            $h = ((($h * 33) & 0xFFFFFFFF) ^ ord($s[$i])) & 0xFFFFFFFF;
        }
        return $h;
    }

    private static function xorshift32(int $seed): int
    {
        // Non-zero seed guard: xorshift32 has a fixed point at 0.
        $x = $seed === 0 ? 2463534242 : $seed;
        $x = ($x ^ (($x << 13) & 0xFFFFFFFF)) & 0xFFFFFFFF;
        $x = ($x ^ ($x >> 17)) & 0xFFFFFFFF;
        $x = ($x ^ (($x << 5) & 0xFFFFFFFF)) & 0xFFFFFFFF;
        return $x;
    }

    /** Minutes past WINDOW_START_HOUR of the trigger for 'YYYY-MM-DD'. */
    public static function triggerOffsetMinutes(string $dateStr): int
    {
        $x = self::xorshift32(self::djb2($dateStr));
        $x = self::xorshift32($x);
        $x = self::xorshift32($x);
        $rand = $x / 4294967296; // uniform [0, 1)
        return (int) floor($rand * self::WINDOW_MINUTES);
    }

    /** 'YYYY-MM-DD' for the instant (epoch seconds) as seen in IANA zone $tz. */
    public static function dateStringInZone(int $epochSec, string $tz): string
    {
        $d = (new DateTimeImmutable('@' . $epochSec))->setTimezone(new DateTimeZone($tz));
        return $d->format('Y-m-d');
    }

    /** Wall-clock time in $tz at instant $epochSec, re-encoded as a UTC epoch. */
    private static function wallSecInZone(int $epochSec, string $tz): int
    {
        $d = (new DateTimeImmutable('@' . $epochSec))->setTimezone(new DateTimeZone($tz));
        return gmmktime(
            (int) $d->format('G'), (int) $d->format('i'), (int) $d->format('s'),
            (int) $d->format('n'), (int) $d->format('j'), (int) $d->format('Y')
        );
    }

    /**
     * Epoch seconds of wall-clock $dateStr $hour:$minute in IANA zone $tz.
     * Fixed-point iteration, same two rounds as the JS original.
     */
    public static function zonedEpochSec(string $dateStr, int $hour, int $minute, string $tz): int
    {
        [$y, $mo, $d] = array_map('intval', explode('-', $dateStr));
        $desired = gmmktime($hour, $minute, 0, $mo, $d, $y);
        $epoch = $desired;
        for ($i = 0; $i < 2; $i++) {
            $epoch = $desired - (self::wallSecInZone($epoch, $tz) - $epoch);
        }
        return $epoch;
    }

    /** Today's (in $tz) trigger time as epoch seconds. */
    public static function triggerEpochInZone(int $nowSec, string $tz): int
    {
        $dateStr = self::dateStringInZone($nowSec, $tz);
        $off = self::triggerOffsetMinutes($dateStr);
        return self::zonedEpochSec($dateStr, self::WINDOW_START_HOUR + intdiv($off, 60), $off % 60, $tz);
    }
}
