// Identifiers of things in a document (layers, channels, embedded objects,
// audio tracks and clips, layer comps, slices, paths, frames, …). The editor
// makes them with crypto.randomUUID(); a few are fixed or prefixed ('audio-1',
// 'user-<uuid>', 'library-<hash>'). Panels put them into markup and use
// '|' to join them with other values, so a document from a file or another
// person is only accepted when every identifier has this shape.
export const ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/;
export const isDocumentId = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v);
