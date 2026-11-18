// Saving to Puter (a native project, or the PSD or single image file a
// document came from), opening from Puter, and Open Recent.
import type { Editor } from '../../editor';
import type { DocumentSession } from '../../app/session';
import type { PhotoDocument } from '../../model/document';
import { projectExtras, serialize } from '../../model/serialization';
import { describePsdLosses, flatLosses, psdLosses, type PsdLoss } from '../../model/psd-losses';
import { download } from '../../persistence/puter';
import { cloudRead, cloudSaveAs, cloudWrite, pickCloudFiles, puterError, puterMissing, type CloudItem } from './cloud';
import { openFile } from './open';
import { noteRecent, removeRecent, setRecentOpener, storedBlob, type RecentSource } from './recent';
import { emitAppEvent } from '../../app/app-events';
import { flatSaveFormat, formatInfo, type FlatSaveFormat } from './formats';
import { askChoice } from '../preferences/warnings';

export type SaveFormat = 'photo' | 'psd' | FlatSaveFormat;
// What was encoded for a save. `project` is set when the bytes are a native project.
type Written = { blob: Blob; ext: string; format: SaveFormat; doc: PhotoDocument; extrasRevision: number; project?: Blob };

const errorText = (error: unknown) => puterError(error).message;
const projectName = (name: string) => (/\.photo$/i.test(name) ? name : `${name}.photo`);
const isPsdName = (name?: string) => /\.ps[db]$/i.test(name ?? '');
const extension = (path: string) => /\.([^./]+)$/.exec(path)?.[1].toLowerCase();
const stem = (s: DocumentSession, doc: PhotoDocument) => s.fileName?.replace(/\.[^.]+$/, '') || doc.name;
const isFlat = (format: SaveFormat): format is FlatSaveFormat => format !== 'photo' && format !== 'psd';
const isSaveFormat = (format: unknown): format is SaveFormat => format === 'photo' || format === 'psd' || (typeof format === 'string' && flatSaveFormat(`x.${format}`) === format);
/** What a file name saves as: a PSD, a single image file Save can write, or a project. */
const nameFormat = (name?: string): SaveFormat => (isPsdName(name) ? 'psd' : (flatSaveFormat(name) ?? 'photo'));
const formatLabel = (format: SaveFormat) => (format === 'photo' ? '.photo' : format === 'psd' ? 'PSD' : formatInfo[format].label);
/** The extension a single image file is written with: the one it was opened with, when that is this format. */
const flatExtension = (s: DocumentSession, format: FlatSaveFormat) => (flatSaveFormat(s.fileName) === format ? extension(s.fileName!)! : formatInfo[format].ext);

/** The format Save writes: a document opened from a PSD or a single image
 * file Save can write (PNG, JPEG, WebP, ...), or last saved as one, goes back
 * to that format; everything else is a native project. */
export const saveFormat = (s: DocumentSession): SaveFormat => nameFormat(s.fileName);

// What a format would not keep, and the losses already agreed to for a
// document (Save asks about each kind once per format, not on every save).
function lossesOf(s: DocumentSession, format: SaveFormat): PsdLoss[] {
  const comments = !!projectExtras.get(s.assets)?.(s.doc).comments;
  if (format === 'psd') return psdLosses(s.doc, { comments });
  if (!isFlat(format)) return [];
  return flatLosses(s.doc, { comments, text: formatInfo[format].text, deep: formatInfo[format].deep });
}
const acceptedLosses = new WeakMap<DocumentSession, Set<string>>();
const lossKey = (format: SaveFormat, loss: PsdLoss) => `${format}:${loss.id}`;
const acceptLosses = (s: DocumentSession, format: SaveFormat, losses: PsdLoss[]) =>
  acceptedLosses.set(s, new Set([...(acceptedLosses.get(s) ?? []), ...losses.map((l) => lossKey(format, l))]));
const KEEPS_ALL = 'A .photo project keeps everything.';

/** Ask before writing a format that would lose something not agreed to yet;
 * the answer may be a project instead. Undefined when cancelled. */
async function confirmLosses(e: Editor, s: DocumentSession, format: SaveFormat): Promise<SaveFormat | undefined> {
  const losses = lossesOf(s, format);
  const seen = acceptedLosses.get(s);
  if (!losses.some((l) => !seen?.has(lossKey(format, l)))) return format;
  const name = formatLabel(format);
  const choice = await askChoice<SaveFormat>(`Save as ${name}`, `${describePsdLosses(losses, name)} ${KEEPS_ALL}`, [
    ['photo', 'Save as .photo'],
    [format, `Save as ${name}`],
  ]);
  if (!choice) return cancelSave(e, s);
  if (choice === format) acceptLosses(s, format, losses);
  return choice;
}

/** A single image file of the document: its composite at full size, in the
 * document's color profile where the format stores one, with the Export As
 * quality and metadata, and provenance as Preferences → Export asks. */
async function encodeFlat(e: Editor, s: DocumentSession, doc: PhotoDocument, format: FlatSaveFormat, name: string): Promise<Blob> {
  const info = formatInfo[format];
  const { bytesBlob, encodeDocument, loadSettings } = await import('./pipeline');
  if (format === 'avif' && !(await (await import('./encode')).canEncodeAvif())) throw new Error('This browser cannot write AVIF files.');
  const deep = info.deep && (doc.bitsPerChannel ?? 8) > 8;
  const settings = { ...loadSettings(), format, sizeMode: 'percent' as const, scale: 100, canvasWidth: 0, canvasHeight: 0, transparency: true, depth: deep ? (16 as const) : (8 as const), metadata: 'all' as const, embedIcc: true, convertSrgb: !info.icc };
  const out = await encodeDocument(e, settings, doc);
  const { withProvenance } = await import('../provenance/export');
  const bytes = await withProvenance(s, out.bytes, name, e.preferences.provenanceAttach, { prompts: e.preferences.provenancePrompts, width: out.width, height: out.height });
  return bytesBlob(bytes, out.mime);
}

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

/** The user gave up the save of `s` at a question: a close waiting on it stops. */
const cancelSave = (e: Editor, s: DocumentSession): undefined => {
  for (const hook of [...e.saveCancelHooks]) hook(s);
  return undefined;
};

/** The document's bytes in a format, or undefined when cancelled. A document
 * that cannot be written as a PSD or an image file offers a project instead. */
async function encode(e: Editor, s: DocumentSession, format: SaveFormat): Promise<Written | undefined> {
  const extrasRevision = s.extrasRevision;
  if (format !== 'photo') {
    try {
      if (isFlat(format)) {
        const doc = s.doc;
        const ext = flatExtension(s, format);
        return { blob: await encodeFlat(e, s, doc, format, `${stem(s, doc)}.${ext}`), ext, format, doc, extrasRevision };
      }
      const out = await (await import('./psd-export')).buildPsd(e);
      // Undefined: the Maximize Compatibility question was cancelled.
      if (!out) return cancelSave(e, s);
      return { blob: out.blob, ext: out.extension, format, doc: out.live, extrasRevision };
    } catch (error) {
      // Messages for the user are plain Errors; anything else is a bug.
      if (!(error instanceof Error) || error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError) throw error;
      const name = formatLabel(format);
      if (!(await askChoice(`Save as ${name}`, `This document cannot be saved as ${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name}. ${error.message}`, [['photo', 'Save as .photo']]))) return cancelSave(e, s);
    }
  }
  const doc = s.doc;
  const blob = await serialize(doc, s.assets);
  return { blob, ext: 'photo', format: 'photo', doc, extrasRevision, project: blob };
}

/** Write to the document's own Puter file when it has one of this format;
 * otherwise (and for Save As and copies) ask where. */
async function store(e: Editor, s: DocumentSession, w: Written, to: { pick?: boolean; copy?: boolean } = {}) {
  const path = s.storage.path;
  // A file is only overwritten in its own format: a project never replaces a
  // PSD or an image file, nor a PNG a JPEG.
  if (!to.pick && path && nameFormat(path) === w.format && (w.format !== 'psd' || extension(path) === w.ext)) {
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
 * it the first time. A PSD or image file that would lose something asks first. */
export async function save(e: Editor) {
  if (e.session.saveHandler) return e.session.saveHandler();
  await emitAppEvent('before-save', e.session);
  const s = e.session;
  const format = await confirmLosses(e, s, saveFormat(s));
  if (!format) return;
  const w = await encode(e, s, format);
  if (w) await store(e, s, w);
}
/** Save to a new Puter location as a project, a PSD, or the single image
 * format the document came from. `format` skips the question (scripts and tests). */
export async function saveAs(e: Editor, copy = false, format?: unknown) {
  await emitAppEvent('before-save', e.session);
  const s = e.session;
  const losses = lossesOf(s, 'psd');
  const lost = describePsdLosses(losses);
  // The image format the document came from is offered too (Export writes others).
  const source = flatSaveFormat(s.fileName);
  const choices: [SaveFormat, string][] = [
    ['photo', 'Photo Studio Project'],
    ['psd', 'PSD'],
  ];
  if (source) choices.push([source, formatInfo[source].label]);
  const about = source ? `${lost ? `${lost} ` : 'A PSD keeps layers and opens in other apps. '}${/^[AEIOU]/.test(formatInfo[source].label) ? 'An' : 'A'} ${formatInfo[source].label} holds one flattened image. ${KEEPS_ALL}` : lost ? `${lost} ${KEEPS_ALL}` : 'A PSD opens in other apps. A .photo project is Photo Studio’s own format and also keeps the provenance record.';
  let chosen: SaveFormat | null | undefined = isSaveFormat(format) ? format : await askChoice<SaveFormat>(copy ? 'Save a Copy' : 'Save As', about, choices);
  if (!chosen) return;
  // The question named a PSD's losses: later saves of this PSD do not ask again.
  if (chosen === 'psd' && !copy) acceptLosses(s, 'psd', losses);
  if (isFlat(chosen)) chosen = await confirmLosses(e, s, chosen);
  if (!chosen) return;
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
      const blob = typeof item.read === 'function' ? await item.read().catch((thrown) => Promise.reject(puterError(thrown))) : await cloudRead(item.path);
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
  let blob: Blob | undefined;
  try {
    blob = src.kind === 'puter' ? await cloudRead(src.path) : src.kind === 'stored' ? await storedBlob(src.key) : src.blob;
  } catch (error) {
    // Moved or deleted on Puter: the entry would fail every time.
    if (src.kind !== 'puter' || !puterMissing(error)) throw error;
    removeRecent(e, entry);
    throw new Error(`${entry.name} is no longer at ${src.path} and was removed from Open Recent.`);
  }
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
