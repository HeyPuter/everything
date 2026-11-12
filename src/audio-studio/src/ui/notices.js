// Explanatory notices with "Don't show this again". Dismissed notice ids are
// kept in prefs.dismissedNotices; Preferences > General > Reset All Warning
// Dialogs brings them back.

import { h } from '../lib/dom.js';
import { openDialog } from './dialog.js';

export function noticeDismissed(prefs, id) {
  const list = prefs.get('dismissedNotices');
  return Array.isArray(list) && list.includes(id);
}

/**
 * Shows notice `id` unless it was dismissed. Resolves true to go ahead (OK,
 * or a dismissed notice) and false when canceled. `message` is a string or
 * an array of paragraphs.
 */
export async function showNotice(app, { id, title, message, confirm = 'OK', cancel = 'Cancel' }) {
  if (noticeDismissed(app.prefs, id)) return true;
  const never = h('input', { type: 'checkbox' });
  const paras = (Array.isArray(message) ? message : [message]).map((m) => h('p', { style: { margin: '0 0 8px' } }, m));
  const r = await openDialog({
    title,
    body: h('div.notice', { style: { maxWidth: '460px' } }, ...paras, h('label.check', { style: { marginTop: '6px' } }, never, "Don't show this again")),
    buttons: [...(cancel ? [{ label: cancel, value: null }] : []), { label: confirm, value: 'ok', primary: true }],
    // The action, not the opt-out: Space or Enter must not tick "Don't show this again".
    initialFocus: '.btn.primary',
  });
  if (r !== 'ok') return false;
  if (never.checked) app.prefs.set('dismissedNotices', [...new Set([...(app.prefs.get('dismissedNotices') || []), id])]);
  return true;
}
