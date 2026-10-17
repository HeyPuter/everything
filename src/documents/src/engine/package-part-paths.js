import { deflateSync, zipSync } from 'fflate';

// OPC relationship targets are relative to the owning part, not the package's
// main document. Keep names encoded as stored in the ZIP; do not URL-decode them.
function segments(path) {
  if (typeof path !== 'string' || !path || /[\\?#\u0000]/.test(path)) throw new Error('Invalid package part path.');
  const result = path.split('/');
  if (result.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('Invalid package part path.');
  return result;
}

export function relationshipPartPath(sourcePart) {
  const path = segments(sourcePart), file = path.pop();
  return [...path, '_rels', file + '.rels'].join('/');
}

export function relativePartTarget(sourcePart, targetPart) {
  const from = segments(sourcePart), to = segments(targetPart);
  from.pop();
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  return [...from.map(() => '..'), ...to].join('/');
}

/** The largest DOCX file the editor opens. */
export const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;

// Pictures in these formats are usually compressed already. Deflating them
// again on every save costs seconds of main-thread time in picture-heavy
// documents and saves a few bytes, so a picture whose samples do not deflate is
// stored; everything else is deflated.
const PICTURE_PARTS = /\.(?:jpe?g|jfif|png|gif|webp|wdp)$/i;
const SAMPLE = 1 << 15;
const incompressible = bytes => bytes.length > 4 * SAMPLE
  && [0, (bytes.length - SAMPLE) >> 1, bytes.length - SAMPLE].every(at => deflateSync(bytes.subarray(at, at + SAMPLE), { level: 1 }).length > SAMPLE * 0.9);

/** The package as ZIP bytes. A result past the open limit is deflated throughout, so it stays as small as possible. */
export function zipPackage(parts) {
  const stored = zipSync(Object.fromEntries(Object.entries(parts).map(([name, bytes]) => [name, PICTURE_PARTS.test(name) && incompressible(bytes) ? [bytes, { level: 0 }] : bytes])));
  return stored.length > MAX_PACKAGE_BYTES ? zipSync(parts) : stored;
}
