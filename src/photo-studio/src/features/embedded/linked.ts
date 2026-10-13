// Linked embedded objects: content placed from a file that stays associated
// with it. The project keeps a cached copy, so it always opens; Update
// Modified Content re-reads the file. Puter files are re-read from their
// path. A local file can be re-read only while this page holds its handle
// (browsers allow no access by path), so after a reload Relink re-picks it.
import type { Editor } from '../../editor';
import { allLayers, findLayer } from '../../model/document';
import { contentsOf, type EmbeddedContents, type EmbedLink } from '../../model/embedded';
import { cloudRead, pickCloudFiles } from '../files/cloud';
import { contentsFromFile, fittedTransform, insertInstance, instanceLayer, setContents } from './contents';
import { fileAccept, pickLocalFiles, selectedObject } from './convert';
import { handles, linkedIn, linkReaders, statuses, type FileHandle } from './link-state';

export { hasLinked, linkStatus, linkStatusText, watchLinks, type LinkStatus } from './link-state';
type Picker = (options?: { multiple?: boolean }) => Promise<FileHandle[]>;

export async function sha256(blob: Blob) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
/** The current bytes of a linked file when they can be read (Puter path, or
 * a local file whose handle this page holds); otherwise undefined. */
export async function readLinkedFile(c: EmbeddedContents): Promise<Blob | undefined> {
  if (!c.link) return undefined;
  try {
    if (c.link.kind === 'puter' && c.link.path) return await cloudRead(c.link.path);
    if (c.link.kind === 'library') return await linkReaders.library?.(c);
    const h = handles.get(c.id);
    return h ? await h.getFile() : undefined;
  } catch {
    return undefined;
  }
}
/** Ask for a file: a handle that can be re-read when the browser allows it. */
async function pickLocal(): Promise<{ file: File; handle?: FileHandle } | undefined> {
  const picker = (window as unknown as { showOpenFilePicker?: Picker }).showOpenFilePicker;
  if (picker)
    try {
      const [handle] = await picker({ multiple: false });
      return { file: await handle.getFile(), handle };
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') return undefined;
      // Embedded frames and some browsers refuse the picker; use a file input.
    }
  const [file] = await pickLocalFiles(fileAccept());
  return file ? { file } : undefined;
}
async function linkFor(kind: 'local' | 'puter', blob: Blob, name: string, path?: string): Promise<EmbedLink> {
  return { kind, name, ...(path ? { path } : {}), size: blob.size, modified: blob instanceof File ? blob.lastModified : Date.now(), hash: await sha256(blob) };
}

type Picked = { blob: Blob; name: string; link: EmbedLink; handle?: FileHandle };
/** Pick the file to link. The Puter picker never settles when dismissed, so
 * the editor is not held busy while it is open; `then` runs the work. */
async function pickLinked(e: Editor, from: 'local' | 'puter', then: (p: Picked) => Promise<void>) {
  if (from === 'local') {
    const p = await pickLocal();
    if (p) await then({ blob: p.file, name: p.file.name, link: await linkFor('local', p.file, p.file.name), handle: p.handle });
    return;
  }
  e.release();
  const [item] = await pickCloudFiles(false);
  if (!item) return;
  await e.run(async () => {
    const blob = await item.read();
    await then({ blob, name: item.name, link: await linkFor('puter', blob, item.name, item.path) });
  });
}

/** File → Place Linked… (local file) or Place Linked from Puter…. */
export function placeLinked(e: Editor, from: 'local' | 'puter') {
  return pickLinked(e, from, async (picked) => {
    const c = { ...(await contentsFromFile(e, e.doc, e.assets, picked.blob, picked.name)), link: picked.link };
    if (picked.handle) handles.set(c.id, picked.handle);
    statuses.set(c.id, 'current');
    insertInstance(e, instanceLayer(c, c.name, fittedTransform(e.doc, c.width, c.height)), c, 'Place Linked');
    e.message(`Placed ${picked.name} as a linked embedded object.${picked.handle || from === 'puter' ? '' : ' This browser gives no lasting access to the file; use Relink to File to update it later.'}`);
  });
}

async function readLinked(c: EmbeddedContents): Promise<Blob | undefined> {
  const link = c.link!;
  try {
    if (link.kind === 'puter' && link.path) return await cloudRead(link.path);
    if (link.kind === 'library') return await linkReaders.library?.(c);
    return await handles.get(c.id)?.getFile();
  } catch {
    return undefined;
  }
}
/** Re-read linked files and update the contents that changed. */
export async function updateModified(e: Editor, all: boolean) {
  const list = linkedIn(e, all ? allLayers(e.doc.layers) : e.selectedLayers);
  if (!list.length) {
    e.message(all ? 'This document has no linked objects.' : 'Select a linked embedded object.');
    return;
  }
  const doc = e.doc;
  const updates: EmbeddedContents[] = [];
  const unavailable: string[] = [];
  for (const c of list) {
    const blob = await readLinked(c);
    if (!blob) {
      statuses.set(c.id, 'unavailable');
      unavailable.push(c.link!.name);
      continue;
    }
    const hash = await sha256(blob);
    if (hash === c.link!.hash) {
      statuses.set(c.id, 'current');
      continue;
    }
    const next = await contentsFromFile(e, doc, e.assets, blob, c.link!.name);
    updates.push({ ...next, id: c.id, name: c.name, link: { ...c.link!, size: blob.size, modified: blob instanceof File ? blob.lastModified : Date.now(), hash } });
  }
  if (updates.length) {
    e.command('Update Modified Content', (d) => updates.forEach((n) => setContents(d, n)));
    for (const n of updates) statuses.set(n.id, 'current');
  }
  e.update();
  const parts = [updates.length ? `Updated ${updates.length} linked object${updates.length === 1 ? '' : 's'}.` : 'Linked objects are up to date.'];
  if (unavailable.length) parts.push(`Could not read ${unavailable.join(', ')}; use Relink to File to choose it again.`);
  e.message(parts.join(' '));
}

/** Choose the linked file again (for example after reloading the page). */
export async function relink(e: Editor) {
  const l = selectedObject(e);
  if (!l) return;
  const old = contentsOf(e.doc, l);
  await pickLinked(e, old?.link?.kind === 'puter' ? 'puter' : 'local', async (picked) => {
    const next = await contentsFromFile(e, e.doc, e.assets, picked.blob, picked.name);
    const id = old?.id ?? next.id;
    if (picked.handle) handles.set(id, picked.handle);
    else handles.delete(id);
    statuses.set(id, 'current');
    e.command('Relink to File', (d) => {
      const t = findLayer(d.layers, l.id);
      if (!t) return;
      t.embed ??= { contents: id };
      setContents(d, { ...next, id, name: old?.name ?? next.name, link: picked.link });
    });
    e.message(`Linked to ${picked.name}.`);
  });
}

/** Keep the cached content and drop the link (Embed Linked / Embed All Linked). */
export function embedLinked(e: Editor, all: boolean) {
  const ids = linkedIn(e, all ? allLayers(e.doc.layers) : e.selectedLayers).map((c) => c.id);
  if (!ids.length) return;
  e.command(all ? 'Embed All Linked' : 'Embed Linked', (d) => {
    for (const id of ids) if (d.embeds?.[id]) delete d.embeds[id].link;
  });
  e.message(`${ids.length === 1 ? 'The object is' : `${ids.length} objects are`} now embedded; the file is no longer read.`);
}

