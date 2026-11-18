import { abortable } from '../lib/abort.js';
import { oneAtATime, openDialog } from './dialog.js';

/** Frame-loading dialogs belong to one editor, including their pending reads. */
export function frameDialog(open) {
  return oneAtATime(async (ctx, id) => {
    const owner = ctx.editor || ctx;
    if (owner._disposed || owner.disposed) return;
    const signal = (owner._frameDialogLifetime ||= new AbortController()).signal;
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
