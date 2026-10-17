import { el } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { paragraphText } from '../engine/model.js';

const KINDS = [['page', 'Page'], ['line', 'Line'], ['bookmark', 'Bookmark'], ['heading', 'Heading'], ['table', 'Table'], ['graphic', 'Graphic']];

/** Document positions of each target kind, in reading order: [{ position, label }]. */
export function goToTargets(engine, kind) {
  const body = engine.session.body, lines = engine.layout.lines.filter(line => !line.virtual && !line.pageStory);
  if (kind === 'page') {
    // A page without body text (a full-page picture) goes to where the text before it ends.
    const first = new Map();
    for (const line of lines) if (!first.has(line.page)) first.set(line.page, line.start);
    let last = 0;
    return Array.from({ length: engine.layout.pageCount }, (_, i) => { if (first.has(i)) last = first.get(i); return { position: last, label: `Page ${i + 1}` }; });
  }
  if (kind === 'line') return lines.map((line, i) => ({ position: line.start, label: `Line ${i + 1}` }));
  if (kind === 'bookmark') return engine.bookmarks.map(b => ({ position: b.start, label: b.name, id: b.id }));
  if (kind === 'heading') return engine.outline.map(entry => ({ position: entry.start, label: entry.text }));
  const out = [];
  let at = 0, inTable = false;
  for (const p of body.paragraphs) {
    if (kind === 'table') { if (p.cellId && !inTable) out.push({ position: at, label: `Table ${out.length + 1}` }); inTable = !!p.cellId; }
    if (kind === 'graphic') {
      let offset = at;
      for (const run of p.runs) { if (run.image) out.push({ position: offset, label: `Graphic ${out.length + 1}` }); offset += run.text.length; }
    }
    at += paragraphText(p).length + 1;
  }
  return out;
}

/**
 * Go To: choose a kind of target, then a number (or +n / −n from the current one), or step
 * with Previous and Next. Bookmarks are chosen by name.
 */
export function openGoTo(engine, { onClose } = {}) {
  const kind = el('select.input', { 'aria-label': 'Go to what', size: 6 }, ...KINDS.map(([value, label]) => el('option', { value }, label)));
  kind.value = 'page';
  const label = el('span.field-label');
  const number = el('input.input', { type: 'text', autocomplete: 'off' });
  const names = el('select.input');
  const numberField = el('label.field', {}, label, number);
  const nameField = el('label.field', { style: { display: 'none' } }, el('span.field-label', {}, 'Enter bookmark name'), names);
  const hint = el('p.field-hint');
  const message = el('p.field-error', { role: 'alert', hidden: true });
  const previous = el('button.btn.btn-outline', { type: 'button', onclick: () => step(-1) }, 'Previous');
  const next = el('button.btn.btn-primary', { type: 'submit' }, 'Next');
  const current = () => engine.model.range[0];
  function refresh() {
    const name = KINDS.find(([value]) => value === kind.value)[1];
    const bookmark = kind.value === 'bookmark';
    // Field classes set their own display, so the unused field is hidden by style rather than [hidden].
    numberField.style.display = bookmark ? 'none' : ''; nameField.style.display = bookmark ? '' : 'none';
    previous.style.display = bookmark ? 'none' : '';
    label.textContent = `Enter ${name.toLowerCase()} number`;
    if (bookmark) names.replaceChildren(...goToTargets(engine, 'bookmark').map(b => el('option', { value: b.id }, b.label)));
    hint.textContent = bookmark ? '' : `Enter + and − to move relative to the current location. Example: +4 will move forward four items.`;
    next.textContent = bookmark || number.value.trim() ? 'Go To' : 'Next';
    message.hidden = true;
  }
  function land(position) {
    engine.finishComposition();
    if (engine.session.path !== null) engine.editStory(null);
    engine.model.select(position);
    engine.caretAffinity = 'forward'; engine.caretPage = null; engine.preferredX = null;
    engine.syncInput(); engine.paint(); engine.revealCaret(); engine.onSelection();
  }
  const fail = text => { message.textContent = text; message.hidden = false; };
  function step(direction) {
    const targets = goToTargets(engine, kind.value), here = current();
    const index = targets.findLastIndex(t => t.position <= here);
    const target = direction > 0 ? targets.find(t => t.position > here) : targets[index] && targets[index].position < here ? targets[index] : targets[index - 1];
    if (!target) { fail(`There is no ${direction > 0 ? 'next' : 'previous'} ${kind.selectedOptions[0].textContent.toLowerCase()}.`); return; }
    land(target.position); message.hidden = true;
  }
  function go() {
    if (kind.value === 'bookmark') {
      if (!names.value) { fail('This document has no bookmarks.'); return; }
      engine.goToBookmark(names.value); modal.close(); return;
    }
    const value = number.value.trim();
    if (!value) { step(1); return; }
    const match = /^([+-]?)(\d+)$/.exec(value.replace('−', '-'));
    if (!match) { fail('Enter a number, or + or − followed by a number.'); return; }
    const targets = goToTargets(engine, kind.value), n = Number(match[2]);
    let index;
    if (match[1]) {
      // Before the first target, +1 is the first one.
      const here = targets.findLastIndex(t => t.position <= current());
      index = here + (match[1] === '+' ? n : -n);
    } else index = n - 1;
    const target = targets[index];
    if (!target) { fail(targets.length ? `This document has ${targets.length} ${kind.selectedOptions[0].textContent.toLowerCase()}${targets.length === 1 ? '' : 's'}.` : `This document has no ${kind.selectedOptions[0].textContent.toLowerCase()}s.`); return; }
    land(target.position); modal.close();
  }
  kind.addEventListener('change', refresh); number.addEventListener('input', refresh);
  const form = el('form.ed-dialog-body.ed-goto', { onsubmit: e => { e.preventDefault(); go(); } },
    el('div.ed-goto-grid', {},
      el('label.field', {}, el('span.field-label', {}, 'Go to what'), kind),
      el('div', {}, numberField, nameField, hint)),
    message,
    el('div.row.row-end', {}, previous, next, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Close')));
  const modal = openModal({ title: 'Go To', content: form, onClose });
  refresh();
  number.focus();
  return modal;
}
