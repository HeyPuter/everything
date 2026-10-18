// Byte helpers shared by importers.
export const IMAGE_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  // Boards store these as a PNG copy, which the import makes.
  const start = String.fromCharCode(...bytes.subarray(0, 6));
  if (/^GIF8[79]a/.test(start)) return "image/gif";
  if (start.startsWith("BM")) return "image/bmp";
  return null;
}

export function base64(bytes) {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 32768)
    binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  return btoa(binary);
}

export const dataURL = (bytes, mime) => `data:${mime};base64,${base64(bytes)}`;

export function extension(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

export async function fileBytes(file) {
  if (file.arrayBuffer) return new Uint8Array(await file.arrayBuffer());
  return new Uint8Array(
    await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(Error("Could not read this file."));
      reader.readAsArrayBuffer(file);
    }),
  );
}

// Text decoding tolerates a UTF-8 byte order mark, reads UTF-16 files that
// start with their byte order mark (Notepad's and Excel's "Unicode"), and
// falls back to Windows-1252 for legacy CSV exports that are not UTF-8.
export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
    );
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
