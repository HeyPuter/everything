import { assertSize } from "./document";

const colorModes: Record<number, string> = { 0: "Bitmap", 1: "Grayscale", 2: "Indexed", 4: "CMYK", 7: "Multichannel", 8: "Duotone", 9: "Lab" };

// Check the header before asking a decoder to allocate image buffers.
export function validatePsdHeader(bytes: Uint8Array) {
  if (
    bytes.length < 26 ||
    String.fromCharCode(...bytes.subarray(0, 4)) !== "8BPS"
  )
    throw new Error("Invalid PSD file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (![1, 2].includes(view.getUint16(4)))
    throw new Error("Invalid PSD/PSB version.");
  assertSize(view.getUint32(18), view.getUint32(14));
  const mode = view.getUint16(24),
    depth = view.getUint16(22);
  if (mode !== 3)
    throw new Error(
      `This file is in ${colorModes[mode] ?? "an unknown"} color mode. Only RGB files open; convert it to RGB Color and save it again.`,
    );
  if (![8, 16, 32].includes(depth))
    throw new Error(
      `This file has ${depth} bits per channel. Only 8, 16 and 32-bit RGB files open; convert it and save it again.`,
    );
  if (![3, 4].includes(view.getUint16(12)))
    throw new Error(
      "This file has extra channels (saved selections or spot colors), which cannot be opened yet. Delete them in the Channels panel and save it again.",
    );
}
