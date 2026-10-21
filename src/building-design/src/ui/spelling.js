/**
 * Check Spelling: the words people read on drawings (text notes, room,
 * view and sheet names, keynotes and comments) are checked by Puter's AI,
 * and each suggested correction can be accepted or skipped.
 */
import { h } from './dom.js';
import { openDialog, toast } from './dialog.js';
import { puterAvailable, isSignedIn, whenPuter } from '../platform.js';
import { isView } from '../core/doc.js';

/** The pieces of text in the project worth checking: [{ id, field, text, where }]. */
export function spellableTexts(doc) {
  const out = [];
  const add = (el, field, where) => {
    const t = el[field];
    if (typeof t === 'string' && /[A-Za-z]{3,}/.test(t)) out.push({ id: el.id, field, text: t, where });
  };
  for (const el of doc.items.values()) {
    if (el.kind === 'text') add(el, 'text', `Text in ${doc.get(el.viewId)?.name || 'a view'}`);
    else if (el.kind === 'room' || el.kind === 'space' || el.kind === 'area') add(el, 'name', `${el.kind === 'room' ? 'Room' : el.kind === 'space' ? 'Space' : 'Area'} ${el.number || ''}`.trim());
    else if (isView(el)) add(el, 'name', el.kind === 'sheet' ? 'Sheet name' : 'View name');
    if (el.comments) add(el, 'comments', 'Comments');
    if (el.kind.endsWith('Type') && el.keynote) add(el, 'keynote', 'Keynote');
  }
  return out.slice(0, 400);
}

function parseJSON(text) {
  const m = /\[[\s\S]*\]/.exec(String(text || ''));
  if (!m) return [];
  try {
    return JSON.parse(m[0]);
  } catch {
    return [];
  }
}

export async function checkSpelling(app) {
  const doc = app.doc;
  const items = spellableTexts(doc);
  if (!items.length) return toast('There is no text to check.');
  if (!puterAvailable() || !(await whenPuter(4000))) return toast('Checking spelling needs Puter, which could not be reached.', { kind: 'error' });
  if (!(await isSignedIn()) && !(await app.signIn())) return;
  app.setPrompt(`Checking the spelling of ${items.length} pieces of text...`);
  let fixes = [];
  try {
    const list = items.map((it, i) => ({ i, text: it.text }));
    const prompt = `You check spelling in architectural drawings. Find spelling mistakes in these texts. Leave abbreviations, codes, numbers, names and technical terms alone, and do not change style or wording. Reply with only a JSON array of {"i": <index>, "corrected": "<the whole text corrected>"} for the texts that have mistakes, or [] if none.\n\n${JSON.stringify(list)}`;
    const res = await puter.ai.chat(prompt);
    const text = typeof res === 'string' ? res : typeof res?.message?.content === 'string' ? res.message.content : Array.isArray(res?.message?.content) ? res.message.content.map((c) => c?.text || '').join('') : '';
    fixes = parseJSON(text).filter((f) => items[f.i] && typeof f.corrected === 'string' && f.corrected.trim() && f.corrected !== items[f.i].text);
  } catch (err) {
    app.setPrompt('Ready');
    return toast(`Could not check spelling: ${err?.message || err?.error?.message || err}`, { kind: 'error' });
  }
  app.setPrompt('Ready');
  if (!fixes.length) return toast('No spelling mistakes found.', { kind: 'success' });
  const rows = fixes.map((f) => ({ f, it: items[f.i], cb: h('input', { type: 'checkbox', checked: true }) }));
  const ok = await openDialog({
    title: 'Check Spelling',
    size: 'lg',
    body: h(
      'div',
      h('p.field-hint', 'Suggested corrections. Untick the ones to keep as they are.'),
      h('div.kbd-scroll', h('table.vg-table', h('thead', h('tr', h('th', h('span.sr-only', 'Accept')), h('th', 'Where'), h('th', 'Now'), h('th', 'Corrected'))), h('tbody', rows.map(({ f, it, cb }) => h('tr', h('td', cb), h('td.muted', it.where), h('td', it.text), h('td', h('strong', f.corrected))))))),
    ),
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Apply', primary: true, value: true },
    ],
  });
  if (!ok) return;
  const chosen = rows.filter((r) => r.cb.checked);
  app.commit('Check spelling', () => chosen.forEach(({ f, it }) => doc.has(it.id) && doc.update(it.id, { [it.field]: f.corrected })));
  toast(`Corrected ${chosen.length} text${chosen.length === 1 ? '' : 's'}.`, { kind: 'success' });
}
