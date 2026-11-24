// File size limits and the file-name rule, kept apart from document.js so the library and the
// cloud helpers can use them without loading pdf-lib (about 600 KB) as the app starts.
export const MAX_FILE_SIZE = 100 * 1024 * 1024;
export const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
/** The most pixels a PNG may unpack to: an 8000 by 6000 photo, about 200 MB as it is placed. */
export const MAX_PNG_PIXELS = 50 * 1000 * 1000;
export const MAX_PAGES = 1000;
const nameEncoder = new TextEncoder();
export function safeName(value) {
  const clean = String(value || '')
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, ' ')
    .trim()
    .replace(/\.pdf$/i, '')
    .trim();
  let name = '',
    bytes = 0;
  // Leave room for export suffixes within filesystem limits, without cutting a code point.
  for (const char of clean) {
    const size = nameEncoder.encode(char).length;
    if (bytes + size > 180) break;
    name += char;
    bytes += size;
  }
  return `${name.trim() || 'Untitled'}.pdf`;
}
