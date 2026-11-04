/**
 * Automate ▸ All Scripts: every script within reach in one place, the workbook's own, the user's (My Scripts,
 * kept on their drive and usable in any workbook) and the samples, each with what can be done with it. And the
 * script reference: the API a script is given, as the Code Editor's completions describe it.
 */
import { el, fieldId } from './dom.js';
import { icon } from './icons.js';
import { openModal, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { SAMPLE_SCRIPTS, sampleName, sampleDescription } from '../core/scripts.js';
import { SCRIPT_API } from '../core/script-api-docs.js';
import { t, tRich } from '../i18n/index.js';

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
  const search = el('input.input.sg-search', { type: 'search', placeholder: t('scriptGallery.search'), 'aria-label': t('scriptGallery.search'), spellcheck: false });
  const body = el('div.sg-body');
  const card = ({ name, about, glyph, buttons }) => el('article.sg-card', { 'aria-label': name },
    el('div.sg-card-head', {}, el('span.sg-card-icon', { html: icon(glyph, 20) }), el('h4.sg-card-name', {}, name)),
    el('p.sg-card-about', {}, about || t('scriptGallery.noDescription')),
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
      buttons: [button(t('scriptGallery.run'), () => { modal.close(); actions.run({ name: s.name, code: s.code, source: 'workbook', id: s.id }); }, true),
        button(t('common.edit'), () => { modal.close(); actions.open(s.id); })],
    }));
    // A script listed may be gone by the time it is asked for (deleted or renamed from another window, or the network
    // lost): that is said, rather than the gallery closing on nothing.
    const read = async (s) => {
      try { return await actions.library.read(s.path); } catch (e) { toast(t('scriptGallery.libraryReadFailed', { name: s.name, reason: String(e?.message || e) }), { icon: 'alert' }); return null; }
    };
    const lib = (library || []).filter((s) => hit(s.name, '')).map((s) => card({
      name: s.name, about: t('scriptGallery.inMyScripts'), glyph: 'scriptLibrary',
      buttons: [button(t('scriptGallery.run'), async () => { modal.close(); const code = await read(s); if (code != null) actions.run({ name: s.name, code, source: 'library' }); }, true),
        button(t('scriptGallery.addToWorkbook'), async () => { modal.close(); const code = await read(s); if (code != null) actions.add({ name: s.name, code }); }),
        button(t('common.delete'), async () => {
          if (!await confirmDialog({ title: t('scriptGallery.deleteTitle'), message: t('scriptGallery.deleteFromLibrary', { name: s.name }), confirmLabel: t('common.delete') })) return;
          try { await actions.library.remove(s.path); library = library.filter((x) => x !== s); render(); toast(t('scriptGallery.deleted', { name: s.name }), { icon: 'trash' }); } catch (e) { toast(t('scriptGallery.deleteFailed', { reason: String(e?.message || e) }), { icon: 'alert' }); }
        })],
    }));
    // Found by the name and description shown, and by the English ones too.
    const samples = SAMPLE_SCRIPTS.filter((s) => hit(`${sampleName(s)} ${s.name}`, `${sampleDescription(s)} ${s.description}`)).map((s) => card({
      name: sampleName(s), about: sampleDescription(s), glyph: 'scriptSample',
      buttons: [button(t('scriptGallery.run'), () => { modal.close(); actions.run({ name: sampleName(s), code: s.code, source: 'sample' }); }, true),
        button(t('scriptGallery.addToWorkbook'), () => { modal.close(); actions.add({ name: s.name, code: s.code, description: s.description }); })],
    }));
    const head = el('div.sg-section-actions', {},
      el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => { modal.close(); actions.newScript(); } }, el('span', { html: icon('plus', 14) }), el('span', {}, t('scriptGallery.newScript'))),
      el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => { modal.close(); actions.record(); } }, el('span', { html: icon('recordActions', 14) }), el('span', {}, t('scriptGallery.recordActions'))));
    body.replaceChildren(
      section(t('scriptGallery.inThisWorkbook'), mine, q ? t('scriptGallery.noWorkbookMatch') : t('scriptGallery.workbookEmpty'), head),
      actions.library ? section(t('scriptGallery.myScripts'), lib, library == null ? t('common.loading') : libraryError ? t('scriptGallery.libraryUnreadable', { reason: libraryError }) : q ? t('scriptGallery.noLibraryMatch') : t('scriptGallery.libraryEmpty')) : null,
      section(t('scriptGallery.samples'), samples, t('scriptGallery.noSampleMatch')));
  }
  search.addEventListener('input', render);
  const content = el('div.sg', {}, el('div.sg-top', {}, search), body);
  const modal = openModal({ title: t('scriptGallery.title'), content, wide: true, className: 'sg-modal', initialFocus: search });
  render();
  if (actions.library) {
    actions.library.list().then((list) => { library = list; render(); }, (e) => { library = []; libraryError = e?.message || t('scriptGallery.unavailable'); render(); });
  }
  return modal;
}

/** Reduced motion, asked for by the system or in Options: a script's smooth scroll overrides the stylesheet's, so it is checked here. */
const lessMotion = () => document.documentElement.classList.contains('reduce-motion')
  || !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The script reference: an introduction, then each object's methods. */
export function openScriptReference() {
  const toc = el('nav.sr-toc', { 'aria-label': t('scriptGallery.reference.objects') });
  const sections = Object.entries(SCRIPT_API).map(([owner, methods]) => {
    const id = fieldId(`sr-${owner}`);
    toc.append(el('a.sr-toc-link', { href: `#${id}`, onclick: (e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: lessMotion() ? 'auto' : 'smooth' }); } }, owner));
    return el('section.sr-section', { id, 'aria-label': owner },
      el('h3.sr-owner', {}, owner),
      el('dl.sr-list', {}, ...methods.flatMap(([name, sig, doc, flags]) => [
        el('dt.sr-name', {}, el('code', {}, `${name}${sig}`), flags === 'async' ? el('span.sr-badge', { title: t('scriptGallery.reference.awaitBadge') }, 'await') : null),
        el('dd.sr-doc', {}, doc),
      ])));
  });
  const intro = el('div.sr-intro', {},
    el('p', {}, ...tRich('scriptGallery.reference.intro', { code: (c) => el('code', {}, c) })),
    el('p', {}, ...tRich('scriptGallery.reference.addresses', { code: (c) => el('code', {}, c) })),
    el('pre.sr-example', {}, `async function main(workbook) {
  const sheet = workbook.getActiveWorksheet();
  const values = await sheet.getRange("A1:A10").getValues();
  const total = values.flat().filter((v) => typeof v === "number").reduce((a, b) => a + b, 0);
  sheet.getRange("B1").setValue(total);
  sheet.getRange("B1").getFormat().getFont().setBold(true);
  console.log("Total:", total);
}`));
  openModal({ title: t('scriptGallery.reference.title'), content: el('div.sr', {}, toc, el('div.sr-body', {}, intro, ...sections)), wide: true, className: 'sr-modal' });
}
