/**
 * Compare Documents and Combine Documents. The reader picks an original and a revised document
 * (this one, a file from the device, or one from Puter); the result is a new document whose
 * differences are tracked changes, shown first beside both sources and then opened or downloaded.
 */
import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import * as P from '../lib/puter.js';
import { engineApi } from '../lib/engine-api.js';
import { hint, preference } from './review-ui.js';

const OPTIONS = preference('documents:compare-options', { granularity: 'word', formatting: true, caseChanges: true, whiteSpace: true, tables: true });

const visible = run => run.revision?.type !== 'del';
const plainText = p => p.runs.filter(visible).map(r => r.text).join('').replace(/￼/g, '');

/** A column of paragraphs; the compared column shows marks. */
function column(title, paragraphs, marked = false) {
  return el('section.rv-compare-column', { 'aria-label': title }, el('h3', {}, title),
    el('div.rv-compare-scroll', { tabIndex: 0 }, ...paragraphs.map(p => el('p', {}, ...(marked ? p.runs.map(run => {
      const text = run.text.replace(/￼/g, '▫');
      if (run.revision?.type === 'ins') return el(run.revision.move ? 'ins.is-move' : 'ins', { title: `Inserted by ${run.revision.author}` }, text);
      if (run.revision?.type === 'del') return el(run.revision.move ? 'del.is-move' : 'del', { title: `Deleted by ${run.revision.author}` }, text);
      if (run.formatRevision) return el('span.rv-formatted', { title: 'Formatting changed' }, text);
      return text;
    }) : [plainText(p) || ' '])))));
}

export function openCompareDialog({ mode = 'compare', editor, pkg, documentName, author, openDocument, currentBytes, error }) {
  const combine = mode === 'combine';
  const sources = { original: null, revised: null };
  const options = OPTIONS.get();
  const slot = (key, label) => {
    const name = el('span.rv-source-name', {}, 'Not chosen');
    const fileInput = el('input', { type: 'file', accept: '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document', hidden: true, onchange: () => {
      const file = fileInput.files?.[0]; fileInput.value = '';
      if (file) choose(key, { name: file.name, read: async () => new Uint8Array(await file.arrayBuffer()) });
    } });
    const choose = (k, source) => { sources[k] = source; name.textContent = source.name; refresh(); };
    const current = () => {
      choose(key, { name: `${documentName() || 'This document'} (open now)`, current: true, read: currentBytes });
    };
    const fromPuter = async () => {
      const picked = await P.pickFile({ accept: ['.docx'] });
      if (picked) choose(key, { name: picked.name, read: async () => new Uint8Array(await (await P.readFile(picked.path)).arrayBuffer()) });
    };
    return { fileInput, current, node: el('fieldset.rv-fieldset.rv-source', {}, el('legend', {}, label), name,
      el('div.rv-actions', {},
        el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: current }, 'This document'),
        el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: () => fileInput.click() }, 'From device…'),
        P.canPickFiles() ? el('button.btn.btn-outline.btn-sm', { type: 'button', onclick: fromPuter }, 'From Puter…') : null), fileInput) };
  };
  const original = slot('original', 'Original document'), revised = slot('revised', 'Revised document');
  const label = el('input.input', { value: '', placeholder: combine ? 'Author of the revised copy' : 'Author of the revised document', 'aria-label': 'Label changes with' });
  const check = (key, text) => { const input = el('input', { type: 'checkbox', checked: options[key] !== false, onchange: () => { options[key] = input.checked; OPTIONS.set(options); } }); return el('label.rv-check', {}, input, text); };
  const granularity = el('select.input', { 'aria-label': 'Show changes at', onchange: () => { options.granularity = granularity.value; OPTIONS.set(options); } },
    el('option', { value: 'word', selected: options.granularity !== 'character' }, 'Word level'), el('option', { value: 'character', selected: options.granularity === 'character' }, 'Character level'));
  const status = el('p.field-error', { role: 'alert', hidden: true });
  const run = el('button.btn.btn-primary', { type: 'submit' }, combine ? 'Combine' : 'Compare');
  function refresh() { run.disabled = !sources.original || !sources.revised; }
  const content = el('form.ed-dialog-body.rv-compare-dialog', { onsubmit: async e => {
    e.preventDefault();
    status.hidden = true; run.disabled = true; run.textContent = 'Working…';
    try { await compare(); modal.close(); }
    catch (err) { status.textContent = err.message || 'The documents could not be compared.'; status.hidden = false; }
    finally { run.textContent = combine ? 'Combine' : 'Compare'; refresh(); }
  } },
    original.node, revised.node,
    el('label.field', {}, el('span.field-label', {}, combine ? 'Label unmarked changes with' : 'Label changes with'), label),
    el('details.rv-more', { open: false }, el('summary', {}, 'More options'),
      el('label.field', {}, el('span.field-label', {}, 'Show changes at'), granularity),
      el('div.rv-checks', {}, check('formatting', 'Formatting'), check('caseChanges', 'Case changes'), check('whiteSpace', 'White space'), check('tables', 'Tables')),
      hint(combine ? 'The result keeps the original document with its own changes and comments, and adds the revised copy\'s differences as tracked changes.' : 'The result is the revised document, with what changed since the original shown as tracked changes. Its comments are kept.')),
    status,
    el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), run));
  const modal = openModal({ title: combine ? 'Combine Documents' : 'Compare Documents', content, wide: true });
  if (editor() && pkg()) (combine ? original : revised).current();
  refresh();

  async function compare() {
    const api = engineApi(); if (!api) throw new Error('The editor is still loading.');
    const [a, b] = await Promise.all([sources.original.read(), sources.revised.read()]);
    const [originalPkg, revisedPkg] = await Promise.all([api.DocxPackage.open(a), api.DocxPackage.open(b)]);
    if (originalPkg.readOnly || revisedPkg.readOnly) throw new Error('One of the documents uses features this editor can only display, so it cannot be compared.');
    const basePkg = combine ? originalPkg : revisedPkg, otherPkg = combine ? revisedPkg : originalPkg;
    const label2 = label.value.trim() || api.documentAuthor(revisedPkg.parts) || author() || 'Author';
    const result = api.mergeDocuments({ paragraphs: basePkg.paragraphs, tables: basePkg.tables }, { paragraphs: otherPkg.paragraphs, tables: otherPkg.tables }, {
      mode, author: label2, granularity: options.granularity, formatting: options.formatting !== false, caseChanges: options.caseChanges !== false, whiteSpace: options.whiteSpace !== false, tables: options.tables !== false,
      styleIds: new Set(Object.keys(basePkg.styles?.definitions || {})),
    });
    const blob = basePkg.export(result.paragraphs, basePkg.pageSettings, basePkg.numbering, basePkg.styles, result.tables, basePkg.assets, undefined, basePkg.comments);
    const stem = name => name.replace(/ \(open now\)$/, '').replace(/\.docx$/i, '');
    const name = combine ? `Combined ${stem(sources.original.name)}.docx` : `Compared ${stem(sources.original.name)} and ${stem(sources.revised.name)}.docx`;
    showResult({ result, originalPkg, revisedPkg, blob, name, label: label2 });
  }

  function showResult({ result, originalPkg, revisedPkg, blob, name, label: who }) {
    const { stats } = result;
    const columns = [column(`Original: ${sources.original.name}`, originalPkg.paragraphs), column(combine ? 'Combined' : 'Compared', result.paragraphs, true), column(`Revised: ${sources.revised.name}`, revisedPkg.paragraphs)];
    // The three columns scroll together.
    const scrollers = columns.map(c => c.querySelector('.rv-compare-scroll'));
    let syncing = false;
    for (const s of scrollers) s.addEventListener('scroll', () => {
      if (syncing) return; syncing = true;
      const share = s.scrollTop / Math.max(1, s.scrollHeight - s.clientHeight);
      for (const other of scrollers) if (other !== s) other.scrollTop = share * (other.scrollHeight - other.clientHeight);
      requestAnimationFrame(() => { syncing = false; });
    });
    const summary = el('p.rv-status', {}, `${stats.inserted.toLocaleString()} characters inserted, ${stats.deleted.toLocaleString()} deleted${stats.formatted ? `, ${stats.formatted} formatting changes` : ''}, labeled “${who}”.`);
    const view = openModal({ title: combine ? 'Combined Document' : 'Compared Document', wide: true, content: el('div.ed-dialog-body.rv-compare-result', {},
      summary, el('div.rv-compare-columns', {}, ...columns),
      el('div.modal-actions', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: () => P.downloadBlob(blob, name) }, 'Download'),
        el('button.btn.btn-primary', { type: 'button', onclick: async () => { view.close(); try { await openDocument(new File([blob], name, { type: P.DOCX_MIME })); } catch (e) { error(e); } } }, 'Open Document'))) });
  }
  return modal;
}
