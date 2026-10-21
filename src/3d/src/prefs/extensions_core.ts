// Extension packages (pure): a .zip with an `extension.json` manifest at its root (or inside a
// single top-level folder) and the files it names. Two kinds exist:
//   add-on: `entry` names a Python (.py) or JavaScript (.js) file with register() / unregister()
//   theme:  `entry` names a theme JSON file (the format Preferences ▸ Themes exports)
//
// extension.json:
//   {
//     "schema": 1,                       required, this format's version
//     "id": "mesh_tools",                required, lowercase letters, digits and underscores
//     "name": "Mesh Tools",              required
//     "version": "1.2.0",                required, numbers separated by dots
//     "type": "add-on" | "theme",        required
//     "entry": "mesh_tools.py",          required, a file in the package
//     "tagline": "One line about it",    optional
//     "maintainer": "Name <mail>",       optional
//     "website": "https://…",            optional
//     "tags": ["Modeling", "Mesh"],      optional
//     "min_app_version": "0.1.0"         optional, refused on older versions of the app
//   }

export type ExtensionType = 'add-on' | 'theme';

export interface ExtensionManifest {
  schema: number;
  id: string;
  name: string;
  version: string;
  type: ExtensionType;
  entry: string;
  tagline: string;
  maintainer: string;
  website: string;
  tags: string[];
  min_app_version?: string;
}

export const MANIFEST_NAME = 'extension.json';
export const SCHEMA = 1;

/** Compare dotted version numbers: -1, 0 or 1 (missing parts count as 0, text parts compare as text). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/),
    pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0',
      y = pb[i] ?? '0';
    const nx = Number(x),
      ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Validate a parsed manifest; returns it normalized, or the problem in words. */
export function parseManifest(raw: unknown, appVersion = '0.0.0'): { ok: true; manifest: ExtensionManifest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'The manifest is not a JSON object' };
  const r = raw as Record<string, unknown>;
  if (r.schema !== SCHEMA) return { ok: false, error: `Unsupported manifest schema ${JSON.stringify(r.schema)} (expected ${SCHEMA})` };
  const id = str(r.id);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(id)) return { ok: false, error: 'The id must start with a letter and use only lowercase letters, digits and underscores' };
  const name = str(r.name);
  if (!name) return { ok: false, error: 'The name is missing' };
  const version = str(r.version);
  if (!/^\d+(\.\d+){0,3}([-+][\w.]+)?$/.test(version)) return { ok: false, error: `"${version}" is not a version number such as 1.0.0` };
  const type = str(r.type);
  if (type !== 'add-on' && type !== 'theme') return { ok: false, error: `Unknown type "${type}" (use "add-on" or "theme")` };
  const entry = str(r.entry).replace(/^\.?\//, '');
  if (!entry || entry.includes('..')) return { ok: false, error: 'The entry file is missing' };
  if (type === 'add-on' && !/\.(py|js|mjs)$/i.test(entry)) return { ok: false, error: 'An add-on entry must be a .py or .js file' };
  if (type === 'theme' && !/\.json$/i.test(entry)) return { ok: false, error: 'A theme entry must be a .json file' };
  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim()).slice(0, 16) : [];
  const min = str(r.min_app_version);
  if (min && compareVersions(appVersion, min) < 0) return { ok: false, error: `Needs version ${min} of the application (this is ${appVersion})` };
  return {
    ok: true,
    manifest: { schema: SCHEMA, id, name, version, type, entry, tagline: str(r.tagline), maintainer: str(r.maintainer), website: str(r.website), tags, ...(min ? { min_app_version: min } : {}) },
  };
}

/**
 * Find the manifest among the files of a package (at the root, or in one top-level folder) and
 * return the package's files relative to the manifest's folder.
 */
export function packageFiles(files: Record<string, Uint8Array>): { root: string; files: Record<string, Uint8Array> } | null {
  const names = Object.keys(files).filter((n) => !n.endsWith('/') && !n.startsWith('__MACOSX/'));
  const manifest = names.filter((n) => n === MANIFEST_NAME || /^[^/]+\/extension\.json$/.test(n)).sort((a, b) => a.length - b.length)[0];
  if (!manifest) return null;
  const root = manifest.slice(0, manifest.length - MANIFEST_NAME.length);
  const out: Record<string, Uint8Array> = {};
  for (const n of names) if (n.startsWith(root)) out[n.slice(root.length)] = files[n];
  return { root, files: out };
}

export interface ExtensionRecord {
  manifest: ExtensionManifest;
  /** file contents by path (entry and anything else it ships) */
  files: Record<string, Uint8Array>;
  installed: number;
  /** marked for a batch install / uninstall */
  marked?: boolean;
}

/** Search and filter installed extensions (name, tagline, tags, id; type and tag filters). */
export function filterExtensions<T extends { manifest: ExtensionManifest }>(list: T[], o: { text?: string; type?: ExtensionType | 'ALL'; tags?: string[] }): T[] {
  const q = (o.text ?? '').trim().toLowerCase();
  return list
    .filter((e) => !o.type || o.type === 'ALL' || e.manifest.type === o.type)
    .filter((e) => !o.tags?.length || e.manifest.tags.some((t) => o.tags!.includes(t)))
    .filter((e) => !q || `${e.manifest.name} ${e.manifest.tagline} ${e.manifest.id} ${e.manifest.tags.join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/** All tags used by a set of extensions (sorted). */
export function allTags(list: { manifest: ExtensionManifest }[]): string[] {
  return [...new Set(list.flatMap((e) => e.manifest.tags))].sort((a, b) => a.localeCompare(b));
}
