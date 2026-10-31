import { el } from '../../../ui/dom.js';
import { button, iconButton, skeleton } from '../../../ui/bits.js';
import { field } from '../../../ui/fields.js';
import { openModal, confirmDialog } from '../../../ui/modal.js';
import { openMenu } from '../../../ui/menu.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { formatDate } from '../../../lib/format.js';
import { daysBetween, localDate as today } from '../../../shared/dates.js';
import { createVaultStore, DOC_TYPES, VAULT_LIMITS } from '../data/vault.js';
import { icon } from '../icons.js';
import { alertRegion, busy, errorText, withIcon, listFocus } from '../ui.js';

const TYPE_LABELS = {
  passport: 'settings.docPassport', id: 'settings.docId', license: 'settings.docLicense', visa: 'settings.docVisa',
  loyalty: 'settings.docLoyalty', insurance: 'settings.docInsurance', other: 'settings.docOther',
};
const CODES = {
  wrong_passphrase: 'settings.vaultWrongPassphrase', passphrase_too_short: 'settings.vaultPassphraseShort',
  document_label_required: 'settings.docLabelRequired', too_many_documents: 'settings.docLimit', vault_locked: 'settings.vaultLockedError',
  vault_changed: 'settings.vaultChanged', vault_unreadable: 'settings.vaultUnreadable',
};
const message = (error) => (Object.hasOwn(CODES, error?.code) ? t(CODES[error.code]) : errorText(error));

export function render(container, { puter, signal }) {
  const store = createVaultStore({ puter });
  const alert = alertRegion();
  const body = el('div.vault-body', { 'aria-busy': 'true' }, skeleton(), skeleton('60%'));
  const revealed = new Set();
  let snapshot = { state: 'empty', docs: [] };
  let dialog = null;
  let add = null;
  const focus = listFocus(body, () => add);

  async function load() {
    body.setAttribute('aria-busy', 'true');
    try { snapshot = await store.load(); if (!signal.aborted) draw(); }
    catch (error) {
      if (signal.aborted) return;
      body.replaceChildren(el('div.settings-error', {}, el('p', {}, errorText(error)), button(t('settings.retry'), { size: 'sm', variant: 'outline', onclick: load })));
    } finally { body.removeAttribute('aria-busy'); }
  }
  function update(next, then) { snapshot = next; draw(); then?.(); }
  // Another session changed the vault: the store already holds the new value, so show it and say why.
  async function attempt(action) {
    try { return await action(); } catch (error) {
      if (!['vault_changed', 'vault_unreadable'].includes(error?.code)) throw error;
      dialog?.close('changed'); revealed.clear(); alert.show(message(error)); update(store.snapshot());
      return undefined;
    }
  }

  function draw() { focus.redraw(drawBody); }
  function drawBody() {
    add = null;
    if (snapshot.state === 'locked') { body.replaceChildren(unlockForm()); return; }
    if (snapshot.state === 'unreadable') {
      body.replaceChildren(el('div.settings-error', {}, el('p', {}, t('settings.vaultUnreadable')),
        button(t('settings.vaultClear'), { size: 'sm', variant: 'outline', onclick: () => clearVault('settings.vaultUnreadableClearBody') })));
      return;
    }
    const protectedVault = snapshot.state === 'unlocked';
    add = button(t('settings.docAdd'), { icon: 'plus', variant: 'primary', dataset: { focus: 'add' }, onclick: () => editDoc(null) });
    const actions = [add];
    if (protectedVault) {
      actions.push(
        withIcon(button(t('settings.vaultLock'), { variant: 'outline', dataset: { focus: 'lock' }, onclick: () => { revealed.clear(); update(store.lock(), () => body.querySelector('input')?.focus()); } }), 'lock'),
        button(t('settings.vaultChangePassphrase'), { variant: 'ghost', dataset: { focus: 'change' }, onclick: () => passphraseDialog(true) }),
        button(t('settings.vaultRemovePassphrase'), { variant: 'ghost', dataset: { focus: 'remove' }, onclick: removePassphrase }));
    } else actions.push(withIcon(button(t('settings.vaultProtect'), { variant: 'outline', dataset: { focus: 'protect' }, onclick: () => passphraseDialog(false) }), 'lock'));
    const note = el('p.vault-note', {}, icon(protectedVault ? 'lock' : 'unlock', 16), t(protectedVault ? 'settings.vaultEncrypted' : 'settings.vaultPlain'));
    const list = snapshot.docs.length ? el('div.card', {}, snapshot.docs.map(docRow)) : el('p.pref-hint.list-empty', {}, t('settings.vaultEmpty'));
    // The action bar counts as a row so focus also survives redraws there.
    body.replaceChildren(note, el('div.settings-actions', { dataset: { id: 'actions' } }, actions), list);
  }
  function docRow(doc) {
    const shown = revealed.has(doc.id);
    const last = doc.number.slice(-4);
    const number = !doc.number ? null : shown ? el('span.vault-number', {}, doc.number)
      : el('span.vault-number', {}, el('span', { 'aria-hidden': 'true' }, doc.number.length > 4 ? `•••• ${last}` : '••••'),
        el('span.sr-only', {}, doc.number.length > 4 ? t('settings.vaultNumberEnds', { last }) : t('settings.vaultNumberHidden')));
    let expiry = null;
    if (doc.expires) {
      const days = daysBetween(today(), doc.expires);
      const date = formatDate(doc.expires);
      expiry = days < 0 ? el('span.chip.chip-warn', {}, t('settings.docExpired', { date }))
        : days <= 180 ? el('span.chip.chip-warn', {}, t('settings.docExpiresSoon', { date })) : el('span.pref-hint', {}, t('settings.docExpires', { date }));
    }
    // One name in both states; `aria-pressed` tells whether the number shows.
    const reveal = iconButton(shown ? 'eyeOff' : 'eye', t('settings.vaultShowNamed', { name: doc.label }), {
      'aria-pressed': shown, disabled: !doc.number, dataset: { focus: 'reveal' }, onclick: () => { if (shown) revealed.delete(doc.id); else revealed.add(doc.id); draw(); } });
    reveal.replaceChildren(icon(shown ? 'eyeOff' : 'eye')); reveal.classList.add('vault-reveal');
    const more = iconButton('more', t('settings.docActions', { name: doc.label }), { dataset: { focus: 'more' }, onclick: () => openMenu(more, [
      { label: t('settings.docCopy'), icon: 'copy', disabled: !doc.number, onSelect: () => copy(doc) },
      { label: t('settings.docEdit'), icon: 'pencil', onSelect: () => editDoc(doc, more) },
      { separator: true },
      { label: t('settings.delete'), icon: 'trash', danger: true, onSelect: () => removeDoc(doc, more) },
    ]) });
    return el('div.list-row.vault-row', { dataset: { id: doc.id } },
      el('span.row-icon', {}, icon(doc.type)),
      el('span.row-text', {}, el('span.pref-label', {}, doc.label),
        el('span.pref-hint', {}, t(TYPE_LABELS[doc.type]), doc.holder ? ` · ${doc.holder}` : '', doc.country ? ` · ${doc.country}` : ''), number, expiry),
      reveal, more);
  }
  function unlockForm() {
    const formAlert = alertRegion();
    const pass = field({ label: t('settings.vaultPassphrase'), type: 'password', autocomplete: 'current-password' });
    const unlock = withIcon(button(t('settings.vaultUnlock'), { type: 'submit', variant: 'primary' }), 'unlock');
    const forgot = button(t('settings.vaultForgot'), { variant: 'ghost', size: 'sm', onclick: () => clearVault() });
    return el('form.vault-unlock', { noValidate: true, onsubmit: async (event) => {
      event.preventDefault(); pass.setError(''); formAlert.clear();
      unlock.setAttribute('aria-busy', 'true');
      let next;
      try { next = await store.unlock(pass.input.value); }
      catch (error) {
        if (error?.code === 'wrong_passphrase') { pass.setError(message(error)); pass.input.select(); } else formAlert.show(message(error));
        return;
      } finally { unlock.setAttribute('aria-busy', 'false'); }
      if (!signal.aborted) update(next, () => body.querySelector('.settings-actions button')?.focus());
    } }, el('p.vault-note', {}, icon('lock', 16), t('settings.vaultLocked')), formAlert.node, pass.element, el('div.settings-actions', {}, unlock, forgot));
  }
  function editDoc(doc, control) {
    focus.hold(control);
    let saved = false;
    const creating = !doc;
    const dialogAlert = alertRegion();
    const type = field({ label: t('settings.docType'), type: 'select', value: doc?.type ?? 'passport', options: DOC_TYPES.map((value) => ({ value, label: t(TYPE_LABELS[value]) })) });
    const label = field({ label: t('settings.docLabel'), value: doc?.label ?? '', maxLength: VAULT_LIMITS.label, hint: t('settings.docLabelHint'), autocomplete: 'off' });
    const number = field({ label: t('settings.docNumber'), value: doc?.number ?? '', maxLength: VAULT_LIMITS.number, autocomplete: 'off', spellcheck: false });
    const holder = field({ label: t('settings.docHolder'), value: doc?.holder ?? '', maxLength: VAULT_LIMITS.holder, autocomplete: 'off' });
    const country = field({ label: t('settings.docCountry'), value: doc?.country ?? '', maxLength: VAULT_LIMITS.country, autocomplete: 'off' });
    const expires = field({ label: t('settings.docExpiry'), type: 'date', value: doc?.expires ?? '' });
    const notes = field({ label: t('settings.docNotes'), type: 'textarea', value: doc?.notes ?? '', maxLength: VAULT_LIMITS.notes, rows: 3 });
    const save = button(t(creating ? 'settings.docAdd' : 'settings.save'), { type: 'submit', variant: 'primary' });
    const form = el('form', { noValidate: true, onsubmit: async (event) => {
      event.preventDefault(); label.setError('');
      if (!label.input.value.trim()) { label.setError(t('settings.docLabelRequired')); label.input.focus(); return; }
      const next = await busy(save, dialogAlert, () => attempt(() => store.saveDoc({ ...(doc ?? {}), type: type.input.value, label: label.input.value, number: number.input.value,
        holder: holder.input.value, country: country.input.value, expires: expires.input.value || null, notes: notes.input.value })), message);
      if (!next) return;
      saved = true;
      dialog?.close('saved'); update(next); toast(t(creating ? 'settings.docAdded' : 'settings.docSaved', { name: label.input.value.trim() }));
    } }, dialogAlert.node, type.element, label.element, number.element, el('div.field-row', {}, holder.element, country.element), expires.element, notes.element,
    el('div.modal-actions', {}, button(t('settings.cancel'), { onclick: () => dialog?.close('cancel') }), save));
    dialog = openModal({ title: t(creating ? 'settings.docNewTitle' : 'settings.docEditTitle'), content: form, initialFocus: label.input,
      onClose: () => { dialog = null; if (!saved) focus.release(); } });
  }
  function passphraseDialog(changing) {
    const dialogAlert = alertRegion();
    const first = field({ label: t('settings.vaultNewPassphrase'), type: 'password', autocomplete: 'new-password', hint: t('settings.vaultPassphraseHint') });
    const second = field({ label: t('settings.vaultConfirmPassphrase'), type: 'password', autocomplete: 'new-password' });
    const save = button(t('settings.vaultSetPassphrase'), { type: 'submit', variant: 'primary' });
    const form = el('form', { noValidate: true, onsubmit: async (event) => {
      event.preventDefault(); first.setError(''); second.setError('');
      if (first.input.value.length < VAULT_LIMITS.passphrase) { first.setError(t('settings.vaultPassphraseShort')); first.input.focus(); return; }
      if (first.input.value !== second.input.value) { second.setError(t('settings.vaultPassphraseMismatch')); second.input.focus(); return; }
      const next = await busy(save, dialogAlert, () => attempt(() => store.setPassphrase(first.input.value)), message);
      if (!next) return;
      dialog?.close('saved'); update(next); toast(t(changing ? 'settings.vaultPassphraseChanged' : 'settings.vaultProtected'));
    } }, el('p.pref-hint', {}, t('settings.vaultPassphraseIntro')), dialogAlert.node, first.element, second.element,
    el('div.modal-actions', {}, button(t('settings.cancel'), { onclick: () => dialog?.close('cancel') }), save));
    dialog = openModal({ title: t(changing ? 'settings.vaultChangePassphrase' : 'settings.vaultProtect'), content: form, initialFocus: first.input, onClose: () => { dialog = null; } });
  }
  async function removePassphrase() {
    if (!await confirmDialog({ title: t('settings.vaultRemovePassphrase'), body: t('settings.vaultRemoveBody'), confirmLabel: t('settings.vaultRemovePassphrase') })) return;
    const next = await busy(null, alert, () => attempt(() => store.removePassphrase()), message);
    if (next) { update(next); toast(t('settings.vaultUnprotected')); }
  }
  async function clearVault(bodyKey = 'settings.vaultClearBody') {
    if (!await confirmDialog({ title: t('settings.vaultClearTitle'), body: t(bodyKey), confirmLabel: t('settings.vaultClear'), danger: true })) return;
    const next = await busy(null, alert, () => store.clear(), message);
    if (next) { revealed.clear(); update(next, () => add?.focus()); toast(t('settings.vaultCleared')); }
  }
  async function removeDoc(doc, control) {
    focus.hold(control);
    if (!await confirmDialog({ title: t('settings.docDeleteTitle', { name: doc.label }), body: t('settings.docDeleteBody'), confirmLabel: t('settings.delete'), danger: true })) { focus.release(); return; }
    const next = await busy(null, alert, () => attempt(() => store.removeDoc(doc.id)), message);
    if (next) { revealed.delete(doc.id); update(next); toast(t('settings.docDeleted', { name: doc.label })); } else focus.release();
  }
  async function copy(doc) {
    try { await navigator.clipboard.writeText(doc.number); toast(t('settings.docCopied')); } catch { toast(t('settings.docCopyFailed')); }
  }

  signal?.addEventListener('abort', () => { store.lock(); revealed.clear(); dialog?.close('navigation'); }, { once: true });
  container.replaceChildren(el('div.settings-stack', {},
    el('div.pref-group', {}, el('p.pref-hint', {}, t('settings.vaultHint')), alert.node, body)));
  void load();
}
