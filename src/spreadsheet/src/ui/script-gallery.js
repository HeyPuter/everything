/**
 * Automate ▸ All Scripts: every script within reach in one place, the workbook's own, the user's (My Scripts,
 * kept on their drive and usable in any workbook) and the samples, each with what can be done with it. And the
 * script reference: the API a script is given, as the Code Editor's completions describe it.
 */
import { el, fieldId } from './dom.js';
import { icon } from './icons.js';
import { openModal, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { SAMPLE_SCRIPTS } from '../core/scripts.js';
import { SCRIPT_API } from '../core/script-api-docs.js';

/** The first sentence a script's leading comment says about it, for a card. */
export function scriptSummary(code) {
  const m = /^\s*\/\*\*?([\s\S]*?)\*\//.exec(code || '') || /^\s*\/\/(.*)/.exec(code || '');
  const text = (m?.[1] || '').replace(/^\s*\*\s?/gm, ' ').replace(/\s+/g, ' ').trim();
  return text.split(/(?<=\.)\s/)[0].slice(0, 160);
}

/**
 * actions: { open(id), run({ name, code, source }), add({ name, code }), library: { list(), read(path), remove(path) } | null,
 * newScript(), record() }.
 */
export function openScriptGallery(wb, actions) {
  const search = el('input.input.sg-search', { type: 'search', placeholder: 'Search scripts', 'aria-label': 'Search scripts', spellcheck: false });
  const body = el('div.sg-body');
  const card = ({ name, about, glyph, buttons }) => el('article.sg-card', { 'aria-label': name },
    el('div.sg-card-head', {}, el('span.sg-card-icon', { html: icon(glyph, 20) }), el('h4.sg-card-name', {}, name)),
    el('p.sg-card-about', {}, about || 'No description.'),
    el('div.sg-card-actions', {}, ...buttons.filter(Boolean)));
  const button = (label, fn, primary = false) => el(`button.btn.btn-sm${primary ? '.btn-primary' : '.btn-ghost'}`, { type: 'button', onclick: fn }, label);
  let library = null; // null while loading, [] when there is none
  let libraryError = null;

  const section = (title, cards, empty, extra = null) => el('section.sg-section', { 'aria-label': title },
    el('div.sg-section-head', {}, el('h3.sg-section-title', {}, title), extra),
    cards.length ? el('div.sg-grid', {}, ...cards) : el('p.sg-empty', {}, empty));

  function render() {
    const q = search.value.trim().toLowerCase();
    const hit = (name, about) => !q || `${name} ${about}`.toLowerCase().includes(q);
    const mine = (wb.scripts || []).filter((s) => hit(s.name, s.description || scriptSummary(s.code))).map((s) => card({
      name: s.name, about: s.description || scriptSummary(s.code), glyph: 'scriptFile',
      buttons: [button('Run', () => { modal.close(); actions.run({ name: s.name, code: s.code, source: 'workbook', id: s.id }); }, true),
        button('Edit', () => { modal.close(); actions.open(s.id); })],
    }));
    const lib = (library || []).filter((s) => hit(s.name, '')).map((s) => card({
      name: s.name, about: 'In My Scripts, on your drive.', glyph: 'scriptLibrary',
      buttons: [button('Run', async () => { modal.close(); actions.run({ name: s.name, code: await actions.library.read(s.path), source: 'library' }); }, true),
        button('Add to workbook', async () => { modal.close(); actions.add({ name: s.name, code: await actions.library.read(s.path) }); }),
        button('Delete', async () => {
          if (!await confirmDialog({ title: 'Delete Script', message: `Delete “${s.name}” from My Scripts? Workbooks that hold a copy keep it.`, confirmLabel: 'Delete' })) return;
          try { await actions.library.remove(s.path); library = library.filter((x) => x !== s); render(); toast(`Deleted ${s.name}`, { icon: 'trash' }); } catch (e) { toast(`Could not delete: ${e?.message || e}`, { icon: 'alert' }); }
        })],
    }));
    const samples = SAMPLE_SCRIPTS.filter((s) => hit(s.name, s.description)).map((s) => card({
      name: s.name, about: s.description, glyph: 'scriptSample',
      buttons: [button('Run', () => { modal.close(); actions.run({ name: s.name, code: s.code, source: 'sample' }); }, true),
        button('Add to workbook', () => { modal.close(); actions.add({ name: s.name, code: s.code, description: s.description }); })],
    }));
    const head = el('div.sg-section-actions', {},
      el('button.btn.btn-sm.btn-ghost', { type: 'button', html: `${icon('plus', 14)}<span>New Script</span>`, onclick: () => { modal.close(); actions.newScript(); } }),
      el('button.btn.btn-sm.btn-ghost', { type: 'button', html: `${icon('recordActions', 14)}<span>Record Actions</span>`, onclick: () => { modal.close(); actions.record(); } }));
    body.replaceChildren(
      section('In This Workbook', mine, q ? 'No scripts in this workbook match.' : 'This workbook has no scripts yet. Write one, record your actions, or add a sample.', head),
      actions.library ? section('My Scripts', lib, library == null ? 'Loading…' : libraryError ? `My Scripts could not be read: ${libraryError}` : q ? 'None of My Scripts match.' : 'Save a script to My Scripts (Code Editor ▸ More) to use it in any workbook.') : null,
      section('Samples', samples, 'No samples match.'));
  }
  search.addEventListener('input', render);
  const content = el('div.sg', {}, el('div.sg-top', {}, search), body);
  const modal = openModal({ title: 'All Scripts', content, wide: true, className: 'sg-modal', initialFocus: search });
  render();
  if (actions.library) {
    actions.library.list().then((list) => { library = list; render(); }, (e) => { library = []; libraryError = e?.message || 'unavailable'; render(); });
  }
  return modal;
}

/** The script reference: an introduction, then each object's methods. */
export function openScriptReference() {
  const toc = el('nav.sr-toc', { 'aria-label': 'Objects' });
  const sections = Object.entries(SCRIPT_API).map(([owner, methods]) => {
    const id = fieldId(`sr-${owner}`);
    toc.append(el('a.sr-toc-link', { href: `#${id}`, onclick: (e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); } }, owner));
    return el('section.sr-section', { id, 'aria-label': owner },
      el('h3.sr-owner', {}, owner),
      el('dl.sr-list', {}, ...methods.flatMap(([name, sig, doc, flags]) => [
        el('dt.sr-name', {}, el('code', {}, `${name}${sig}`), flags === 'async' ? el('span.sr-badge', { title: 'Returns a promise: await it' }, 'await') : null),
        el('dd.sr-doc', {}, doc),
      ])));
  });
  const intro = el('div.sr-intro', {},
    el('p', {}, 'A script is JavaScript with an ', el('code', {}, 'async function main(workbook)'), '. It runs apart from the app: it can change the workbook, and nothing else: not your files, your account or the internet. Everything it changes is one step that Undo takes back.'),
    el('p', {}, 'Rows and columns are counted from 0; addresses are A1 notation ("B2", "A1:C10", "A:C", "3:5"). Reading cells waits for the workbook: put ', el('code', {}, 'await'), ' before the methods marked await. Changes need no await.'),
    el('pre.sr-example', {}, `async function main(workbook) {
  const sheet = workbook.getActiveWorksheet();
  const values = await sheet.getRange("A1:A10").getValues();
  const total = values.flat().filter((v) => typeof v === "number").reduce((a, b) => a + b, 0);
  sheet.getRange("B1").setValue(total);
  sheet.getRange("B1").getFormat().getFont().setBold(true);
  console.log("Total:", total);
}`));
  openModal({ title: 'Script Reference', content: el('div.sr', {}, toc, el('div.sr-body', {}, intro, ...sections)), wide: true, className: 'sr-modal' });
}
