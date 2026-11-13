import { h, announce } from '../lib/dom.js';
import { downloadBlob } from '../storage/bundle.js';
import { confirmDialog, toast } from './dialog.js';

/** Own one unsaved take until import succeeds or the user explicitly discards it. */
export function createRecordingRecovery({ onState }) {
  let pending = null;
  let saving = false;
  let confirming = false;
  const text = h('p');
  const retry = h('button.btn.primary', { type: 'button', onclick: () => attempt() }, 'Retry saving');
  const download = h('button.btn', { type: 'button', onclick: () => {
    if (!pending || saving) return;
    try {
      downloadBlob(pending.file, pending.file.name);
      announce('Download requested. Keep this dialog open until you have saved the file.');
    } catch (err) {
      toast(err?.message || "Couldn't download the recording.", { kind: 'error' });
    }
  } }, 'Download recording');
  const discard = h('button.btn', { type: 'button', onclick: () => confirmDiscard() }, 'Discard recording');
  const el = h('div.recording-recovery', { hidden: true },
    h('div', { role: 'alert' }, text), h('div.recording-recovery-actions', retry, download, discard));

  function warnUnload(event) {
    event.preventDefault();
    event.returnValue = '';
  }

  function clear() {
    pending = null;
    el.hidden = true;
    window.removeEventListener('beforeunload', warnUnload);
  }

  async function confirmDiscard(close) {
    if (!pending || saving || confirming) return;
    confirming = true;
    const yes = await confirmDialog({
      title: 'Discard unsaved recording?',
      message: 'This recording has not been saved to your media. Download it first if you want to keep it. Discarding cannot be undone.',
      confirm: 'Discard recording', cancel: 'Keep recording', danger: true,
    });
    confirming = false;
    if (!yes) return;
    clear();
    onState('idle');
    close?.();
  }

  async function attempt() {
    if (!pending || saving) return;
    saving = true;
    el.hidden = true;
    onState('saving');
    const take = pending;
    let asset;
    try {
      [asset] = await take.importFile(take.file);
    } catch (err) {
      toast(err?.message || "Couldn't save the recording.", { kind: 'error' });
    }
    saving = false;
    if (!asset) {
      text.textContent = `Couldn't save ${take.file.name}. Your recording is still here. Retry saving or download it before leaving.`;
      el.hidden = false;
      onState('recovery');
      retry.focus();
      return;
    }
    // Once imported, a timeline insertion failure must not import a duplicate.
    clear();
    onState('idle');
    try {
      take.onSaved(asset);
    } catch (err) {
      toast(`The recording is saved in your media, but couldn't be added to the timeline. ${err?.message || ''}`, { kind: 'error' });
    }
  }

  return {
    el,
    save(take) {
      if (pending) return;
      pending = take;
      window.addEventListener('beforeunload', warnUnload);
      return attempt();
    },
    beforeClose(close) {
      if (!pending) return true;
      if (saving) announce('Please wait while the recording is saved.');
      else confirmDiscard(close);
      return false;
    },
  };
}
