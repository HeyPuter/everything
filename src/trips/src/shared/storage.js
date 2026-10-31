/** FS name for a stored file; display names live in the entity. */
export function storageName(name) {
  const clean = name.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').replace(/^\.+/, '_').slice(-120);
  return clean || 'file';
}

/** Where a file entity's bytes live inside the space's `files/` folder: `<id>/<name>` (direct) or `<id>/data`. */
export const storedPath = (entity) => `${entity.id}/${entity.loc?.mode === 'direct' ? storageName(entity.name) : 'data'}`;
