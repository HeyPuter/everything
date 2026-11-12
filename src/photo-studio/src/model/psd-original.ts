import type { PhotoDocument } from "./document";
import { validatePsdHeader } from "./psd-header";

export const psdOriginalMimeType = "application/x-photo-editor-original-psd";
const memoryLimit = 512 * 1024 * 1024;

export class PsdPreviewEditError extends Error {
  constructor() {
    super(
      "This preview has been edited, but its original PSD layers cannot yet be updated. Save a .photo project or export PNG to keep these edits. File → Download original PSD retrieves the original without preview edits.",
    );
  }
}

// Original files are immutable blobs, outside document/history JSON and image
// decoding. Bound the top-level sections without interpreting unsupported data.
export async function validateOriginalPsd(blob: Blob): Promise<"psd" | "psb"> {
  if (blob.type !== psdOriginalMimeType || blob.size > memoryLimit)
    throw new Error("Invalid original PSD asset.");
  const header = new Uint8Array(await blob.slice(0, 26).arrayBuffer());
  validatePsdHeader(header);
  const psb = new DataView(header.buffer).getUint16(4) === 2;
  let offset = 26;
  for (const width of [4, 4, psb ? 8 : 4]) {
    const bytes = await blob.slice(offset, offset + width).arrayBuffer();
    if (bytes.byteLength !== width)
      throw new Error("Truncated original PSD section.");
    const view = new DataView(bytes);
    const length =
      width === 8 ? view.getBigUint64(0) : BigInt(view.getUint32(0));
    offset += width;
    if (length > BigInt(blob.size - offset))
      throw new Error("Truncated original PSD section.");
    offset += Number(length);
  }
  const compression = await blob.slice(offset, offset + 2).arrayBuffer();
  if (
    compression.byteLength !== 2 ||
    new DataView(compression).getUint16(0) > 3
  )
    throw new Error("Invalid original PSD composite stream.");
  return psb ? "psb" : "psd";
}

// A versioned, order-independent snapshot binds the immutable original asset
// and detects edits to preview layers and document metadata. Download filenames
// and selections do not change file content. Undo restores the snapshot naturally.
export async function psdPreviewFingerprint(doc: PhotoDocument) {
  const {
    psdOriginal: _original,
    name: _name,
    selection: _selection,
    selectionMask: _selectionMask,
    quickMask: _quickMask,
    id: _id,
    ...content
  } = doc;
  const json = JSON.stringify(
    { version: 1, originalAsset: doc.psdOriginal?.asset, content },
    (_key, value) => {
      if (value && typeof value === "object" && !Array.isArray(value))
        return Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        );
      return value;
    },
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(json),
  );
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}

export async function readOriginalPsd(
  doc: PhotoDocument,
  readAsset?: (id: string) => Blob | Promise<Blob>,
) {
  if (!doc.psdOriginal || !readAsset)
    throw new Error("The original PSD asset is required.");
  const blob = await readAsset(doc.psdOriginal.asset);
  const extension = await validateOriginalPsd(blob);
  return {
    blob: blob.slice(0, blob.size, "image/vnd.adobe.photoshop"),
    extension,
  };
}

export async function saveOriginalPsd(
  doc: PhotoDocument,
  readAsset?: (id: string) => Blob | Promise<Blob>,
) {
  if (!doc.psdOriginal) throw new Error("The original PSD asset is required.");
  if ((await psdPreviewFingerprint(doc)) !== doc.psdOriginal.previewFingerprint)
    throw new PsdPreviewEditError();
  return readOriginalPsd(doc, readAsset);
}
