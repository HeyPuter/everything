// The pixel size of a PNG, JPEG, GIF, BMP or WebP from its header, without
// decoding it: what cropping to an aspect ratio, Fill and Fit work from.
export function imageSize(bytes) {
  if (!bytes || bytes.length < 26) return null;
  const u32 = (o) =>
    ((bytes[o] << 24) |
      (bytes[o + 1] << 16) |
      (bytes[o + 2] << 8) |
      bytes[o + 3]) >>>
    0;
  const le16 = (o) => bytes[o] | (bytes[o + 1] << 8);
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return { w: u32(16), h: u32(20) };
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return { w: le16(6), h: le16(8) };
  if (bytes[0] === 0x42 && bytes[1] === 0x4d)
    return {
      w: le16(18) | (le16(20) << 16),
      h: Math.abs((le16(22) | (le16(24) << 16)) << 0),
    };
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45
  ) {
    const kind = String.fromCharCode(
      bytes[12],
      bytes[13],
      bytes[14],
      bytes[15],
    );
    if (kind === "VP8X")
      return {
        w: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        h: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    if (kind === "VP8 ") return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (kind === "VP8L") {
      const b = bytes.subarray(21, 25);
      return {
        w: 1 + (((b[1] & 0x3f) << 8) | b[0]),
        h: 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)),
      };
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) return null;
      const marker = bytes[o + 1];
      const length = (bytes[o + 2] << 8) | bytes[o + 3];
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      )
        return {
          h: (bytes[o + 5] << 8) | bytes[o + 6],
          w: (bytes[o + 7] << 8) | bytes[o + 8],
        };
      o += 2 + length;
    }
  }
  return null;
}
