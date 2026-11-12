// Image resources use 32-bit section/payload lengths in both PSD and PSB.
// Layout: the published PSD file format specification.
type Resource = {
  id: number;
  start: number;
  end: number;
  dataStart: number;
  dataEnd: number;
};
const memoryLimit = 512 * 1024 * 1024;
const maxRecords = 65536;
const signatures = new Set(["8BIM", "MeSa", "AgHg", "PHUT", "DCSR"]);
export const psdResourcesMimeType = "application/x-photo-editor-psd-resources";
const magic = new TextEncoder().encode("PSIR0001");

function records(bytes: Uint8Array, start: number, end: number) {
  if (end > bytes.length || end - start > memoryLimit)
    throw new Error("Truncated or oversized PSD image resources.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: Resource[] = [];
  let offset = start;
  while (offset < end) {
    if (result.length === maxRecords)
      throw new Error("PSD image resources exceed the record index budget.");
    if (offset + 7 > end) throw new Error("Truncated PSD image resource.");
    if (
      !signatures.has(
        String.fromCharCode(...bytes.subarray(offset, offset + 4)),
      )
    )
      throw new Error("Invalid PSD image resource signature.");
    const id = view.getUint16(offset + 4);
    const nameSize = bytes[offset + 6] + 1;
    const sizeOffset = offset + 6 + nameSize + (nameSize % 2);
    if (sizeOffset + 4 > end)
      throw new Error("Truncated PSD image resource name.");
    const dataStart = sizeOffset + 4,
      size = view.getUint32(sizeOffset),
      dataEnd = dataStart + size,
      recordEnd = dataEnd + (size % 2);
    if (recordEnd > end) throw new Error("Truncated PSD image resource data.");
    result.push({ id, start: offset, end: recordEnd, dataStart, dataEnd });
    offset = recordEnd;
  }
  return result;
}

function resources(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const uint32 = (offset: number) => {
    if (offset < 0 || offset + 4 > bytes.length)
      throw new Error("Truncated PSD image resources.");
    return view.getUint32(offset);
  };
  const section = 26 + 4 + uint32(26);
  const start = section + 4,
    end = start + uint32(section);
  if (end > bytes.length) throw new Error("Truncated PSD image resources.");
  return { section, start, end, records: records(bytes, start, end) };
}

/** Original records, including names, private signatures and padding. */
export function readPsdImageResources(bytes: Uint8Array) {
  const { start, end } = resources(bytes);
  return bytes.subarray(start, end);
}
export function encodePsdImageResources(data: Uint8Array): ArrayBuffer {
  records(data, 0, data.length);
  if (data.length + magic.length > memoryLimit)
    throw new Error("PSD image resources exceed the 512 MB budget.");
  const out = new Uint8Array(magic.length + data.length);
  out.set(magic);
  out.set(data, magic.length);
  return out.buffer;
}
export function decodePsdImageResources(bytes: Uint8Array) {
  if (
    bytes.length < magic.length ||
    bytes.length > memoryLimit ||
    !magic.every((v, i) => bytes[i] === v)
  )
    throw new Error("Invalid native PSD image resources.");
  const data = bytes.subarray(magic.length);
  records(data, 0, data.length);
  return data;
}

// These IDs are defined by the format's image resource table, not by any test document.
// Resolution/profile/untagged state belong to the editable document, even when
// removed. Index-based layer state/link tables need regeneration after tree
// edits; cached thumbnails and writer information must not describe old pixels.
// Retain all of them in the native asset, but do not replay them into a new PSD.
// Layer-link/selection interoperability is a separate, still pending feature.
// Alpha channel names and display (1006, 1007, 1045, 1077) describe the
// channels written with the document's own channels.
const regeneratedResources = new Set([
  1000, 1003, 1005, 1006, 1007, 1024, 1026, 1033, 1036, 1039, 1041, 1045, 1057, 1069, 1072, 1077,
]);
export function restorePsdImageResources(
  bytes: Uint8Array,
  original: Uint8Array,
): ArrayBuffer {
  const current = resources(bytes);
  const owned = new Set([
    ...regeneratedResources,
    ...current.records.map((r) => r.id),
  ]);
  const retained = records(original, 0, original.length).filter(
    (r) => !owned.has(r.id),
  );
  const resourceSize =
    current.end -
    current.start +
    retained.reduce((n, r) => n + r.end - r.start, 0);
  const size = bytes.length + resourceSize - (current.end - current.start);
  if (size > memoryLimit)
    throw new Error("PSD image resources exceed the 512 MB export budget.");
  if (current.records.length + retained.length > maxRecords)
    throw new Error("PSD image resources exceed the record index budget.");
  const out = new Uint8Array(size);
  out.set(bytes.subarray(0, current.end));
  new DataView(out.buffer).setUint32(current.section, resourceSize);
  let at = current.end;
  for (const r of retained) {
    out.set(original.subarray(r.start, r.end), at);
    at += r.end - r.start;
  }
  out.set(bytes.subarray(current.end), at);
  return out.buffer;
}

// ag-psd does not expose all image resources (including the embedded ICC profile).
// Return a view; opaque payload bytes must not be interpreted or rewritten.
export function readPsdImageResource(
  bytes: Uint8Array,
  id: number,
): Uint8Array | undefined {
  const record = resources(bytes)
    .records.filter((r) => r.id === id)
    .pop();
  return record ? bytes.subarray(record.dataStart, record.dataEnd) : undefined;
}

export function replacePsdImageResource(
  bytes: Uint8Array,
  id: number,
  data: Uint8Array,
): ArrayBuffer {
  const { section, start, end, records } = resources(bytes);
  const keep = records.filter((r) => r.id !== id);
  // Signature, ID, an empty even-padded Pascal name, payload size, then payload.
  const recordSize = 12 + data.length + (data.length % 2);
  const resourceSize = keep.reduce((n, r) => n + r.end - r.start, recordSize);
  if (resourceSize > 0xffffffff)
    throw new Error("PSD image resources exceed their 32-bit length.");
  if (bytes.length - (end - start) + resourceSize > memoryLimit)
    throw new Error("PSD image resources exceed the 512 MB export budget.");
  const result = new Uint8Array(bytes.length - (end - start) + resourceSize);
  result.set(bytes.subarray(0, start));
  const view = new DataView(result.buffer);
  view.setUint32(section, resourceSize);
  let offset = start;
  for (const record of keep) {
    result.set(bytes.subarray(record.start, record.end), offset);
    offset += record.end - record.start;
  }
  result.set(new TextEncoder().encode("8BIM"), offset);
  view.setUint16(offset + 4, id);
  view.setUint32(offset + 8, data.length);
  result.set(data, offset + 12);
  result.set(bytes.subarray(end), start + resourceSize);
  return result.buffer;
}

// A bounded immutable string works with structuredClone, history, and JSON
// projects without expanding profile bytes into number arrays in every snapshot.
export const maxIccProfileBytes = 8 * 1024 * 1024;
export function encodeIccProfile(bytes: Uint8Array) {
  if (bytes.length > maxIccProfileBytes)
    throw new Error("ICC profile exceeds 8 MB.");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 4096)
    binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(binary);
}
export function decodeIccProfile(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
