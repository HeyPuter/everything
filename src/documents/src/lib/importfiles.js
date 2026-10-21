/**
 * Files brought in from the device: the Import button, and anything dropped
 * on the app. One file opens in the editor and is saved from there; several
 * are written straight into the documents folder, so a batch is not lost
 * behind the single document that would open.
 */

import { el } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { openModal } from '../ui/modal.js';
import * as P from './puter.js';
import { session } from './session.js';
import { HANWORD_IMPORTABLE, importHanword } from './importers.js';
import { importKind } from './importers.js';

/** The formats the app takes from the device, named the way the user sees them. */
export const IMPORT_FORMATS = 'DOCX, Hanword (.hwp, .hwpx), Markdown, HTML, or text files';

/** Importable DOCX, Hanword, and text files, in the order given. */
export function importableFiles(fileList) {
  return [...(fileList || [])].filter((f) => f && (P.IMPORTABLE.test(f.name || '') || importKind(f.name, f.type)));
}

/**
 * Import everything importable among `fileList`, ignoring the rest.
 *
 * `openFile` opens one file as a document; `stillHere` tells whether the
 * screen that started the import is still the one on show, and `onImported`
 * runs once files have landed in the folder behind it.
 */
/**
 * The message when nothing among `files` can be imported, worded for how they
 * arrived: dropped on the page, or chosen in the file dialog (where "drop" is
 * wrong and the user may have switched the dialog to all files).
 */
export function nothingImportable(files, { picked = false } = {}) {
  if (!picked) return `Drop ${IMPORT_FORMATS} to open them`;
  return `${(files?.length || 0) === 1 ? 'That file' : 'Those files'} cannot be imported. Choose ${IMPORT_FORMATS}`;
}

export async function importFiles(fileList, {
  openFile,
  stillHere = () => true,
  onImported = () => {},
  nothingMessage = nothingImportable(fileList),
} = {}) {
  const picked = importableFiles(fileList);
  if (!picked.length) { toast(nothingMessage, { icon: 'alert' }); return; }
  if (picked.length === 1) { await openFile(picked[0]); return; }
  // Text formats need the engine to become documents, so they open one at a
  // time; DOCX and converted Hanword files are written into the folder.
  const words = picked.filter((f) => P.OPENABLE.test(f.name || ''));
  const texts = picked.filter((f) => !P.OPENABLE.test(f.name || ''));
  // Only the files written to the cloud directly need a session; text files open like a single one does.
  if (words.length && session.signedOut && !await session.signIn()) { if (stillHere()) toast('Sign in to Puter to import several files at once', { icon: 'info' }); return; }
  if (!stillHere()) return;
  let saved = 0;
  const issues = [];
  for (const f of words) {
    try {
      const converted = HANWORD_IMPORTABLE.test(f.name) ? await importHanword(f) : null;
      if (converted?.warnings.length) issues.push(`${f.name}: ${converted.warnings.join(' ')}`);
      // A template or macro-enabled document is written as it is, so it keeps its extension: under .docx, Word
      // refuses its content. A converted Hanword file is a .docx.
      const kind = !converted && /\.(dotx|docm)$/i.exec(f.name)?.[0];
      const stem = P.stripExtension(f.name) || 'Untitled document';
      const name = await P.uniqueName(kind ? `${P.sanitizeName(stem) || 'Untitled document'}${kind}` : P.ensureDocx(stem));
      // Another tab or import may claim the checked name before this write.
      await P.writeFile(`${P.FOLDER}/${name}`, converted?.blob || f, { dedupe: true });
      saved += 1;
    } catch (e) {
      console.error(e);
      issues.push(`${f.name}: ${e?.message || 'Import failed'}`);
    }
  }
  const reportIssues = () => { if (issues.length) openModal({ title: 'Import details', content: el('div', {}, ...issues.map((message) => el('p.modal-text', {}, message))) }); };
  if (!stillHere()) {
    toast(`Imported ${saved} of ${picked.length} files${texts.length ? '. Text files were not opened because you moved on' : ''}`, { icon: saved ? 'info' : 'alert', duration: 6000 });
    // A file that did not make it is still worth naming, wherever the user is now.
    reportIssues();
    return;
  }
  if (texts.length) {
    if (words.length) toast(`Imported ${saved} of ${words.length} documents. Opening ${texts[0].name}; other text files import one at a time`, { icon: 'info', duration: 6000 });
    else if (texts.length > 1) toast(`Opening ${texts[0].name}. Markdown, HTML, and text files import one at a time`, { icon: 'info', duration: 5000 });
    await openFile(texts[0]);
    reportIssues();
    return;
  }
  toast(saved === picked.length ? `Imported ${saved} documents` : `Imported ${saved} of ${picked.length} documents`, { icon: saved ? 'check' : 'alert' });
  reportIssues();
  onImported();
}
