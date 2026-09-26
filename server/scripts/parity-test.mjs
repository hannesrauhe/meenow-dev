// Same corpus as scripts/parity-test.php — run with Node and diff the outputs.
// Usage: node server/scripts/parity-test.mjs  (from the repo root)
import { triggerOffsetMinutes, dateStringInZone, triggerEpochInZone } from '../../src/trigger-core.mjs';

const dates = [];
for (const y of [2026]) {
  for (let m = 1; m <= 12; m++) {
    for (const d of [1, 7, 15, 20, 28]) {
      dates.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }
}
dates.push('2027-01-01', '2025-12-31');

for (const d of dates) {
  console.log(`offset ${d} ${triggerOffsetMinutes(d)}`);
}

const zones = ['Europe/Berlin', 'America/New_York', 'Asia/Tokyo', 'Australia/Lord_Howe',
               'America/Santiago', 'Pacific/Chatham', 'Asia/Kathmandu', 'UTC'];
const instants = [1774300000, 1761300000, 1773600000, 1783900000, 1751000000];
for (const ts of instants) {
  for (const tz of zones) {
    console.log(`date ${ts} ${tz} ${dateStringInZone(ts * 1000, tz)}`);
    console.log(`trig ${ts} ${tz} ${Math.floor(triggerEpochInZone(ts * 1000, tz) / 1000)}`);
  }
}
