// Reads the capture date and GPS position from the EXIF block of a JPEG's first bytes. Never throws.

const ascii = (bytes, at, text) => [...text].every((char, i) => bytes[at + i] === char.charCodeAt(0));

function tiffReader(bytes, start) {
  const little = ascii(bytes, start, 'II');
  if (!little && !ascii(bytes, start, 'MM')) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = bytes.length - start;
  const ok = (offset, length) => offset >= 0 && offset + length <= size;
  return {
    u16: (offset) => (ok(offset, 2) ? view.getUint16(start + offset, little) : null),
    u32: (offset) => (ok(offset, 4) ? view.getUint32(start + offset, little) : null),
    text(offset, length) { return ok(offset, length) ? String.fromCharCode(...bytes.subarray(start + offset, start + offset + length)).replace(/\0.*$/, '') : null; },
    rational(offset) {
      const top = ok(offset, 8) ? view.getUint32(start + offset, little) : null;
      const bottom = ok(offset, 8) ? view.getUint32(start + offset + 4, little) : null;
      return top === null || !bottom ? null : top / bottom;
    },
  };
}

/** `{tag: {type, count, value}}` for one directory, `value` being the inline value or the data offset. */
function directory(reader, offset) {
  const count = reader.u16(offset);
  const out = {};
  if (count === null || count > 500) return out;
  for (let n = 0; n < count; n++) {
    const at = offset + 2 + n * 12;
    const tag = reader.u16(at);
    const type = reader.u16(at + 2);
    const items = reader.u32(at + 4);
    if (tag === null || type === null || items === null) break;
    const inline = (type === 2 || type === 1 || type === 7) ? items <= 4 : type === 3 ? items <= 2 : type === 4 ? items <= 1 : false;
    out[tag] = { type, count: items, value: inline ? at + 8 : reader.u32(at + 8) };
  }
  return out;
}

const DATE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/;

function coordinate(reader, field, ref) {
  if (!field || field.type !== 5 || field.count < 3) return null;
  const [degrees, minutes, seconds] = [0, 8, 16].map((step) => reader.rational(field.value + step));
  if ([degrees, minutes, seconds].some((part) => part === null || !Number.isFinite(part))) return null;
  const value = degrees + minutes / 60 + seconds / 3600;
  return ref === 'S' || ref === 'W' ? -value : value;
}

/**
 * `{date: 'YYYY-MM-DD', time: 'HH:mm', lat, lng}` (each when present) from a JPEG's leading bytes, or null when
 * there is no readable EXIF block.
 */
export function readExif(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (marker === 0xe1 && ascii(bytes, at + 4, 'Exif\0\0')) return parse(bytes.subarray(at + 10, Math.min(bytes.length, at + 2 + length)));
    at += 2 + length;
  }
  return null;
}

function parse(tiff) {
  const reader = tiffReader(tiff, 0);
  if (!reader) return null;
  const ifd0 = directory(reader, reader.u32(4) ?? -1);
  const out = {};
  // Directory pointers are inline LONG values.
  const pointer = (field) => (field ? reader.u32(field.value) : null);
  const exifAt = pointer(ifd0[0x8769]);
  const sub = exifAt !== null ? directory(reader, exifAt) : {};
  const stamp = sub[0x9003] ?? ifd0[0x0132];
  const text = stamp ? reader.text(stamp.value, Math.min(stamp.count, 32)) : null;
  const match = text ? DATE.exec(text) : null;
  if (match) { out.date = `${match[1]}-${match[2]}-${match[3]}`; out.time = `${match[4]}:${match[5]}`; }
  const gpsAt = pointer(ifd0[0x8825]);
  if (gpsAt !== null) {
    const gps = directory(reader, gpsAt);
    const ref = (tag) => (gps[tag] ? reader.text(gps[tag].value, 1) : null);
    const lat = coordinate(reader, gps[2], ref(1));
    const lng = coordinate(reader, gps[4], ref(3));
    if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0)) Object.assign(out, { lat, lng });
  }
  return out;
}
