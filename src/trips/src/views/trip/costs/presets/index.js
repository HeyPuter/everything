import './presets.css';
import { el, uid } from '../../../../ui/dom.js';
import { button, emptyState, iconButton } from '../../../../ui/bits.js';
import { confirmDialog, openModal, promptDialog } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { displayLocale } from '../../../../lib/prefs.js';
import { decimalInput } from '../../../../lib/costs/input.js';
import { attempt } from '../shared.js';
import { applyPreset, buildPreset, matchPreset, sortPresets, weightsFromRows } from './model.js';

const presetsOf = (space) => sortPresets(space.select.splitPreset?.all() ?? [], displayLocale());

/** "Alice ×2 · Bob ×1" for a preset; people no longer in the trip show as former members. */
export function presetSummary(preset, people, locale = displayLocale()) {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 18 });
  return Object.entries(preset.weights ?? {}).map(([who, value]) => t('presets.weightOf', { name: people.name(who), weight: number.format(Number(value)) })).join(' · ');
}

function errorMessage(error, people) {
  if (error?.code === 'preset_name') return t('presets.errorName');
  if (error?.code === 'preset_weight') return t('presets.errorWeight', { name: people.name(error.who) });
  if (error?.code === 'preset_empty') return t('presets.errorEmpty');
  if (error?.code === 'preset_people') return t('presets.errorPeople');
  return t('presets.errorGeneric');
}

/**
 * Preset picker for the expense form: shown in shares mode, and in equal mode once the trip has presets (picking one
 * switches to shares). `roster()` lists the people on the expense, `rows()` gives `[[who, typed weight]]` for current
 * participants, and `apply({participants, weights})` fills the form.
 */
export function presetBar({ space, people, track, canEdit, roster, rows, apply }) {
  const locale = displayLocale();
  const selectId = uid('presets-select');
  const select = el('select.select', { id: selectId, onchange: () => choose(select.value) });
  const note = el('p.field-hint.presets-note', { 'aria-live': 'polite' });
  const save = canEdit ? button(t('presets.save'), { size: 'sm', variant: 'ghost', icon: 'plus', onclick: saveCurrent }) : null;
  const manage = canEdit ? button(t('presets.manage'), { size: 'sm', variant: 'ghost', onclick: () => openPresetManager({ space, people, track }) }) : null;
  const element = el('div.presets-bar', {},
    el('div.presets-pick', {}, el('label.field-label', { htmlFor: selectId }, t('presets.label')), select), save, manage, note);

  let shown = null;
  let mode = 'shares';
  function sync() {
    const source = space.select.splitPreset?.all() ?? [];
    const list = presetsOf(space);
    if (source !== shown) {
      shown = source;
      select.replaceChildren(el('option', { value: '' }, list.length ? t('presets.none') : t('presets.empty')),
        ...list.map((preset) => el('option', { value: preset.id }, preset.name)));
      select.disabled = !list.length;
    }
    const current = mode === 'shares' ? weightsFromRows(rows(), locale) : null;
    select.value = (current ? matchPreset(list, current) : null)?.id ?? '';
  }

  function choose(id) {
    note.textContent = '';
    const preset = id ? space.get('splitPreset', id) : null;
    if (!preset) return;
    const result = applyPreset(preset, roster());
    if (!result.participants.length) { note.textContent = t('presets.nobody'); return; }
    apply(result);
    if (result.missing.length) note.textContent = result.missing.length === 1 ? t('presets.missingOne') : t('presets.missingMany', { count: result.missing.length });
  }

  async function saveCurrent() {
    const weights = weightsFromRows(rows(), locale);
    if (!weights || !Object.keys(weights).length) { note.textContent = t('presets.errorEmpty'); return; }
    const name = await promptDialog({ title: t('presets.saveTitle'), label: t('presets.name'), confirmLabel: t('presets.saveConfirm') });
    if (name === null) return;
    let preset;
    try { preset = buildPreset(name, Object.entries(weights), { locale }); } catch (error) { toast(errorMessage(error, people)); return; }
    const ok = await attempt(async () => { await space.apply([space.ops.create('splitPreset', preset)], { history: t('presets.historyAdd') }); return true; });
    if (ok) toast(t('presets.saved', { name: preset.name }));
    sync();
  }

  function show(next = mode) {
    mode = next;
    element.hidden = !(mode === 'shares' || (mode === 'equal' && presetsOf(space).length));
    if (save) save.hidden = mode !== 'shares';
    if (!element.hidden) sync();
  }
  const off = space.subscribe('splitPreset', () => show());
  sync();
  return { element, sync, show, destroy: off };
}

/** Lists the trip's presets with add, edit and delete (`costs.edit`). */
export function openPresetManager({ space, people, track }) {
  const body = el('div.presets-manager');
  let dialog;
  function render() {
    const list = presetsOf(space);
    const canEdit = space.can('costs.edit');
    body.replaceChildren(
      el('p.field-hint', {}, t('presets.intro')),
      list.length ? el('ul.presets-list', {}, list.map((preset) => el('li.presets-row', { dataset: { id: preset.id } },
        el('div.presets-row-text', {}, el('strong', {}, preset.name), el('span.field-hint', {}, presetSummary(preset, people))),
        canEdit ? iconButton('pencil', t('presets.edit', { name: preset.name }), { dataset: { focus: `edit:${preset.id}` }, onclick: () => openPresetEditor({ space, people, track, preset }) }) : null,
        canEdit ? iconButton('trash', t('presets.delete', { name: preset.name }), { dataset: { focus: `delete:${preset.id}` }, onclick: () => remove(preset) }) : null)))
        : emptyState({ title: t('presets.emptyTitle'), body: t('presets.emptyBody'), icon: 'users' }));
  }
  async function remove(preset) {
    const confirmed = await confirmDialog({ title: t('presets.deleteTitle'), body: t('presets.deleteBody', { name: preset.name }), confirmLabel: t('presets.deleteConfirm'), danger: true });
    if (!confirmed) return;
    const removed = await attempt(async () => { await space.apply([space.ops.remove('splitPreset', preset.id)]); return true; });
    if (removed) toast(t('presets.deleted', { name: preset.name }), { action: { label: t('presets.undo'), onClick: () => attempt(() => space.apply([space.ops.create('splitPreset', { name: preset.name, weights: structuredClone(preset.weights) })])) } });
  }
  render();
  const off = space.subscribe((event) => { if (event.types.has('splitPreset') || event.types.has('member') || event.types.has('guest')) render(); });
  const add = button(t('presets.add'), { variant: 'primary', icon: 'plus', onclick: () => openPresetEditor({ space, people, track }) });
  add.hidden = !space.can('costs.edit');
  dialog = track(openModal({ title: t('presets.title'), content: body, actions: [button(t('ui.close'), { onclick: () => dialog.close() }), add], onClose: off }));
  return dialog;
}

/** Create or edit one preset: a name and a weight per member and guest (blank or 0 leaves them out). */
export function openPresetEditor({ space, people, track, preset = null }) {
  const locale = displayLocale();
  people.refresh?.();
  const nameId = uid('presets-name');
  const nameInput = el('input.input', { id: nameId, value: preset?.name ?? '', maxLength: 100, required: true, autocomplete: 'off' });
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const ids = [...new Set([...people.list.map((person) => person.id), ...Object.keys(preset?.weights ?? {})])];
  const inputs = new Map(ids.map((who) => {
    const stored = preset?.weights?.[who];
    return [who, el('input.input.num.costs-value', { inputMode: 'decimal', autocomplete: 'off', value: stored === undefined ? '' : decimalInput(stored, locale),
      'aria-label': t('presets.weightLabel', { name: people.name(who) }) })];
  }));
  const save = button(preset ? t('presets.saveChanges') : t('presets.create'), { variant: 'primary', type: 'submit' });
  const form = el('form.presets-form', { noValidate: true, onsubmit: submit },
    el('div.field', {}, el('label.field-label', { htmlFor: nameId }, t('presets.name')), nameInput),
    el('fieldset.costs-section', {}, el('legend.field-label', {}, t('presets.weights')),
      el('p.field-hint', {}, t('presets.weightsHint')),
      el('div.costs-rows', {}, ids.map((who) => el('div.costs-row', {}, people.avatar(who, 24), el('span.costs-row-name', {}, people.name(who)), inputs.get(who))))),
    error,
    el('div.modal-actions', {}, button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), save));

  async function submit(event) {
    event.preventDefault();
    error.hidden = true;
    let next;
    try { next = buildPreset(nameInput.value, [...inputs.entries()].map(([who, input]) => [who, input.value]), { locale }); } catch (failure) {
      error.textContent = errorMessage(failure, people); error.hidden = false;
      (failure?.code === 'preset_weight' ? inputs.get(failure.who) : failure?.code === 'preset_name' ? nameInput : null)?.focus();
      return;
    }
    save.setAttribute('aria-busy', 'true');
    const op = preset ? space.ops.patch('splitPreset', preset.id, { set: next }) : space.ops.create('splitPreset', next);
    const ok = await attempt(async () => { await space.apply([op], { history: t(preset ? 'presets.historyEdit' : 'presets.historyAdd') }); return true; });
    save.setAttribute('aria-busy', 'false');
    if (!ok) return;
    dialog.close('saved');
  }
  const dialog = track(openModal({ title: preset ? t('presets.editTitle') : t('presets.newTitle'), content: form }));
  return dialog;
}
