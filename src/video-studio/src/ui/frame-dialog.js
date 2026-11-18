import { abortable } from '../lib/abort.js';
import { oneAtATime, openDialog } from './dialog.js';

/** Shared lifetime for dialogs that read or analyze this editor's frames. */
export function frameDialogSignal(ctx) {
  const owner = ctx.editor || ctx;
  const lifetime = (owner._frameDialogLifetime ||= new AbortController());
  if (owner._disposed || owner.disposed) lifetime.abort();
  return lifetime.signal;
}

/** Frame-loading dialogs belong to one editor, including their pending reads. */
export function frameDialog(open) {
  return oneAtATime(async (ctx, id) => {
    const signal = frameDialogSignal(ctx);
    if (signal.aborted) return;
    try {
      return await abortable(() => open(ctx, id, signal), signal);
    } catch (err) {
      if (!signal.aborted) throw err;
    }
  }, ctx => ctx.editor || ctx);
}

/** Close an already-open frame dialog when its editor leaves. */
export function openFrameDialog(options, signal) {
  signal.throwIfAborted();
  const dialog = openDialog(options);
  const close = () => dialog.close();
  signal.addEventListener('abort', close, { once: true });
  dialog.result.then(() => signal.removeEventListener('abort', close));
  if (signal.aborted) close();
  return dialog;
}
