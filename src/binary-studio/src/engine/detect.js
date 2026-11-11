import { parseElf } from './elf.js';
import { parsePe } from './pe.js';
import { viewOf } from './bytes.js';

export const MAX_FILE_BYTES = 64 * 1024 * 1024; // 64 MiB soft limit for v0

/**
 * Identify and parse a binary. Returns a normalized analysis document.
 */
export function openBinary(input, { maxBytes = MAX_FILE_BYTES } = {}) {
  const buf = viewOf(input);
  if (buf.length === 0) throw new Error('empty file');
  if (buf.length > maxBytes) {
    throw new Error(`file exceeds ${maxBytes} byte limit`);
  }

  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    const pe = parsePe(buf);
    return normalize(pe);
  }
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    const elf = parseElf(buf);
    return normalize(elf);
  }
  throw new Error('unsupported format (expected PE or ELF)');
}

function normalize(doc) {
  return {
    ...doc,
    analyzedAt: new Date().toISOString(),
    annotations: { symbols: {}, bookmarks: [], comments: {} },
  };
}
