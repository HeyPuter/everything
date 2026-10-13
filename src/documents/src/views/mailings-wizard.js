/**
 * The Step-by-Step Mail Merge pane: six steps from choosing the kind of document to finishing the
 * merge, each offering the commands for that step and a short explanation. It drives the same
 * Mailings controller (`mm`) as the ribbon.
 */
import { el } from '../ui/dom.js';
import { radios, button } from './mailings-ui.js';
import { DOCUMENT_TYPES } from '../engine/docx-mail-merge.js';

const STEPS = ['Document type', 'Starting document', 'Recipients', 'Write', 'Preview', 'Complete'];

export function createWizard(mm) {
  let step = 0, shown = false;
  const title = el('h2', {}, 'Mail Merge');
  const progress = el('ol.mm-steps', { 'aria-label': 'Steps' });
  const content = el('div.mm-step-body');
  const back = button('Back', () => go(step - 1), 'btn-ghost');
  const next = button('Next', () => go(step + 1), 'btn-primary');
  const pane = el('aside.mm-pane', { 'aria-label': 'Mail Merge', hidden: true },
    el('div.canvas-panel-heading', {}, title, el('button.icon-btn', { type: 'button', 'aria-label': 'Close Mail Merge pane', onclick: () => hide() }, '✕')),
    progress, content, el('div.mm-pane-foot', {}, back, next));
  pane.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); hide(); } });

  const section = (heading, ...children) => el('section.mm-step-section', {}, el('h3', {}, heading), ...children);
  const action = (label, run, attrs = {}) => button(label, run, 'btn-outline mm-step-action', attrs);
  const para = text => el('p.mm-step-text', {}, text);

  function body() {
    const state = mm.state(), records = mm.records(), type = state.type;
    const typeName = DOCUMENT_TYPES.find(t => t[0] === type)?.[1] || 'Letters';
    switch (step) {
      case 0: {
        const choice = radios('Document type', DOCUMENT_TYPES.map(([id, label]) => [id, label, {
          formLetters: 'Personalized letters, one for each recipient.', email: 'One email message for each recipient.', envelopes: 'Addressed envelopes for a mailing.',
          mailingLabels: 'Address labels, several to a sheet.', catalog: 'One document listing every recipient, such as a directory.' }[id]]), type || 'formLetters', value => mm.startMerge(value, { quiet: true }));
        return [section('What are you creating?', choice)];
      }
      case 1: return [section('Starting document',
        para(type === 'mailingLabels' ? 'Labels are laid out as a table, one label per cell. Choose a label sheet to set up a new labels document, or keep this one if it is already a label sheet.'
          : type === 'envelopes' ? 'Envelopes use a page the size of the envelope. Choose a size to set this document up as an envelope.'
            : `This document is the ${typeName.toLowerCase()} template. Type the text every recipient shares, then add fields for what changes.`),
        type === 'mailingLabels' ? action('Label Options…', () => mm.startMerge('mailingLabels')) : null,
        type === 'envelopes' ? action('Envelope Options…', () => mm.startMerge('envelopes')) : null)];
      case 2: return [section('Select recipients',
        para(records.length ? `${records.length} ${records.length === 1 ? 'recipient is' : 'recipients are'} selected${state.source?.name ? ` from ${state.source.name}` : ''}. The list is saved inside this document.` : 'Type a new list, or use a spreadsheet or comma-separated file you already have.'),
        state.external && !state.list ? para(`This document was linked to ${state.external}, which cannot be opened here. Choose a list to use instead.`) : null,
        action('Type a New List…', () => mm.typeNewList()),
        action('Use an Existing List…', () => mm.useExistingList()),
        state.list ? action('Edit Recipient List…', () => mm.editRecipients()) : null)];
      case 3: return [section('Write your document',
        para(type === 'mailingLabels' ? 'Arrange the first label, then update the others to match it.' : 'Click where each item belongs, then insert it.'),
        action('Address Block…', () => mm.addressBlock()), action('Greeting Line…', () => mm.greetingLine()),
        action('Insert Merge Field…', () => mm.insertFieldDialog()), action('Match Fields…', () => mm.matchFields()),
        type === 'mailingLabels' ? action('Update All Labels', () => mm.updateLabels()) : null)];
      case 4: {
        const status = records.length ? `Recipient ${Math.min(state.activeRecord || 1, records.length)} of ${records.length}` : 'No recipients selected';
        return [section('Preview',
          para(records.length ? 'Fields show this recipient’s details. Move through the list to check each one.' : 'Select recipients to preview them here.'),
          el('div.mm-nav', {}, button('◀', () => mm.goToRecord((state.activeRecord || 1) - 1), 'btn-ghost', { 'aria-label': 'Previous recipient', disabled: !records.length || (state.activeRecord || 1) <= 1 }),
            el('span.mm-nav-label', { role: 'status' }, status),
            button('▶', () => mm.goToRecord((state.activeRecord || 1) + 1), 'btn-ghost', { 'aria-label': 'Next recipient', disabled: !records.length || (state.activeRecord || 1) >= records.length })),
          action('Find a Recipient…', () => mm.findRecipient(), { disabled: !records.length }),
          action('Leave Out This Recipient', () => mm.excludeCurrent(), { disabled: !records.length }),
          action('Edit Recipient List…', () => mm.editRecipients(), { disabled: !state.list }))];
      }
      default: return [section('Complete the merge',
        para('Merge to a new document to review or edit each copy, print them, or send them by email.'),
        action('Edit Individual Documents…', () => mm.finish('document'), { disabled: !records.length }),
        action('Print…', () => mm.finish('print'), { disabled: !records.length }),
        type === 'email' ? action('Send Email Messages…', () => mm.finish('email'), { disabled: !records.length }) : null,
        action('Check for Errors…', () => mm.checkErrors()))];
    }
  }
  function render() {
    if (!shown) return;
    progress.replaceChildren(...STEPS.map((name, i) => el('li', { class: i === step ? 'is-current' : i < step ? 'is-done' : '', 'aria-current': i === step ? 'step' : null },
      el('button', { type: 'button', onclick: () => go(i) }, el('span.mm-step-number', {}, String(i + 1)), el('span', {}, name)))));
    const focused = pane.contains(document.activeElement) ? document.activeElement?.textContent : null;
    content.replaceChildren(el('p.mm-step-count', {}, `Step ${step + 1} of ${STEPS.length}`), ...body().flat().filter(Boolean));
    back.disabled = step === 0; next.textContent = step === STEPS.length - 1 ? 'Done' : 'Next';
    if (focused) [...content.querySelectorAll('button')].find(b => b.textContent === focused)?.focus();
  }
  function go(to) {
    if (to >= STEPS.length) { hide(); return; }
    step = Math.max(0, to);
    if (step === 0 && !mm.state().type) mm.startMerge('formLetters', { quiet: true });
    if (step === 4) mm.setPreview(true);
    render();
    content.querySelector('button, input')?.focus({ preventScroll: true });
  }
  function show() { shown = true; pane.hidden = false; if (!mm.state().type) mm.startMerge('formLetters', { quiet: true }); render(); content.querySelector('button, input')?.focus(); mm.layoutChanged?.(); }
  function hide() { shown = false; pane.hidden = true; mm.layoutChanged?.(); mm.focusDocument?.(); }
  return { pane, show, hide, toggle: () => (shown ? hide() : show()), refresh: render, get shown() { return shown; } };
}
