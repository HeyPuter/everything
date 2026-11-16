// Saving to Puter (a native project, or a PSD for a document that came from
// one), opening from Puter, and Open Recent.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import type { PhotoDocument } from '../../model/document';
import { projectExtras, serialize } from '../../model/serialization';
import { describePsdLosses, psdLosses, type PsdLoss } from '../../model/psd-losses';
import { download } from '../../persistence/puter';
import { cloudRead, cloudSaveAs, cloudWrite, pickCloudFiles, type CloudItem } from './cloud';
import { openFile } from './open';
import { noteRecent, removeRecent, setRecentOpener, storedBlob, type RecentSource } from './recent';
import { emitAppEvent } from '../../app/app-events';
import { askChoice } from '../preferences/warnings';

export type SaveFormat = 'photo' | 'psd';
// What was encoded for a save. `project` is set when the bytes are a native project.
type Written = { blob: Blob; ext: string; doc: PhotoDocument; extrasRevision: number; project?: Blob };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const projectName = (name: string) => (/\.photo$/i.test(name) ? name : `${name}.photo`);
const isPsdName = (name?: string) => /\.ps[db]$/i.test(name ?? '');
const extension = (path: string) => /\.([^./]+)$/.exec(path)?.[1].toLowerCase();
const stem = (s: DocumentSession, doc: PhotoDocument) => s.fileName?.replace(/\.[^.]+$/, '') || doc.name;

/** The format Save writes: a document opened from a PSD, or last saved as
 * one, goes back to PSD; everything else is a native project. */
export const saveFormat = (s: DocumentSession): SaveFormat => (isPsdName(s.fileName) ? 'psd' : 'photo');

// What a PSD would not keep, and the losses already agreed to for a document
// (Save asks about each kind once, not on every save).
const lossesOf = (s: DocumentSession) => psdLosses(s.doc, { comments: !!projectExtras.get(s.assets)?.(s.doc).comments });
const acceptedLosses = new WeakMap<DocumentSession, Set<string>>();
const acceptLosses = (s: DocumentSession, losses: PsdLoss[]) => acceptedLosses.set(s, new Set([...(acceptedLosses.get(s) ?? []), ...losses.map((l) => l.id)]));
const KEEPS_ALL = 'A .photo project keeps everything.';

function markSaved(e: Editor, s: DocumentSession, w: Written, item: { name: string; path: string }) {
  s.storage.path = item.path;
  s.fileName = item.name;
  // Edits made while the picker was open stay dirty relative to what was written.
  s.saved = w.doc;
  s.savedExtrasRevision = w.extrasRevision;
  noteRecent(e, item.name, { kind: 'puter', path: item.path });
  for (const hook of e.saveHooks) hook(s, w.project);
  e.update();
  void emitAppEvent('after-save', s);
}

/** The document's bytes in a format, or undefined when cancelled. A document
 * that cannot be written as a PSD offers a project instead. */
async function encode(e: Editor, s: DocumentSession, format: SaveFormat): Promise<Written | undefined> {
  const extrasRevision = s.extrasRevision;
  if (format === 'psd') {
    try {
      const out = await (await import('./psd-export')).buildPsd(e);
      return out && { blob: out.blob, ext: out.extension, doc: out.live, extrasRevision };
    } catch (error) {
      // Messages for the user are plain Errors; anything else is a bug.
      if (!(error instanceof Error) || error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) throw error;
      if (!(await askChoice('Save as PSD', `This document cannot be saved as a PSD. ${error.message}`, [['photo', 'Save as .photo']]))) return;
    }
  }
  const doc = s.doc;
  const blob = await serialize(doc, s.assets);
  return { blob, ext: 'photo', doc, extrasRevision, project: blob };
}

/** Write to the document's own Puter file when it has one of this format;
 * otherwise (and for Save As and copies) ask where. */
async function store(e: Editor, s: DocumentSession, w: Written, to: { pick?: boolean; copy?: boolean } = {}) {
  const path = s.storage.path;
  // A project never overwrites a PSD, nor a PSD a file of another format.
  if (!to.pick && path && (w.project ? !isPsdName(path) : extension(path) === w.ext)) {
    const item = await cloudWrite(path, w.blob);
    markSaved(e, s, w, item);
    e.message(`Saved ${item.name} to Puter`);
    return;
  }
  // The Puter picker never settles when dismissed: do not hold the editor busy.
  e.release();
  void cloudSaveAs(w.blob, w.project ? projectName(stem(s, w.doc)) : `${stem(s, w.doc)}.${w.ext}`)
    .then(async (item) => {
      if (to.copy) {
        noteRecent(e, item.name, { kind: 'puter', path: item.path });
        e.message(`Saved a copy as ${item.name}`);
        return;
      }
      markSaved(e, s, w, item);
      e.message(`Saved ${item.name} to Puter`);
    })
    .catch((error) => e.message(errorText(error)));
}

/** Save to the document's Puter file in its own format, or ask where to save
 * it the first time. A PSD that would lose something asks first. */
export async function save(e: Editor) {
  if (e.session.saveHandler) return e.session.saveHandler();
  await emitAppEvent('before-save', e.session);
  const s = e.session;
  let format = saveFormat(s);
  if (format === 'psd') {
    const losses = lossesOf(s);
    const seen = acceptedLosses.get(s);
    if (losses.some((l) => !seen?.has(l.id))) {
      const choice = await askChoice<SaveFormat>('Save as PSD', `${describePsdLosses(losses)} ${KEEPS_ALL}`, [
        ['photo', 'Save as .photo'],
        ['psd', 'Save as PSD'],
      ]);
      if (!choice) return;
      format = choice;
      if (choice === 'psd') acceptLosses(s, losses);
    }
  }
  const w = await encode(e, s, format);
  if (w) await store(e, s, w);
}
/** Save to a new Puter location as a PSD or a project. `format` skips the
 * question (scripts and tests). */
export async function saveAs(e: Editor, copy = false, format?: unknown) {
  await emitAppEvent('before-save', e.session);
  const s = e.session;
  const losses = lossesOf(s);
  const lost = describePsdLosses(losses);
  const chosen =
    format === 'photo' || format === 'psd'
      ? format
      : await askChoice<SaveFormat>(copy ? 'Save a Copy' : 'Save As', lost ? `${lost} ${KEEPS_ALL}` : 'A PSD opens in other apps. A .photo project is Photo Studio’s own format and also keeps the provenance record.', [
          ['photo', 'Photo Studio Project'],
          ['psd', 'PSD'],
        ]);
  if (!chosen) return;
  // The question named the losses: later saves of this PSD do not ask again.
  if (chosen === 'psd' && !copy) acceptLosses(s, losses);
  const w = await encode(e, s, chosen);
  if (w) await store(e, s, w, { pick: true, copy });
}
export async function downloadProject(e: Editor) {
  await emitAppEvent('before-save', e.session);
  const s = e.session,
    doc = s.doc,
    extrasRevision = s.extrasRevision;
  const name = projectName(s.fileName?.replace(/\.[^.]+$/, '') || doc.name);
  const blob = await serialize(doc, s.assets);
  download(blob, name);
  // An embedded object's contents tab is saved by updating its parent; a
  // download is only a copy, so closing the tab still offers that save.
  if (s.saveHandler) {
    e.message(`Downloaded a copy as ${name}. Save to update the embedded object.`);
    return;
  }
  s.saved = doc;
  s.savedExtrasRevision = extrasRevision;
  for (const hook of e.saveHooks) hook(s, blob);
  e.update();
  e.message(`Downloaded ${name}`);
  void emitAppEvent('after-save', s);
}

/** Open files that live on Puter where they are: a .photo project or a PSD saves back to its path. */
export async function openCloudItems(e: Editor, items: CloudItem[]) {
  // One file that cannot be read or opened does not stop the others.
  const failed: string[] = [];
  for (const item of items)
    try {
      const blob = typeof item.read === 'function' ? await item.read() : await cloudRead(item.path);
      await openFile(e, blob, item.name, false, { source: { kind: 'puter', path: item.path } });
    } catch (error) {
      if (items.length === 1) throw error;
      failed.push(`${item.name} could not be opened: ${errorText(error)}`);
    }
  if (failed.length) throw new Error(failed.join(' '));
}
export function openFromCloud(e: Editor) {
  e.release();
  void pickCloudFiles(true)
    .then((items) => e.run(() => openCloudItems(e, items)))
    .catch((error) => e.message(errorText(error)));
}

/** Open a file from the recent list. */
export async function openRecentEntry(e: Editor, entry: { name: string; source: RecentSource }) {
  const src = entry.source;
  const blob = src.kind === 'puter' ? await cloudRead(src.path) : src.kind === 'stored' ? await storedBlob(src.key) : src.blob;
  if (!blob) {
    // Browser data was cleared: the entry would fail every time.
    removeRecent(e, entry);
    throw new Error(`${entry.name} is no longer stored in this browser and was removed from Open Recent. Open it again from its location.`);
  }
  await openFile(e, blob, entry.name, false, { source: src });
}
export function installRecentOpener() {
  setRecentOpener(openRecentEntry);
}
