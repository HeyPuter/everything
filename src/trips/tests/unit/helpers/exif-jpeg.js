// A minimal JPEG with an EXIF block holding a capture time and, optionally, a GPS position (degrees, minutes, seconds).
export function exifJpeg({ date = '2027:05:02 14:30:00', lat = [38, 42, 0], lng = [9, 8, 24], south = false, west = true, gps = true } = {}) {
  const encode = (text) => new TextEncoder().encode(text);
  const tiff = new Uint8Array(512);
  const view = new DataView(tiff.buffer);
  tiff.set([0x4d, 0x4d, 0x00, 0x2a]);
  view.setUint32(4, 8);
  const field = (at, tag, type, count, value) => { view.setUint16(at, tag); view.setUint16(at + 2, type); view.setUint32(at + 4, count); view.setUint32(at + 8, value); };
  view.setUint16(8, gps ? 2 : 1);
  field(10, 0x8769, 4, 1, 100);
  if (gps) field(22, 0x8825, 4, 1, 200);
  view.setUint16(100, 1);
  field(102, 0x9003, 2, 20, 300);
  tiff.set(encode(`${date}\0`), 300);
  if (gps) {
    view.setUint16(200, 4);
    field(202, 1, 2, 2, 0);
    tiff.set(encode(south ? 'S\0' : 'N\0'), 210);
    field(214, 2, 5, 3, 400);
    field(226, 3, 2, 2, 0);
    tiff.set(encode(west ? 'W\0' : 'E\0'), 234);
    field(238, 4, 5, 3, 424);
    [...lat, ...lng].forEach((value, index) => { view.setUint32(400 + index * 8, value); view.setUint32(404 + index * 8, 1); });
  }
  const payload = new Uint8Array([...encode('Exif\0\0'), ...tiff]);
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload, 0xff, 0xda, 0, 2]);
}
