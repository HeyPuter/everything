/**
 * The user's own ICC profiles (.icc / .icm files they loaded), kept as
 * files named by the profile's id in the user's Puter cloud (app data
 * folder "profiles") when signed in, else in this browser's private
 * storage. They register with the color engine as they load, so they can
 * be working spaces, document profiles, proof devices and output profiles.
 *
 * Documents carry the profile they are assigned as an asset
 * ({ mime: ICC_MIME, data: data URL, name }), so they open with it on any
 * device; those register as 'embedded' profiles.
 */
import { puterBackend, opfsBackend, opfsAvailable, memoryBackend } from '../files/backends.js';
import { registerIccProfile, unregisterProfile, profileEntry, profileBytes, listProfiles, registryEvents } from './profiles.js';

export const ICC_MIME = 'application/vnd.iccprofile';

export class ProfileStore {
  constructor(app, backend = null) {
    this.app = app;
    this.fixed = backend;
    this.loaded = false;
    this.loading = null;
  }

  get backend() {
    if (this.fixed) return this.fixed;
    const puter = this.app.puter;
    const cloud = Boolean(puter?.fs && (this.app.env === 'app' || this.app.user));
    const key = cloud ? 'cloud' : opfsAvailable() ? 'local' : 'memory';
    if (key !== this.backendKey) {
      this.backendKey = key;
      this.cachedBackend = key === 'cloud' ? puterBackend(puter, 'profiles') : key === 'local' ? opfsBackend('vector-studio-profiles') : memoryBackend();
      this.loaded = false;
    }
    return this.cachedBackend;
  }

  /** Where profiles are kept: 'cloud' | 'local' | 'memory'. */
  get location() {
    void this.backend;
    return this.fixed ? 'memory' : this.backendKey;
  }

  /** Read every stored profile into the engine. Damaged files are skipped. */
  async load(force = false) {
    const backend = this.backend;
    if (this.loaded && !force) return this.list();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const files = (await backend.list('')).filter((f) => !f.isDir && /\.ic[cm]$/i.test(f.name));
        for (const f of files) {
          try {
            const blob = await backend.readBlob(f.name);
            if (blob) registerIccProfile(new Uint8Array(await blob.arrayBuffer()), { source: 'user' });
          } catch {
            // Skip a file that is not a usable profile.
          }
        }
      } catch {
        // Storage unavailable: built-in profiles still work.
      }
      this.loaded = true;
      this.loading = null;
      registryEvents.emit('loaded', {});
      return this.list();
    })();
    return this.loading;
  }

  /** The user's profiles (entries). */
  list() {
    return listProfiles().filter((e) => e.source === 'user');
  }

  /** Add profile data (Uint8Array, ArrayBuffer or Blob/File). Returns the entry; throws for data that is not a profile. */
  async add(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data instanceof ArrayBuffer ? data : await data.arrayBuffer());
    const entry = registerIccProfile(bytes, { source: 'user' });
    await this.backend.writeBlob(`${entry.id.slice(4)}.icc`, new Blob([bytes], { type: ICC_MIME }));
    return entry;
  }

  /** Forget a user profile. Documents that carry it keep their copy. */
  async remove(id) {
    if (profileEntry(id)?.source !== 'user') return false;
    await this.backend.remove(`${id.slice(4)}.icc`);
    unregisterProfile(id);
    return true;
  }
}

// ---- profiles carried by documents ----

const assetId = (id) => `icc-${id.slice(4)}`;

function toDataUrl(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${ICC_MIME};base64,${btoa(bin)}`;
}

function fromDataUrl(url) {
  const i = String(url || '').indexOf(',');
  if (i < 0) return null;
  const bin = atob(url.slice(i + 1));
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

/** Register the profiles a document carries. Returns their ids. */
export function registerDocumentProfiles(doc) {
  const ids = [];
  for (const a of doc?.assets?.values?.() || []) {
    if (a?.mime !== ICC_MIME) continue;
    try {
      const bytes = fromDataUrl(a.data);
      if (bytes) ids.push(registerIccProfile(bytes, { source: 'embedded', name: a.name || null }).id);
    } catch {
      // A damaged copy: the document falls back to the working space.
    }
  }
  return ids;
}

/** Store an ICC profile's data in the document (built-in profiles need none). */
export function embedProfile(doc, id) {
  const e = profileEntry(id);
  if (!e || e.source === 'builtin' || !doc?.assets) return false;
  const key = assetId(id);
  if (!doc.assets.has(key)) doc.assets.set(key, { mime: ICC_MIME, data: toDataUrl(profileBytes(id)), name: e.name });
  return true;
}

/** ICC data of a document's profile asset, for tests and exports. */
export function documentProfileBytes(doc, id) {
  const a = doc?.assets?.get(assetId(id));
  return a ? fromDataUrl(a.data) : null;
}
