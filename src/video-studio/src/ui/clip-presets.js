/**
 * Clip presets: a clip's chosen attribute groups (effects, color, masks,
 * animations, speed, text style and so on, see ATTRIBUTE_GROUPS) saved
 * under a name and applied to other clips later, in this or any project.
 * Kept in preferences, so they follow the user on this device.
 */
import { h, announce } from '../lib/dom.js';
import { uid } from '../lib/ids.js';
import * as T from '../model/timeline.js';
import { ATTRIBUTE_GROUPS, attributeGroupsFor, captureAttributes } from './organize-actions.js';
import { openDialog, toast, promptDialog, confirmDialog } from './dialog.js';
import { prefs, setPref } from './prefs.js';

export const MAX_PRESETS = 100;

export function clipPresets() {
  const list = prefs().clipPresets;
  return Array.isArray(list) ? list.filter((p) => p && p.groups && typeof p.name === 'string') : [];
}

const write = (list) => setPref('clipPresets', list.slice(0, MAX_PRESETS));

/** Presets with at least one group that applies to a clip type. */
export function presetsFor(type) {
  return clipPresets().filter((p) => ATTRIBUTE_GROUPS.some((g) => p.groups[g.id] && g.types.includes(type)));
}

/** A preset from a clip: the given groups of its attributes (all it has when omitted). */
export function makePreset(clip, name, groupIds = null) {
  const cap = captureAttributes(clip);
  const groups = {};
  for (const [id, entry] of Object.entries(cap.groups)) if (!groupIds || groupIds.includes(id)) groups[id] = entry;
  return { id: uid('pr'), name: String(name || 'Preset').slice(0, 80), type: clip.type, duration: clip.duration, created: Date.now(), groups };
}

/** Ask which attributes to keep and a name, then save the preset. */
export function saveClipPreset(ctx, clipId = ctx.store.selected?.clip.id) {
  const f = clipId && T.findClip(ctx.store.project, clipId);
  if (!f) {
    toast('Select a clip to save its look as a preset.', { kind: 'info' });
    return;
  }
  const groups = attributeGroupsFor(f.clip);
  if (!groups.length) {
    toast('This clip has nothing to save as a preset.', { kind: 'info' });
    return;
  }
  const name = h('input#preset-name.input', { type: 'text', maxLength: 80, value: `${T.clipLabel(ctx.store.project, f.clip)} look` });
  const boxes = groups.map((g) => {
    const input = h('input', { type: 'checkbox', checked: g.id !== 'speed' && g.id !== 'transform' });
    return { g, input, row: h('label.check-row', input, h('span', g.label)) };
  });
  const cancel = h('button.btn', { type: 'button' }, 'Cancel');
  const ok = h('button.btn.primary', { type: 'button' }, 'Save');
  const d = openDialog({
    title: 'Save as preset',
    body: h('div.paste-attrs', h('div.field', h('label.field-label', { for: 'preset-name' }, 'Name'), name), h('p.dialog-text', 'Keep these settings:'), h('div.check-list', boxes.map((b) => b.row))),
    actions: [cancel, ok],
    className: 'small',
  });
  cancel.addEventListener('click', () => d.close());
  ok.addEventListener('click', () => {
    const chosen = boxes.filter((b) => b.input.checked).map((b) => b.g.id);
    if (!chosen.length) {
      toast('Choose at least one setting to keep.', { kind: 'info' });
      return;
    }
    const preset = makePreset(f.clip, name.value.trim() || 'Preset', chosen);
    write([preset, ...clipPresets()]);
    d.close();
    announce(`Preset ${preset.name} saved`);
    toast(`Saved "${preset.name}". Apply it from a clip's menu under Apply preset.`, { kind: 'success' });
  });
  queueMicrotask(() => name.select?.());
}

/** Apply a preset to the selected clips (or the given ones) as one undo step. */
export function applyClipPreset(ctx, presetId, ids = [...ctx.store.selection]) {
  const preset = clipPresets().find((p) => p.id === presetId);
  if (!preset) return false;
  const ok = ctx.actions.applyAttributeBoard(preset, Object.keys(preset.groups), ids, `Apply ${preset.name}`);
  if (ok) announce(`${preset.name} applied`);
  else toast('That preset does not apply to the selected clips.', { kind: 'info' });
  return ok;
}

export async function renameClipPreset(id) {
  const p = clipPresets().find((x) => x.id === id);
  if (!p) return;
  const name = await promptDialog({ title: 'Rename preset', label: 'Preset name', value: p.name, confirm: 'Rename', maxLength: 80 });
  if (name) write(clipPresets().map((x) => (x.id === id ? { ...x, name } : x)));
}

export function deleteClipPreset(id) {
  write(clipPresets().filter((x) => x.id !== id));
}

/** Menu items for a clip's Apply preset submenu. */
export function presetMenu(ctx, clip) {
  const list = presetsFor(clip.type);
  if (!list.length) return [{ label: 'No presets yet. Use Save as preset first.', disabled: true }];
  return [
    ...list.map((p) => ({ label: p.name, icon: 'bookmark', onSelect: () => applyClipPreset(ctx, p.id) })),
    'separator',
    { label: 'Manage presets...', icon: 'settings', onSelect: () => managePresets(ctx) },
  ];
}

/** A small list to rename and delete presets. */
export function managePresets() {
  const list = h('div.preset-manage', { role: 'list', 'aria-label': 'Clip presets' });
  const render = () => {
    const all = clipPresets();
    list.replaceChildren(...(all.length ? all.map((p) => {
      const rename = h('button.btn.small', { type: 'button' }, 'Rename');
      rename.addEventListener('click', async () => {
        await renameClipPreset(p.id);
        render();
      });
      const del = h('button.btn.small.ghost', { type: 'button', 'aria-label': `Delete ${p.name}` }, 'Delete');
      del.addEventListener('click', async () => {
        // A preset cannot be brought back: asked first, as for a saved color look.
        if (!(await confirmDialog({ title: 'Delete preset?', message: `${p.name} will be deleted. Clips it was applied to keep their look.`, confirm: 'Delete', danger: true }))) return;
        const at = [...list.children].indexOf(del.closest('.preset-row'));
        deleteClipPreset(p.id);
        render();
        // Focus goes to the preset that took its place, the one before, or Done.
        const row = list.children[Math.min(at, list.children.length - 1)];
        (row?.querySelector('button:last-of-type') || list.closest('dialog')?.querySelector('.dialog-actions .btn'))?.focus();
      });
      const what = ATTRIBUTE_GROUPS.filter((g) => p.groups[g.id]).map((g) => g.label).join(', ');
      return h('div.preset-row', { role: 'listitem' }, h('div.preset-text', h('strong', p.name), h('span.asset-hint', what)), rename, del);
    }) : [h('p.dialog-text', 'No presets yet.')]));
  };
  render();
  const close = h('button.btn.primary', { type: 'button' }, 'Done');
  const d = openDialog({ title: 'Clip presets', body: list, actions: [close], className: 'small' });
  close.addEventListener('click', () => d.close());
}
