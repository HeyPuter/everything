import { el, uid as uniqueId } from '../../../ui/dom.js';
import { button, iconButton } from '../../../ui/bits.js';
import { field } from '../../../ui/fields.js';
import { openMenu } from '../../../ui/menu.js';
import { confirmDialog, openModal } from '../../../ui/modal.js';
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { errorMessage } from './errors.js';
import { personAvatar } from './people.js';
import { GUEST_COLORS, nextGuestColor } from './logic.js';
import { keepFocus } from './focus.js';

const NAME_CHARS = 100;

function colorPicker(value) {
  const name = uniqueId('guest-color');
  const legend = el('legend.field-label', {}, t('members.guestColor'));
  const element = el('fieldset.guest-colors', {}, legend, GUEST_COLORS.map((color) => el('label.guest-color', { dataset: { color: String(color) }, title: t(`members.color.${color}`) },
    el('input.sr-only', { type: 'radio', name, value: String(color), checked: color === value }),
    el('span.guest-color-dot', { 'aria-hidden': 'true' }),
    el('span.sr-only', {}, t(`members.color.${color}`)))));
  return { element, get value() { return Number(element.querySelector('input:checked')?.value) || GUEST_COLORS[0]; } };
}

function openGuestDialog({ space, guest, guests }) {
  const name = field({ label: t('members.guestName'), value: guest?.name ?? '', maxLength: NAME_CHARS, autocomplete: 'off', required: true });
  const colors = colorPicker(guest?.color ?? nextGuestColor(guests));
  const alert = el('p.members-alert', { role: 'alert', hidden: true });
  const save = button(t('ui.save'), { type: 'submit', variant: 'primary' });
  const form = el('form', { noValidate: true, onsubmit: async (event) => {
    event.preventDefault();
    const value = name.input.value.trim();
    if (!value) { name.setError(t('members.guestNameRequired')); name.input.focus(); return; }
    name.setError('');
    const fields = { name: value.slice(0, NAME_CHARS), color: colors.value };
    try {
      if (guest) await space.apply([space.ops.patch('guest', guest.id, { set: fields })], { history: t('members.historyEditGuest') });
      else await space.apply([space.ops.create('guest', fields)], { history: t('members.historyAddGuest') });
      dialog.close('save');
    } catch (error) {
      alert.textContent = t('members.errSave', { reason: errorMessage(error) }); alert.hidden = false;
    }
  } }, name.element, colors.element, alert, el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), save));
  const dialog = openModal({ title: guest ? t('members.editGuest') : t('members.addGuest'), content: form });
  return dialog;
}

/** Guests: people without accounts who appear in splits and assignments. Anyone with `plan.edit` manages them. */
export function guestSection({ space, me }) {
  const titleId = uniqueId('members-guests');
  const list = el('ul.card.members-list', { 'aria-labelledby': titleId });
  const empty = el('p.members-empty', {}, t('members.guestsEmpty'));
  const add = button(t('members.addGuest'), { size: 'sm', variant: 'outline', icon: 'plus', onclick: () => openGuestDialog({ space, guests: guests() }) });
  const element = el('section.members-section', { 'aria-labelledby': titleId },
    el('div.members-section-head', {}, el('h3', { id: titleId }, t('members.guests')), add),
    el('p.members-hint', {}, t('members.guestsHint')), empty, list);
  const guests = () => [...space.query('guest')].sort((a, b) => String(a.name).localeCompare(String(b.name)));

  async function remove(guest) {
    const ok = await confirmDialog({ title: t('members.guestRemoveTitle', { name: guest.name }), body: t('members.guestRemoveBody', { name: guest.name }),
      confirmLabel: t('members.guestRemove'), danger: true });
    if (!ok) return;
    try { await space.apply([space.ops.remove('guest', guest.id)]); }
    catch (error) { toast(t('members.errSave', { reason: errorMessage(error) })); }
  }
  function row(guest, editable) {
    return el('li.list-row.member-row', { dataset: { key: guest.id } },
      personAvatar({ id: guest.id, name: guest.name, color: guest.color }, { size: 32 }),
      el('div.member-text', {}, el('span.member-name', {}, guest.name), el('span.member-sub', {}, t('members.guestBadge'))),
      editable && iconButton('more', t('members.guestActions', { name: guest.name }), { dataset: { focus: `guest:${guest.id}` }, onclick: (event) => openMenu(event.currentTarget, [
        { label: t('members.guestEdit'), icon: 'pencil', onSelect: () => openGuestDialog({ space, guest, guests: guests() }) },
        { label: t('members.guestRemove'), icon: 'trash', danger: true, onSelect: () => void remove(guest) },
      ]) }));
  }
  function update() {
    const items = guests();
    const editable = me().planEdit;
    add.hidden = !editable;
    empty.hidden = items.length > 0;
    list.hidden = !items.length;
    keepFocus(list, () => list.replaceChildren(...items.map((guest) => row(guest, editable))));
  }
  update();
  const off = space.subscribe('guest', update);
  return { element, update, destroy: off };
}
