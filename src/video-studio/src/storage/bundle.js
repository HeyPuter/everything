/**
 * Project files: one portable file holding a project and the media it uses,
 * for backups and for moving work between accounts or browsers.
 *
 * The container is a plain ZIP (stored, see zip.js):
 *   manifest.json          { format: 'video-studio-bundle', version, exported, name, media: [...], missing: [...] }
 *   project.json           the project document
 *   media/<hash>.<ext>     each media file once
 *   fonts/<hash>.<ext>     uploaded fonts the project lists
 *   luts/<id>.cube         imported color LUTs its clips use (manifest.luts names them)
 *   cover.jpg              home screen thumbnail (optional)
 *
 * Importing creates a new project (new id, fresh dates) and stores the media
 * again under freshly computed content hashes, so a damaged or hand-edited
 * file cannot overwrite other projects' media (a font whose content does not
 * match its hash is left out; LUTs are stored under their own hash).
 */
import { uid, fingerprint } from '../lib/ids.js';
import { fontPath } from '../media/fonts.js';
import { normalizeProject } from '../model/project.js';
import { zipBlobs, readZip } from './zip.js';

export const BUNDLE_FORMAT = 'video-studio-bundle';
export const BUNDLE_VERSION = 1;
export const BUNDLE_SUFFIX = '.video-studio.zip';
export const BUNDLE_ACCEPT = '.zip,application/zip,application/x-zip-compressed';

const mediaName = (a) => `media/${a.hash}${a.ext ? `.${a.ext}` : ''}`;
const lutPath = (id) => `luts/${id}.cube`;

/** Every LUT reference ({ id, name, ... } under a lut key) in a project, wherever clips keep their grade. */
function lutRefs(value, out = []) {
  if (Array.isArray(value)) for (const v of value) lutRefs(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'lut' && v && typeof v === 'object' && typeof v.id === 'string') out.push(v);
      else lutRefs(v, out);
    }
  }
  return out;
}

function fileBase(name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean || 'Project';
}

/**
 * Pack a project (id or document) into a project file.
 * Returns { blob, fileName, missing: [names of media, fonts and LUTs that could not be read] }.
 */
export async function exportProjectBundle(library, project, { onProgress } = {}) {
  const p = typeof project === 'string' ? await library.openProject(project) : structuredClone(project);
  delete p.deletedAt;
  const assets = Object.values(p.assets);
  const entries = [];
  const media = [];
  const missing = [];
  const packed = new Set();
  let done = 0;
  for (const a of assets) {
    onProgress?.({ done, total: assets.length, name: a.name });
    done++;
    const path = mediaName(a);
    if (packed.has(path)) continue;
    let blob = null;
    try {
      // Packed and let go: exporting from Home must not hold every file in memory.
      blob = a.hash ? await library.mediaBlob(a, { keep: false }) : null;
    } catch {
      blob = null;
    }
    if (!blob) {
      missing.push(a.name);
      continue;
    }
    packed.add(path);
    entries.push({ name: path, data: blob, modified: a.added });
    media.push({ path, name: a.name, size: blob.size });
  }
  onProgress?.({ done, total: assets.length });
  for (const f of p.fonts || []) {
    const blob = await library.backend.readBlob(fontPath(f)).catch(() => null);
    if (!blob) {
      missing.push(f.name);
      continue;
    }
    entries.push({ name: fontPath(f), data: blob });
  }
  const luts = [];
  const seen = new Set();
  for (const ref of lutRefs(p)) {
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    const lut = await library.readLut(ref.id).catch(() => null);
    if (!lut) {
      missing.push(ref.name || 'LUT');
      continue;
    }
    entries.push({ name: lutPath(ref.id), data: lut.text });
    luts.push({ id: ref.id, name: lut.name });
  }
  const cover = await library.coverBlob(p.id).catch(() => null);
  const manifest = { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exported: Date.now(), name: p.name, media, luts, missing };
  const head = [
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'project.json', data: JSON.stringify(p) },
  ];
  if (cover) head.push({ name: 'cover.jpg', data: cover });
  const blob = await zipBlobs([...head, ...entries]);
  return { blob, fileName: `${fileBase(p.name)}${BUNDLE_SUFFIX}`, missing };
}

/**
 * Read a project file and add it to the library as a new project.
 * Returns { project, missing: [names of media, fonts and LUTs not in the file] }.
 */
export async function importProjectBundle(library, file, { onProgress } = {}) {
  const entries = await readZip(file);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const manifestEntry = byName.get('manifest.json');
  let manifest = null;
  if (manifestEntry) {
    try {
      manifest = JSON.parse(await (await manifestEntry.blob()).text());
    } catch {
      manifest = null;
    }
    if (manifest?.format && manifest.format !== BUNDLE_FORMAT) throw new Error('This ZIP file is not a Video Studio project file.');
    if (manifest?.version > BUNDLE_VERSION) throw new Error('This project file was made by a newer version of Video Studio.');
  }
  const projectEntry = byName.get('project.json');
  if (!projectEntry) throw new Error('This ZIP file is not a Video Studio project file (project.json is missing).');
  let raw;
  try {
    raw = JSON.parse(await (await projectEntry.blob()).text());
  } catch {
    throw new Error('The project in this file is damaged.');
  }
  const project = normalizeProject(raw);
  const assets = Object.values(project.assets);
  const missing = [];
  let done = 0;
  for (const a of assets) {
    onProgress?.({ done, total: assets.length, name: a.name });
    done++;
    const entry = byName.get(mediaName(a));
    if (!entry) {
      // The library may already hold this file (same account); otherwise it shows as missing media.
      missing.push(a.name);
      continue;
    }
    const blob = await entry.blob();
    project.assets[a.id] = await library.addMediaBlob({ ...a }, blob);
  }
  onProgress?.({ done, total: assets.length });
  // Fonts keep their hash (text styles name them by it), so only a matching file is taken.
  for (const f of project.fonts || []) {
    const entry = byName.get(fontPath(f));
    const blob = entry ? await entry.blob() : null;
    if (blob && (await fingerprint(blob)) === f.hash) await library.backend.writeBlob(fontPath(f), blob);
    else missing.push(f.name);
  }
  // LUTs are stored under the hash of what is in the file; clips follow if that differs.
  const refs = lutRefs(project);
  const lutIds = new Map();
  for (const id of new Set(refs.map((r) => r.id))) {
    const entry = byName.get(lutPath(id));
    const name = (Array.isArray(manifest?.luts) && manifest.luts.find((l) => l?.id === id)?.name) || refs.find((r) => r.id === id).name || 'LUT';
    try {
      if (!entry) throw new Error('LUT file missing');
      const { entry: stored } = await library.importLut(new File([await entry.blob()], `${String(name).replace(/[\\/]/g, ' ')}.cube`));
      lutIds.set(id, stored.id);
    } catch {
      missing.push(name);
    }
  }
  for (const r of refs) if (lutIds.has(r.id)) r.id = lutIds.get(r.id);
  const now = Date.now();
  project.id = uid('p');
  project.created = now;
  project.modified = now;
  delete project.deletedAt;
  await library.saveProject(project);
  const cover = byName.get('cover.jpg');
  if (cover) await library.saveCover(project.id, await cover.blob()).catch(() => {});
  return { project, missing };
}

/** Save a Blob as a download (browser) — the caller decides on Puter saving. */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
