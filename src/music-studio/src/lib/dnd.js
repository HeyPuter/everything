// Drag and drop between panels (browser to rack, playlist, mixer; patterns to
// the playlist). Payloads travel as JSON under one MIME type:
//
//   { kind: 'preset', type: 'synth' | 'drum', name, params }
//   { kind: 'instrument', type: 'synth' | 'drum' | 'sampler' }
//   { kind: 'effect', type }                       (effects/catalog.js)
//   { kind: 'pattern', id }
//   { kind: 'channel', id }                        (rack channel, e.g. onto a mixer insert)
//   { kind: 'automation', id }                     (automation clip source, playlist picker)
//   { kind: 'file', path, name, size }             (a Puter file)
//   { kind: 'sample', id, name }                   (a sample already in the project)
//
// Files dragged in from the operating system arrive as e.dataTransfer.files.
// Touch devices have no HTML drag and drop, so every drop target also has a
// menu or button route.

export const DND_TYPE = 'application/x-music-studio';

export function setDragData(e, payload, label) {
  e.dataTransfer.setData(DND_TYPE, JSON.stringify(payload));
  e.dataTransfer.setData('text/plain', label || payload.name || payload.type || payload.kind);
  e.dataTransfer.effectAllowed = 'copy';
}

/** The payload of a drop, or null. */
export function getDragData(e) {
  try {
    const s = e.dataTransfer?.getData(DND_TYPE);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** Whether a dragover carries our payload or OS files (data is unreadable until drop). */
export function dragHasPayload(e) {
  const types = e.dataTransfer?.types || [];
  return types.includes(DND_TYPE) || types.includes('Files');
}
