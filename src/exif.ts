// Minimal EXIF writer. Canvas re-encoding strips all metadata, so the locally
// saved copy gets a hand-built APP1 segment (little-endian TIFF) with capture
// time and optional GPS coordinates. Canvas JPEGs carry no existing EXIF, so
// the segment is simply spliced in right after the SOI marker — no merging.

const BYTE = 1;
const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;

interface Entry {
  tag: number;
  type: number;
  count: number;
  value: Uint8Array;
}

function ascii(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length + 1); // NUL-terminated
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

function shortVal(v: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
}

function longVal(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
}

function rationals(pairs: Array<[number, number]>): Uint8Array {
  const b = new Uint8Array(pairs.length * 8);
  const dv = new DataView(b.buffer);
  pairs.forEach(([num, den], i) => {
    dv.setUint32(i * 8, num, true);
    dv.setUint32(i * 8 + 4, den, true);
  });
  return b;
}

function asciiEntry(tag: number, s: string): Entry {
  const value = ascii(s);
  return { tag, type: ASCII, count: value.length, value };
}

// 2-byte count + 12 bytes per entry + 4-byte next-IFD offset, plus the
// out-of-line data area (values > 4 bytes, padded to word alignment).
function ifdSize(entries: Entry[]): number {
  let size = 2 + entries.length * 12 + 4;
  for (const e of entries) {
    if (e.value.length > 4) size += e.value.length + (e.value.length % 2);
  }
  return size;
}

// Entries must be sorted by tag. `offset` is relative to the TIFF header
// start, which is index 0 of `bytes`, so value offsets equal array indices.
function writeIfd(bytes: Uint8Array, offset: number, entries: Entry[]): void {
  const dv = new DataView(bytes.buffer);
  dv.setUint16(offset, entries.length, true);
  let dataOffset = offset + 2 + entries.length * 12 + 4;
  entries.forEach((e, i) => {
    const p = offset + 2 + i * 12;
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, e.count, true);
    if (e.value.length <= 4) {
      bytes.set(e.value, p + 8);
    } else {
      dv.setUint32(p + 8, dataOffset, true);
      bytes.set(e.value, dataOffset);
      dataOffset += e.value.length + (e.value.length % 2);
    }
  });
  dv.setUint32(offset + 2 + entries.length * 12, 0, true);
}

function exifDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function tzOffsetString(d: Date): string {
  const min = -d.getTimezoneOffset();
  const abs = Math.abs(min);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${min < 0 ? '-' : '+'}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

function dms(abs: number): Array<[number, number]> {
  let deg = Math.floor(abs);
  let min = Math.floor((abs - deg) * 60);
  let secMilli = Math.round(((abs - deg) * 60 - min) * 60 * 1000);
  if (secMilli >= 60_000) { secMilli -= 60_000; min += 1; }
  if (min >= 60) { min -= 60; deg += 1; }
  return [[deg, 1], [min, 1], [secMilli, 1000]];
}

export async function insertExif(
  jpeg: Blob,
  opts: { date: Date; lat?: number; lon?: number },
): Promise<Blob> {
  const src = new Uint8Array(await jpeg.arrayBuffer());
  if (src[0] !== 0xff || src[1] !== 0xd8) return jpeg;

  const dateStr = exifDate(opts.date);
  const offsetStr = tzOffsetString(opts.date);

  const exifEntries: Entry[] = [
    asciiEntry(0x9003, dateStr),   // DateTimeOriginal
    asciiEntry(0x9004, dateStr),   // DateTimeDigitized
    asciiEntry(0x9011, offsetStr), // OffsetTimeOriginal
    asciiEntry(0x9012, offsetStr), // OffsetTimeDigitized
  ];

  const hasGps = typeof opts.lat === 'number' && typeof opts.lon === 'number';
  const gpsEntries: Entry[] = hasGps
    ? [
        { tag: 0x0000, type: BYTE, count: 4, value: new Uint8Array([2, 3, 0, 0]) },
        asciiEntry(0x0001, opts.lat! < 0 ? 'S' : 'N'),
        { tag: 0x0002, type: RATIONAL, count: 3, value: rationals(dms(Math.abs(opts.lat!))) },
        asciiEntry(0x0003, opts.lon! < 0 ? 'W' : 'E'),
        { tag: 0x0004, type: RATIONAL, count: 3, value: rationals(dms(Math.abs(opts.lon!))) },
      ]
    : [];

  const ifd0Offset = 8;
  const ifd0Entries: Entry[] = [
    { tag: 0x0112, type: SHORT, count: 1, value: shortVal(1) }, // Orientation
    asciiEntry(0x0132, dateStr),                                // DateTime
    { tag: 0x8769, type: LONG, count: 1, value: longVal(0) },   // Exif IFD pointer, patched below
  ];
  if (hasGps) ifd0Entries.push({ tag: 0x8825, type: LONG, count: 1, value: longVal(0) });

  const exifOffset = ifd0Offset + ifdSize(ifd0Entries);
  const gpsOffset = exifOffset + ifdSize(exifEntries);
  ifd0Entries[2].value = longVal(exifOffset);
  if (hasGps) ifd0Entries[3].value = longVal(gpsOffset);

  const tiffSize = hasGps ? gpsOffset + ifdSize(gpsEntries) : gpsOffset;
  const tiff = new Uint8Array(tiffSize);
  const tiffDv = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49]); // "II" little-endian
  tiffDv.setUint16(2, 42, true);
  tiffDv.setUint32(4, ifd0Offset, true);
  writeIfd(tiff, ifd0Offset, ifd0Entries);
  writeIfd(tiff, exifOffset, exifEntries);
  if (hasGps) writeIfd(tiff, gpsOffset, gpsEntries);

  // APP1 marker + big-endian segment length + "Exif\0\0" + TIFF body.
  const app1 = new Uint8Array(4 + 6 + tiffSize);
  app1.set([0xff, 0xe1]);
  new DataView(app1.buffer).setUint16(2, 2 + 6 + tiffSize, false);
  app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); // "Exif\0\0"
  app1.set(tiff, 10);

  const out = new Uint8Array(2 + app1.length + src.length - 2);
  out.set([0xff, 0xd8]);
  out.set(app1, 2);
  out.set(src.subarray(2), 2 + app1.length);
  return new Blob([out], { type: 'image/jpeg' });
}
