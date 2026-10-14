/**
 * Restrict Editing: formatting restrictions (allowed styles), editing restrictions (read only,
 * tracked changes, comments, filling in forms) with per-region exceptions for everyone or named
 * people, and enforcement with an optional password (documentProtection, §17.15.1.29; permStart/
 * permEnd, §17.13.7). Also Lock Tracking and the Always Open Read-Only recommendation.
 */
import { el } from '../ui/dom.js';
import { openModal, confirmDialog, promptDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { engineApi } from '../lib/engine-api.js';
import { sidePane, section, button, hint, preference, reveal } from './review-ui.js';

const EDIT_LABELS = { readOnly: 'No changes (Read only)', trackedChanges: 'Tracked changes', comments: 'Comments', forms: 'Filling in forms' };
const EXPLAIN = {
  readOnly: 'This document is protected from unintentional editing.',
  trackedChanges: 'This document is protected: all changes are tracked.',
  comments: 'This document is protected: you may only add comments.',
  forms: 'This document is protected: you may only fill in form fields.',
  none: 'Formatting in this document is restricted to the allowed styles.',
};
const EXTRA_EDITORS = preference('documents:restrict-editors', []);
const HIGHLIGHT = preference('documents:restrict-highlight', true);
const REGION_TINT = 'rgba(255, 214, 92, .32)', DRAFT_TINT = 'rgba(120, 160, 230, .22)';

/** Password and confirmation; resolves the password ('' for none) or null when cancelled. */
export function passwordDialog({ title, intro, confirmLabel = 'OK', requireMatch = true, allowEmpty = true, check }) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (!done) { done = true; resolve(value); } };
    const first = el('input.input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Password' });
    const second = el('input.input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Reenter password' });
    const problem = el('p.field-error', { role: 'alert', hidden: true });
    const confirm = el('button.btn.btn-primary', { type: 'submit' }, confirmLabel);
    const content = el('form.ed-dialog-body', { onsubmit: async e => {
      e.preventDefault();
      const value = first.value;
      const fail = message => { problem.textContent = message; problem.hidden = false; first.focus(); };
      if (!value && !allowEmpty) return fail('Enter the password.');
      if (requireMatch && value !== second.value) return fail('The passwords do not match.');
      if (check) {
        confirm.disabled = true; confirm.textContent = 'Checking…';
        // Let the button repaint before the hash runs.
        await new Promise(r => setTimeout(r, 30));
        const ok = await check(value).catch(err => { fail(err.message); return null; });
        confirm.disabled = false; confirm.textContent = confirmLabel;
        if (ok === null) return;
        if (!ok) return fail('The password is incorrect.');
      }
      finish(value); modal.close();
    } },
      intro ? el('p.field-hint', {}, intro) : null,
      el('label.field', {}, el('span.field-label', {}, requireMatch ? 'New password (optional)' : 'Password'), first),
      requireMatch ? el('label.field', {}, el('span.field-label', {}, 'Reenter password'), second) : null,
      problem,
      requireMatch ? hint('A password stops others from turning protection off by accident. It is not encryption: the document can still be read.') : null,
      el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), confirm));
    const modal = openModal({ title, content, onClose: () => finish(null) });
    first.focus();
  });
}

export function createRestrictEditing({ editor, pkg, error, author, onChange = () => {} }) {
  let readOnlyView = false; // Opened read-only as the author recommended: not saved in the file.
  const settings = () => pkg()?.reviewSettings || {};
  const protection = () => settings().protection || null;
  const enforced = () => !!protection()?.enforcement || readOnlyView;
  const user = () => ({ name: author() || '', email: author() || '' });
  const api = () => engineApi();
  const setSettings = patch => { const p = pkg(); if (!p) return; p.reviewSettings = { ...p.reviewSettings, ...patch }; editor()?.onChange?.(); };

  /** Install (or remove) the editor's guard for the current protection. */
  function applyGuard() {
    const engine = editor(); if (!engine || !api()) return;
    const active = readOnlyView ? { edit: 'readOnly', enforcement: true } : protection();
    engine.session.guard = api().protectionGuard(active && { ...active, lockedStyles: settings().lockedStyles || [] }, user(), { contentControlRanges: api().contentControlRanges });
    if (active?.enforcement && active.edit === 'trackedChanges' && !engine.session.body.trackChanges) { engine.session.body.trackChanges = true; engine.session.revision++; }
    onChange();
  }

  /* ---- The pane ---- */
  const pane = sidePane({ title: 'Restrict Editing', label: 'Restrict Editing pane', className: 'rv-restrict-pane', onOpen: () => { render(); queueMicrotask(onChange); }, onClose: () => { onChange(); editor()?.focus(); } });
  let draft = { formatting: false, edit: 'readOnly', editing: false };
  function syncDraft() {
    const p = protection();
    draft = { formatting: !!p?.formatting, editing: !!p && p.edit !== 'none', edit: p && p.edit !== 'none' ? p.edit : draft.edit || 'readOnly' };
  }
  const regions = () => { const engine = editor(); return engine && api() ? api().permissionRanges(engine.session.body.paragraphs) : []; };
  const myRegions = () => regions().filter(r => api().permissionApplies(r, user()));
  const editorsList = () => [...new Set([...EXTRA_EDITORS.get(), ...regions().map(r => r.ed).filter(Boolean)])];

  let renderedSignature = '';
  /** Rebuild the pane when what it shows changed (or when forced). */
  function render(force = true) {
    if (!pane.isOpen) return;
    const engine = editor();
    const signature = JSON.stringify([enforced(), protection(), settings().lockedStyles, regions(), engine?.model.range, engine?.session.path, editorsList(), !!pkg()?.readOnly, HIGHLIGHT.get()]);
    if (!force && signature === renderedSignature) return;
    renderedSignature = signature;
    const focused = pane.body.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') || document.activeElement.textContent : null;
    pane.body.replaceChildren(enforced() ? enforcedView() : setupView(engine));
    // Keep keyboard focus on the control that was focused before the rebuild.
    if (focused) [...pane.body.querySelectorAll('button, input, select')].find(n => (n.getAttribute('aria-label') || n.textContent) === focused || n.closest('label')?.textContent === focused)?.focus({ preventScroll: true });
  }

  function setupView(engine) {
    syncDraft();
    const readOnly = !!pkg()?.readOnly;
    const formattingBox = el('input', { type: 'checkbox', checked: draft.formatting, disabled: readOnly, onchange: () => { draft.formatting = formattingBox.checked; saveDraft(); } });
    const editingBox = el('input', { type: 'checkbox', checked: draft.editing, disabled: readOnly, onchange: () => { draft.editing = editingBox.checked; saveDraft(); render(); } });
    const kind = el('select.input', { 'aria-label': 'Type of editing allowed', disabled: !draft.editing || readOnly, onchange: () => { draft.edit = kind.value; saveDraft(); render(); } },
      ...Object.entries(EDIT_LABELS).map(([value, label]) => el('option', { value, selected: value === draft.edit }, label)));
    const [a, b] = engine?.model.range || [0, 0];
    const selectionRegions = regions().filter(r => r.start <= a && b <= r.end || a < r.end && b > r.start);
    const allows = who => selectionRegions.some(r => who === 'everyone' ? r.edGrp === 'everyone' : (r.ed || '').toLowerCase() === who.toLowerCase());
    const exceptionRow = (who, label) => {
      const box = el('input', { type: 'checkbox', checked: allows(who), disabled: readOnly || engine?.session.path !== null || a === b && !allows(who),
        onchange: () => toggleException(who, box.checked) });
      return el('label.rv-check', {}, box, label);
    };
    const exceptions = draft.editing && ['readOnly', 'comments'].includes(draft.edit) ? section('Exceptions (optional)',
      hint('Select parts of the document and choose who may edit them freely.'),
      exceptionRow('everyone', 'Everyone'),
      ...editorsList().map(name => exceptionRow(name, name)),
      el('div.rv-actions', {}, button('More users…', async () => {
        const names = await promptDialog({ title: 'Add users', label: 'Names or e-mail addresses', hint: 'Separate several with commas or semicolons.', confirmLabel: 'Add' });
        if (!names) return;
        EXTRA_EDITORS.set([...new Set([...EXTRA_EDITORS.get(), ...names.split(/[;,]/).map(s => s.trim()).filter(Boolean)])]);
        render();
      })),
      regionList()) : null;
    const start = button('Yes, Start Enforcing Protection', () => startEnforcing(), { primary: true, small: false, disabled: readOnly || !draft.formatting && !draft.editing });
    return el('div', {},
      section('1. Formatting restrictions', el('label.rv-check', {}, formattingBox, 'Limit formatting to a selection of styles'), button('Choose styles…', () => chooseStyles(), { disabled: readOnly })),
      section('2. Editing restrictions', el('label.rv-check', {}, editingBox, 'Allow only this type of editing in the document:'), kind),
      exceptions,
      section('3. Start enforcement', hint('Are you ready to apply these settings? You can turn them off later.'), start),
      readOnly ? hint('This document is open read-only.') : null);
  }
  function regionList() {
    const list = regions();
    if (!list.length) return null;
    const engine = editor();
    return el('div.rv-list.rv-regions', { role: 'list', 'aria-label': 'Editable regions' }, ...list.map(r => el('div.rv-item', { role: 'listitem' },
      el('button.rv-issue-target', { type: 'button', onclick: () => reveal(engine, r.start, r.end) }, `${r.edGrp === 'everyone' ? 'Everyone' : r.ed || r.edGrp}: “${engine.session.body.text.slice(r.start, Math.min(r.end, r.start + 40)).replace(/\n/g, ' ')}${r.end - r.start > 40 ? '…' : ''}”`),
      button('Remove', () => { engine.execute(() => api().removePermissionRanges(engine.model, [r.id])); render(); }))));
  }
  function saveDraft() {
    // Unenforced choices are kept in the file (enforcement off), as word processors do.
    const next = draft.formatting || draft.editing ? { edit: draft.editing ? draft.edit : 'none', formatting: draft.formatting, enforcement: false } : null;
    const current = protection();
    if (JSON.stringify(next) === JSON.stringify(current && { edit: current.edit, formatting: current.formatting, enforcement: current.enforcement })) return;
    setSettings({ protection: next });
  }
  function toggleException(who, on) {
    const engine = editor(); if (!engine) return;
    engine.finishComposition();
    const [a, b] = engine.model.range;
    if (on) engine.execute(() => api().addPermissionRange(engine.model, a, b, who === 'everyone' ? { edGrp: 'everyone' } : { ed: who }));
    else {
      const ids = regions().filter(r => (r.start <= a && b <= r.end || a < r.end && b > r.start) && (who === 'everyone' ? r.edGrp === 'everyone' : (r.ed || '').toLowerCase() === who.toLowerCase())).map(r => r.id);
      engine.execute(() => api().removePermissionRanges(engine.model, ids));
    }
    render();
  }
  function chooseStyles() {
    const engine = editor(); if (!engine) return;
    const styles = Object.values(engine.model.styles.definitions || {}).filter(s => ['paragraph', 'character'].includes(s.type)).sort((x, y) => String(x.name).localeCompare(String(y.name)));
    const locked = new Set(settings().lockedStyles || []);
    const boxes = styles.map(s => ({ id: s.id, input: el('input', { type: 'checkbox', checked: !locked.has(s.id) }), label: s.name || s.id }));
    const modal = openModal({ title: 'Formatting Restrictions', content: el('form.ed-dialog-body', { onsubmit: e => {
      e.preventDefault();
      setSettings({ lockedStyles: boxes.filter(b => !b.input.checked).map(b => b.id) });
      modal.close(); render();
    } },
      hint('Checked styles may be used. Direct formatting is not allowed while the restriction is enforced.'),
      el('div.rv-style-list', {}, ...boxes.map(b => el('label.rv-check', {}, b.input, b.label))),
      el('div.rv-actions', {}, button('All', () => boxes.forEach(b => { b.input.checked = true; })), button('None', () => boxes.forEach(b => { b.input.checked = false; }))),
      el('div.modal-actions', {}, el('button.btn.btn-ghost', { type: 'button', onclick: () => modal.close() }, 'Cancel'), el('button.btn.btn-primary', { type: 'submit' }, 'OK'))) });
  }

  async function startEnforcing(choice = null) {
    const engine = editor(); if (!engine || pkg()?.readOnly) return false;
    const edit = choice?.edit ?? (draft.editing ? draft.edit : 'none'), formatting = choice?.formatting ?? draft.formatting;
    const password = await passwordDialog({ title: choice?.title || 'Start Enforcing Protection', intro: choice?.intro || 'Enter a password to keep others from removing the protection, or leave it empty.' });
    if (password === null) return false;
    const verifier = password ? await api().createPasswordVerifier(password) : null;
    engine.finishComposition();
    setSettings({ protection: { edit, formatting, enforcement: true, ...(verifier || {}) } });
    // Earlier edits cannot be undone past the point protection began.
    engine.session.history = []; engine.session.future = [];
    applyGuard(); render();
    toast(edit === 'trackedChanges' && !formatting ? 'Tracking is locked' : 'Protection is on');
    return true;
  }
  async function stopEnforcing({ title = 'Stop Protection' } = {}) {
    const p = protection(); if (!p?.enforcement) { if (readOnlyView) { readOnlyView = false; applyGuard(); render(); } return true; }
    if (api().hasPassword(p)) {
      const ok = await passwordDialog({ title, requireMatch: false, allowEmpty: false, confirmLabel: 'Unprotect', check: value => api().verifyPassword(value, p) });
      if (ok === null) return false;
    } else if (!await confirmDialog({ title, message: 'Turn off protection for this document?', confirmLabel: 'Stop Protection', danger: false })) return false;
    setSettings({ protection: { edit: p.edit, formatting: p.formatting, enforcement: false } });
    applyGuard(); render();
    return true;
  }

  function nextRegion() {
    const engine = editor(); if (!engine) return;
    const list = myRegions(); if (!list.length) { toast('There is no region you can edit.', { icon: 'info' }); return; }
    const [, b] = engine.model.range;
    const next = list.find(r => r.start > b) || list[0];
    reveal(engine, next.start, next.end); engine.focus();
  }
  function enforcedView() {
    const p = readOnlyView ? { edit: 'readOnly' } : protection();
    const mine = myRegions();
    const highlight = el('input', { type: 'checkbox', checked: HIGHLIGHT.get(), onchange: () => { HIGHLIGHT.set(highlight.checked); onChange(); } });
    return el('div', {},
      section('Your permissions', el('p.rv-status', {}, readOnlyView ? 'You opened this document read-only, as its author recommends.' : EXPLAIN[p.edit] || EXPLAIN.readOnly),
        p.formatting && p.edit !== 'none' ? el('p.rv-status', {}, EXPLAIN.none) : null,
        ['readOnly', 'comments', 'forms'].includes(p.edit) && mine.length ? el('div', {}, hint('You may edit in the highlighted regions.'),
          el('div.rv-actions', {}, button('Find Next Region I Can Edit', () => nextRegion(), { primary: true }), button('Show All Regions I Can Edit', () => { const engine = editor(); if (mine.length) reveal(engine, mine[0].start, mine.at(-1).end); })),
          el('label.rv-check', {}, highlight, 'Highlight the regions I can edit')) : null),
      el('div.rv-actions', {}, button(readOnlyView ? 'Edit Anyway' : 'Stop Protection', () => stopEnforcing(), { small: false })));
  }

  return {
    pane, applyGuard, startEnforcing, stopEnforcing, nextRegion,
    open({ focus = true } = {}) { pane.open({ focus }); render(); },
    refresh() { if (pane.isOpen) render(false); },
    get enforced() { return enforced(); },
    get protection() { return readOnlyView ? { edit: 'readOnly', enforcement: true } : protection(); },
    get trackingLocked() { const p = protection(); return !!p?.enforcement && p.edit === 'trackedChanges'; },
    /** Tints for permission regions (yellow when enforced, blue while setting up). */
    tints() {
      const engine = editor(); if (!engine || engine.session.path !== null || !api()) return [];
      if (enforced()) return HIGHLIGHT.get() ? myRegions().map(r => ({ start: r.start, end: r.end, fill: REGION_TINT })) : [];
      return pane.isOpen ? regions().map(r => ({ start: r.start, end: r.end, fill: DRAFT_TINT })) : [];
    },
    /** File > Always Open Read-Only. */
    get alwaysReadOnly() { return !!settings().writeProtection?.recommended; },
    toggleAlwaysReadOnly() { if (pkg()?.readOnly) return; setSettings({ writeProtection: settings().writeProtection?.recommended ? null : { recommended: true } }); toast(settings().writeProtection ? 'This document will suggest opening read-only' : 'The read-only suggestion is off'); },
    /** On opening a document whose author recommends read-only, ask how to open it. */
    async offerReadOnly() {
      if (!settings().writeProtection?.recommended || pkg()?.readOnly) return;
      const readOnly = await confirmDialog({ title: 'Open read-only?', message: 'The author suggests opening this document read-only unless you need to change it.', confirmLabel: 'Open Read-Only', cancelLabel: 'Edit', danger: false });
      if (readOnly) { readOnlyView = true; applyGuard(); pane.open({ focus: false }); render(); }
    },
    destroy() { pane.destroy(); },
  };
}
