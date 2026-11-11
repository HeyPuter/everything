// Saving native projects to Puter, opening from Puter, and Open Recent.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import { serialize } from '../../model/serialization';
import { download } from '../../persistence/puter';
import { cloudRead, cloudSaveAs, cloudWrite, pickCloudFiles } from './cloud';
import { openFile } from './open';
import { noteRecent, setRecentOpener, storedBlob, type RecentSource } from './recent';
import { emitAppEvent } from '../../app/app-events';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const projectName = (name: string) => (/\.photo$/i.test(name) ? name : `${name}.photo`);

function markSaved(e: Editor, s: DocumentSession, doc: DocumentSession['saved'], item: { name: string; path: string }, blob: Blob) {
  s.storage.path = item.path;
  s.fileName = item.name;
  // Edits made while the picker was open stay dirty relative to what was written.
  s.saved = doc;
  noteRecent(e, item.name, { kind: 'puter', path: item.path });
  for (const hook of e.saveHooks) hook(s, blob);
  e.update();
  void emitAppEvent('after-save', s);
}

/** Save the project to its Puter path, or ask where to save it the first time. */
export async function save(e: Editor) {
  if (e.session.saveHandler) return e.session.saveHandler();
  await emitAppEvent('before-save', e.session);
  const s = e.session,
    doc = s.doc;
  const blob = await serialize(doc, s.assets);
  if (s.storage.path) {
    const item = await cloudWrite(s.storage.path, blob);
    markSaved(e, s, doc, item, blob);
    e.message(`Saved ${item.name} to Puter`);
    return;
  }
  saveAsWith(e, s, doc, blob);
}
function saveAsWith(e: Editor, s: DocumentSession, doc: NonNullable<DocumentSession['saved']>, blob: Blob, copy = false) {
  // The Puter picker never settles when dismissed: do not hold the editor busy.
  e.release();
  void cloudSaveAs(blob, projectName(s.fileName?.replace(/\.[^.]+$/, '') || doc.name))
    .then(async (item) => {
      if (copy) {
        noteRecent(e, item.name, { kind: 'puter', path: item.path });
        e.message(`Saved a copy as ${item.name}`);
        return;
      }
      markSaved(e, s, doc, item, blob);
      e.message(`Saved ${item.name} to Puter`);
    })
    .catch((error) => e.message(errorText(error)));
}
export async function saveAs(e: Editor, copy = false) {
  await emitAppEvent('before-save', e.session);
  const s = e.session,
    doc = s.doc;
  saveAsWith(e, s, doc, await serialize(doc, s.assets), copy);
}
export async function downloadProject(e: Editor) {
  await emitAppEvent('before-save', e.session);
  const s = e.session,
    doc = s.doc;
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
  for (const hook of e.saveHooks) hook(s, blob);
  e.update();
  e.message(`Downloaded ${name}`);
  void emitAppEvent('after-save', s);
}

export function openFromCloud(e: Editor) {
  e.release();
  void pickCloudFiles(true)
    .then((items) =>
      e.run(async () => {
        // One file that cannot be read or opened does not stop the others.
        const failed: string[] = [];
        for (const item of items)
          try {
            await openFile(e, await item.read(), item.name, false, { source: { kind: 'puter', path: item.path } });
          } catch (error) {
            if (items.length === 1) throw error;
            failed.push(`${item.name} could not be opened: ${errorText(error)}`);
          }
        if (failed.length) throw new Error(failed.join(' '));
      }),
    )
    .catch((error) => e.message(errorText(error)));
}

/** Open a file from the recent list. */
export async function openRecentEntry(e: Editor, entry: { name: string; source: RecentSource }) {
  const src = entry.source;
  const blob = src.kind === 'puter' ? await cloudRead(src.path) : src.kind === 'stored' ? await storedBlob(src.key) : src.blob;
  await openFile(e, blob, entry.name, false, { source: src });
}
export function installRecentOpener() {
  setRecentOpener(openRecentEntry);
}
