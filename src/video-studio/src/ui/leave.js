/**
 * Leaving with work not saved yet: the one question asked before edits or
 * media files that couldn't be stored are dropped (leaving the editor,
 * closing the page or the Puter window, signing out).
 */
import { confirmDialog, toast } from './dialog.js';

/**
 * Ask whether to leave anyway. edits: the latest edits couldn't be saved;
 * media: how many media files aren't stored. Resolves true to leave.
 */
export function confirmLeave(library, { edits = false, media = 0 }) {
  const where = library.backend.kind === 'local' ? 'in this browser' : 'to your Puter cloud';
  const what = [edits ? 'your latest changes' : null, media ? `${media} media file${media === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ');
  const answer = confirmDialog({
    title: "Couldn't save your changes",
    message: `${what[0].toUpperCase()}${what.slice(1)} couldn't be saved ${where}. If you leave now, ${!edits && media === 1 ? 'it' : 'they'} will be lost. Stay to keep trying.`,
    confirm: 'Leave anyway',
    cancel: 'Stay',
    danger: true,
  });
  // Enter keeps the work: focus Stay rather than the destructive choice.
  [...document.querySelectorAll('dialog[open] .dialog-actions .btn')].find((b) => b.textContent === 'Stay')?.focus();
  return answer;
}

/**
 * Wait for media uploads (trying failed ones again) before the page goes
 * away, saying so while files are still uploading. Resolves the number of
 * files still not stored afterwards.
 */
export async function finishUploads(library) {
  const busy = library.unsavedMedia;
  const note = busy ? toast(`Finishing ${busy} media upload${busy === 1 ? '' : 's'}...`, { duration: 10 * 60_000 }) : null;
  try {
    return (await library.flushUploads().catch(() => false)) ? 0 : library.unsavedMedia;
  } finally {
    note?.remove();
  }
}
