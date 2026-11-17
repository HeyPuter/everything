/**
 * Storage backends share one small interface:
 *   readJSON(path) -> object | null      (null when missing)
 *   writeJSON(path, value)
 *   readBlob(path) -> Blob | null
 *   writeBlob(path, blob, { onProgress })
 *   remove(path)                         (missing is not an error)
 *   list(dir) -> [{ name, isDir, modified, size }]
 *
 * Projects and media are always files: in the user's Puter cloud when signed
 * in, otherwise in this browser's private file system (OPFS). puter.kv is
 * never used for content.
 */

function isMissing(err) {
  const code = String(err?.code || err?.error?.code || '');
  const msg = String(err?.message || err?.error?.message || err || '');
  return code === 'subject_does_not_exist' || code === 'not_found' || code === 'dest_does_not_exist' || err?.status === 404 || err?.name === 'NotFoundError' || /does not exist|not found|no such/i.test(msg);
}

export function puterBackend(puter, root = 'video-studio') {
  const p = (path) => `${root}/${path}`;
  return {
    kind: 'puter',
    async readJSON(path) {
      try {
        const blob = await puter.fs.read(p(path));
        const text = await blob.text();
        return text ? JSON.parse(text) : null;
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },
    async writeJSON(path, value) {
      await puter.fs.write(p(path), JSON.stringify(value), { overwrite: true, createMissingParents: true });
    },
    async readBlob(path) {
      try {
        return await puter.fs.read(p(path));
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },
    async writeBlob(path, blob) {
      await puter.fs.write(p(path), blob, { overwrite: true, createMissingParents: true });
    },
    async remove(path) {
      try {
        await puter.fs.delete(p(path), { recursive: true });
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    },
    async list(dir) {
      try {
        const items = await puter.fs.readdir(p(dir));
        return items.map((it) => ({ name: it.name, isDir: Boolean(it.is_dir), modified: it.modified, size: it.size }));
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
    },
  };
}

/** Origin private file system backend (signed-out use and the local media cache). */
export function opfsBackend(root = 'video-studio') {
  const rootDir = async () => {
    const top = await navigator.storage.getDirectory();
    return top.getDirectoryHandle(root, { create: true });
  };
  const resolve = async (path, { create = false, dir = false } = {}) => {
    const parts = path.split('/').filter(Boolean);
    let d = await rootDir();
    const last = dir ? null : parts.pop();
    for (const part of parts) d = await d.getDirectoryHandle(part, { create });
    return dir ? d : { dir: d, name: last };
  };
  const backend = {
    kind: 'local',
    async readBlob(path) {
      try {
        const { dir, name } = await resolve(path);
        const fh = await dir.getFileHandle(name);
        return await fh.getFile();
      } catch (err) {
        if (isMissing(err) || err?.name === 'TypeMismatchError') return null;
        throw err;
      }
    },
    async writeBlob(path, blob) {
      const { dir, name } = await resolve(path, { create: true });
      const existed = await dir.getFileHandle(name).then(() => true, () => false);
      const fh = await dir.getFileHandle(name, { create: true });
      let w = null;
      try {
        w = await fh.createWritable();
        await w.write(blob);
        await w.close();
      } catch (err) {
        // A write that fails (the disk is full) must not leave the empty file made above: it
        // would later be listed, and read, as if the media had been stored.
        await w?.abort?.().catch(() => {});
        if (!existed) await dir.removeEntry(name).catch(() => {});
        throw err;
      }
    },
    async readJSON(path) {
      const blob = await backend.readBlob(path);
      if (!blob) return null;
      const text = await blob.text();
      return text ? JSON.parse(text) : null;
    },
    async writeJSON(path, value) {
      await backend.writeBlob(path, new Blob([JSON.stringify(value)], { type: 'application/json' }));
    },
    async remove(path) {
      try {
        const { dir, name } = await resolve(path);
        await dir.removeEntry(name, { recursive: true });
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    },
    async list(path) {
      try {
        const d = await resolve(path, { dir: true });
        const out = [];
        for await (const [name, h] of d.entries()) {
          if (h.kind === 'directory') out.push({ name, isDir: true, modified: 0, size: 0 });
          else {
            const f = await h.getFile();
            out.push({ name, isDir: false, modified: f.lastModified, size: f.size });
          }
        }
        return out;
      } catch (err) {
        if (isMissing(err)) return [];
        throw err;
      }
    },
  };
  return backend;
}

export function opfsAvailable() {
  return typeof navigator !== 'undefined' && Boolean(navigator.storage?.getDirectory);
}

/** In-memory backend for tests. */
export function memoryBackend(seed = {}) {
  const files = new Map(Object.entries(seed));
  const backend = {
    kind: 'memory',
    files,
    writes: 0,
    failNext: 0,
    async tick() {
      if (backend.failNext > 0) {
        backend.failNext--;
        throw new Error('Simulated network failure');
      }
    },
    async readJSON(path) {
      await backend.tick();
      return files.has(path) ? JSON.parse(files.get(path)) : null;
    },
    async writeJSON(path, value) {
      await backend.tick();
      backend.writes++;
      files.set(path, JSON.stringify(value));
    },
    async readBlob(path) {
      await backend.tick();
      return files.has(path) ? files.get(path) : null;
    },
    async writeBlob(path, blob) {
      await backend.tick();
      backend.writes++;
      files.set(path, blob);
    },
    async remove(path) {
      await backend.tick();
      for (const key of [...files.keys()]) if (key === path || key.startsWith(path + '/')) files.delete(key);
    },
    async list(dir) {
      await backend.tick();
      const prefix = dir.endsWith('/') ? dir : dir + '/';
      const names = new Map();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const [first, ...more] = key.slice(prefix.length).split('/');
        names.set(first, more.length > 0);
      }
      const sizeOf = (name) => {
        const v = files.get(prefix + name);
        return typeof v === 'string' ? v.length : v?.size || 0;
      };
      return [...names].map(([name, isDir]) => ({ name, isDir, modified: Date.now(), size: isDir ? 0 : sizeOf(name) }));
    },
  };
  return backend;
}
