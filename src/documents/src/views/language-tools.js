/**
 * Language: mark text's proofing language (§17.3.2.20 lang) or exclude it from proofing
 * (§17.3.2.21 noProof), set the document's default language, and translate the selection or the
 * whole document with Puter's AI into a pane (with Insert) or a new document.
 */
import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import * as P from '../lib/puter.js';
import { translateParagraphs } from '../lib/proofing-ai.js';
import { LANGUAGES, languageName, englishLanguageName, sidePane, button, hint, preference } from './review-ui.js';

export const DETECT_LANGUAGE = preference('documents:detect-language', true);
export const TRANSLATION_LANGUAGE = preference('documents:translation-language', (typeof navigator !== 'undefined' && navigator.language && !/^en\b/i.test(navigator.language)) ? navigator.language : 'es-ES');

function languageSelect(value, label) {
  const tags = [...new Set([...(value ? [value] : []), ...LANGUAGES])];
  return el('select.input', { 'aria-label': label }, ...tags.map(tag => el('option', { value: tag, selected: tag === value }, languageName(tag))));
}

/** The Language dialog for the selection. apply({ language, noProof }) and setDefault(language). */
export function openLanguageDialog({ language, noProof, defaultLanguage, apply, setDefault, onClose }) {
  const filter = el('input.input', { type: 'search', placeholder: 'Find a language', 'aria-label': 'Find a language' });
  const options = [...new Set([...(language ? [language] : []), ...LANGUAGES])];
  let chosen = language || defaultLanguage || 'en-US';
  const list = el('div.rv-language-list', { role: 'listbox', 'aria-label': 'Languages' });
  const render = () => {
    const query = filter.value.trim().toLowerCase();
    list.replaceChildren(...options.filter(tag => !query || languageName(tag).toLowerCase().includes(query) || tag.toLowerCase().includes(query)).map(tag => el('button.rv-language', {
      type: 'button', role: 'option', 'aria-selected': String(tag === chosen), dataset: { tag },
      onclick: () => { chosen = tag; render(); }, ondblclick: () => { chosen = tag; submit(); } }, el('span', {}, languageName(tag)), el('span.rv-language-tag', {}, tag === defaultLanguage ? `${tag} · default` : tag))));
  };
  filter.addEventListener('input', render);
  const skip = el('input', { type: 'checkbox', checked: !!noProof });
  const detect = el('input', { type: 'checkbox', checked: DETECT_LANGUAGE.get(), onchange: () => DETECT_LANGUAGE.set(detect.checked) });
  const submit = () => { modal.close(); apply({ language: chosen, noProof: skip.checked }); };
  render();
  const modal = openModal({ title: 'Language', onClose, content: el('form.ed-dialog-body.rv-language-dialog', { onsubmit: e => { e.preventDefault(); submit(); } },
    el('p.field-hint', {}, 'Mark the selected text as:'),
    filter, list,
    el('label.rv-check', {}, skip, 'Do not check spelling or grammar'),
    el('label.rv-check', {}, detect, 'Detect language automatically'),
    hint('Spelling is checked against English. Text marked in another language, or written in another script while detection is on, is skipped.'),
    el('div.modal-actions', {},
      el('button.btn.btn-ghost', { type: 'button', onclick: () => { setDefault(chosen); toast(`Default language: ${languageName(chosen)}`); } }, 'Set As Default'),
      el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'),
      el('button.btn.btn-primary', { type: 'submit' }, 'OK'))) });
  queueMicrotask(() => list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }));
  return modal;
}

/** The Translator pane. */
export function createTranslatePane({ editor, pkg, error, openDocument, documentName }) {
  let busy = null, result = null;
  const pane = sidePane({ title: 'Translator', label: 'Translator pane', className: 'rv-translate-pane', onClose: () => { busy?.abort(); editor()?.focus(); } });
  const source = el('p.rv-translate-source');
  const target = languageSelect(TRANSLATION_LANGUAGE.get(), 'Translate into');
  target.addEventListener('change', () => TRANSLATION_LANGUAGE.set(target.value));
  const status = el('p.rv-status', { role: 'status' });
  const output = el('div.rv-translation', { 'aria-live': 'polite' });
  const insert = button('Insert', () => insertResult(), { primary: true, disabled: true });
  const copy = button('Copy', () => { if (result) navigator.clipboard?.writeText(result.text).then(() => toast('Translation copied')).catch(error); }, { disabled: true });
  const translate = button('Translate', () => run(), { primary: true });
  const wholeDocument = button('Translate document…', () => translateDocument());
  pane.body.append(
    el('label.field', {}, el('span.field-label', {}, 'Translate into'), target),
    source, el('div.rv-actions', {}, translate, wholeDocument), status, output, el('div.rv-actions', {}, insert, copy),
    hint('Translation uses Puter AI: the selected text, or the whole document, is sent when you choose Translate.'));

  const selection = () => {
    const engine = editor(); if (!engine) return null;
    const [a, b] = engine.model.range;
    return a === b ? null : { start: a, end: b, text: engine.model.text.slice(a, b), path: engine.session.path };
  };
  function describe() {
    const chosen = selection();
    source.textContent = chosen ? `Selection: “${chosen.text.slice(0, 120)}${chosen.text.length > 120 ? '…' : ''}”` : 'Select text to translate it here, or translate the whole document into a new one.';
    translate.disabled = !chosen || !P.canUseAi() || !!busy;
    wholeDocument.disabled = !P.canUseAi() || !!busy;
    if (!P.canUseAi()) status.textContent = 'Translation needs Puter AI. Open this document in Puter to translate.';
  }
  async function run() {
    const chosen = selection(); if (!chosen) return;
    busy?.abort(); busy = new AbortController();
    const signal = busy.signal;
    status.textContent = 'Translating…'; output.replaceChildren(); insert.disabled = copy.disabled = true; describe();
    try {
      const paragraphs = await translateParagraphs(chosen.text.split('\n'), englishLanguageName(target.value), { chat: prompt => P.aiChat(prompt), signal });
      if (signal.aborted) return;
      result = { ...chosen, original: chosen.text, text: paragraphs.join('\n') };
      output.replaceChildren(...paragraphs.map(text => el('p', {}, text)));
      status.textContent = `Translated into ${languageName(target.value)}.`;
      insert.disabled = !!pkg()?.readOnly; copy.disabled = false;
    } catch (e) { if (!signal.aborted) status.textContent = e.message; }
    finally { if (busy?.signal === signal) busy = null; describe(); }
  }
  function insertResult() {
    const engine = editor(); if (!engine || !result) return;
    engine.finishComposition();
    const { start, end } = result;
    if (engine.session.path !== result.path || engine.model.text.slice(start, end) !== result.original) { error(new Error('The selected text changed. Translate it again.')); return; }
    // The translation is marked in its language (§17.3.2.20), so proofing treats it as such.
    engine.execute(() => {
      engine.model.select(start, end); engine.model.replace(result.text);
      const after = engine.model.range[1];
      engine.model.select(after - result.text.length, after); engine.model.setRunFormat({ fontLanguage: target.value });
      engine.model.select(after);
    });
    engine.focus();
  }
  async function translateDocument() {
    const engine = editor(); if (!engine) return;
    const body = engine.session.body;
    const plain = p => p.runs.every(r => !r.image && !r.math && !r.field && !r.noteMark && !r.contentControl && !r.bodySymbol) && !p.fieldMarkers?.length;
    const texts = body.paragraphs.map(p => plain(p) ? p.runs.filter(r => r.revision?.type !== 'del').map(r => r.text).join('') : '');
    busy?.abort(); busy = new AbortController();
    const signal = busy.signal;
    status.textContent = 'Translating the document…'; describe();
    try {
      const translated = await translateParagraphs(texts, englishLanguageName(target.value), { chat: prompt => P.aiChat(prompt), signal, onProgress: share => { status.textContent = `Translating the document… ${Math.round(share * 100)}%`; } });
      if (signal.aborted) return;
      const paragraphs = body.paragraphs.map((p, i) => {
        if (!texts[i].trim()) return p;
        const first = p.runs.find(r => r.text && r.revision?.type !== 'del') || p.runs[0];
        const run = { ...structuredClone(first), text: translated[i] };
        delete run.revision; delete run.formatRevision; delete run.link;
        const length = translated[i].length;
        const out = { ...structuredClone(p), runs: [run] };
        delete out.markRevision; delete out.formatRevision;
        if (out.bookmarks) out.bookmarks = out.bookmarks.map(m => ({ ...m, offset: Math.min(m.offset, length + (m.blockBoundary === 'after' ? 1 : 0)) }));
        return out;
      });
      const blob = pkg().export(paragraphs, body.pageSettings, body.numbering, body.styles, body.tables, body.assets, undefined, body.comments);
      const name = `${(documentName() || 'Document').replace(/\.docx$/i, '')} (${languageName(target.value)}).docx`;
      status.textContent = 'Translated. Opening the new document…';
      await openDocument(new File([blob], name, { type: P.DOCX_MIME }));
    } catch (e) { if (!signal.aborted) { status.textContent = e.message; error(e); } }
    finally { if (busy?.signal === signal) busy = null; describe(); }
  }
  return {
    pane,
    open() { pane.open(); describe(); },
    selectionChanged() { if (pane.isOpen && !busy) describe(); },
    destroy() { busy?.abort(); pane.destroy(); },
  };
}
