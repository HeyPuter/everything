// Stores track geometry as a trip file; kept apart from track-file.js so readers do not load the upload path.
import { newId } from '../../shared/ids.js';
import { absorb } from '../files/upload.js';
import { IoError } from './errors.js';
import { IO_LIMITS } from './limits.js';
import { TRACK_MIME, encodeTrack, trackFileName } from './track-file.js';

async function sha256(bytes) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Stores a track file in the trip and returns its id. Needs `files.upload` and a connection; the entity lands in the
 * replica at once.
 */
export async function uploadTrack(space, feature, { api, name = feature.properties?.name, signal } = {}) {
  if (!api) throw new IoError('session_unavailable');
  if (!space.can('files.upload')) throw new IoError('forbidden');
  const bytes = encodeTrack(feature);
  if (bytes.length > IO_LIMITS.trackBytes) throw new IoError('file_too_large');
  const blob = new Blob([bytes], { type: TRACK_MIME });
  const fileId = newId();
  await api.upload(space.ref, fileId, blob, { signal });
  const result = await api.call(space.ref, 'file.put', { fileId, name: trackFileName(name), mime: TRACK_MIME, sha256: await sha256(bytes), kind: 'track' });
  await absorb(space, result);
  return fileId;
}
