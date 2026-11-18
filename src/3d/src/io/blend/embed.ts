// This app's project inside the .blend files it saves: one block with a code no ID uses, which
// other programs skip when they read the file and leave out when they save it again. A file that
// still has it was last saved here and reopens with nothing lost; one without it was saved by
// another program since and is read through the .blend converter.
import { parseHeader, readBHeads } from './container';

/** Block code (four non-NUL characters: never an ID code). */
export const EMBED_CODE = 'P3DF';

/** The block payload: the project's length (u32, little endian), then the project. */
export function embedPayload(project: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + project.length);
  new DataView(out.buffer).setUint32(0, project.length, true);
  out.set(project, 4);
  return out;
}

/** The project a .blend file saved by this app carries; null for any other file. */
export function embeddedProject(bytes: Uint8Array): Uint8Array | null {
  // uncompressed .blend files only: this app writes them uncompressed, and other programs drop the block
  if (bytes.length < 12 || bytes[0] !== 0x42 || String.fromCharCode(...bytes.subarray(0, 7)) !== 'BLENDER') return null;
  try {
    const header = parseHeader(bytes);
    for (const b of readBHeads(bytes, header)) {
      if (b.code !== EMBED_CODE || b.len < 4) continue;
      const n = new DataView(bytes.buffer, bytes.byteOffset + b.offset, 4).getUint32(0, true);
      if (n > b.len - 4) return null;
      return bytes.subarray(b.offset + 4, b.offset + 4 + n);
    }
  } catch {
    // not a readable .blend file
  }
  return null;
}
