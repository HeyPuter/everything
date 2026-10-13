/**
 * Timelines of a project: create, open, duplicate, rename, delete and put
 * one into another as a compound clip. Shared by the player header menu,
 * the Timelines list in the media panel and the File menu.
 */
import { h, announce } from '../lib/dom.js';
import { clock } from '../lib/time.js';
import { RATIOS } from '../model/project.js';
import * as TL from '../model/timelines.js';
import { openDialog, confirmDialog, promptDialog, toast } from './dialog.js';
import { selectField } from './controls.js';

/** Settings for a new timeline: the open one's, reshaped to `ratioId` at the same quality. */
export function settingsForRatio(current, ratioId) {
  const r = RATIOS.find((x) => x.id === ratioId);
  if (!r) return structuredClone(current);
  const short = Math.min(current.width, current.height);
  const k = short / Math.min(r.w, r.h);
  const even = (n) => Math.max(16, Math.round(n / 2) * 2);
  return { ...structuredClone(current), ratio: r.id, width: even(r.w * k), height: even(r.h * k) };
}

export function createTimelineActions(ctx) {
  const { store } = ctx;
  const name = (id) => TL.listTimelines(store.project).find((t) => t.id === id)?.name || 'Timeline';
  const leaveCompounds = () => {
    while (store.nest?.length) store.closeCompound();
  };

  const api = {
    list: () => TL.listTimelines(store.project),
    active: () => TL.activeTimeline(store.project),

    open(id) {
      if (store.openTimeline(id)) announce(`Opened ${name(id)}`);
    },

    /** Add a timeline (empty, or shaped like `ratio`) and open it. */
    create({ name: wanted, ratio } = {}) {
      leaveCompounds();
      let id = null;
      store.update('New timeline', (p) => {
        TL.ensureTimelines(p);
        id = TL.addTimeline(p, { name: wanted, settings: ratio ? settingsForRatio(p.settings, ratio) : p.settings });
        if (!id) return false;
      });
      if (!id) {
        toast(`A project can hold up to ${TL.MAX_TIMELINES} timelines.`, { kind: 'info' });
        return null;
      }
      store.openTimeline(id);
      announce(`Created ${name(id)}`);
      return id;
    },

    /** Ask for a name and shape, then create. */
    async createWithDialog() {
      const p = store.project;
      const input = h('input.input', { type: 'text', maxLength: 80, value: TL.uniqueTimelineName(p, `Timeline ${TL.listTimelines(p).length + 1}`), 'aria-label': 'Name', autofocus: true });
      let ratio = p.settings.ratio === 'original' || p.settings.ratio === 'custom' ? 'same' : p.settings.ratio;
      const shape = selectField({
        label: 'Shape',
        options: [{ value: 'same', label: `Same as now (${p.settings.width} x ${p.settings.height})` }, ...RATIOS.map((r) => ({ value: r.id, label: `${r.label}  ${r.hint}` }))],
        value: ratio,
        onChange: (v) => (ratio = v),
      });
      const ok = h('button.btn.primary', { type: 'submit' }, 'Create');
      const no = h('button.btn', { type: 'button' }, 'Cancel');
      const form = h('form.dialog-form.timeline-form',
        h('p.dialog-text', 'A new, empty timeline that shares this project\'s media. Use it for another cut, a short or a different shape.'),
        h('div.field', h('label.field-label', 'Name'), input),
        shape.el);
      const d = openDialog({ title: 'New timeline', body: form, actions: [no, ok], className: 'small' });
      const submit = (e) => {
        e?.preventDefault();
        d.close({ name: input.value.trim(), ratio: ratio === 'same' ? null : ratio });
      };
      form.addEventListener('submit', submit);
      ok.addEventListener('click', submit);
      no.addEventListener('click', () => d.close(null));
      input.select();
      const v = await d.result;
      if (v) api.create(v);
    },

    duplicate(id = store.project.timelineId) {
      leaveCompounds();
      let copy = null;
      store.update('Duplicate timeline', (p) => {
        TL.ensureTimelines(p);
        copy = TL.duplicateTimeline(p, id ?? p.timelineId);
        if (!copy) return false;
      });
      if (copy) {
        store.openTimeline(copy);
        announce(`Duplicated as ${name(copy)}`);
      } else toast(`A project can hold up to ${TL.MAX_TIMELINES} timelines.`, { kind: 'info' });
      return copy;
    },

    async rename(id = store.project.timelineId) {
      const v = await promptDialog({ title: 'Rename timeline', label: 'Name', value: name(id), confirm: 'Rename', maxLength: 80 });
      if (!v) return;
      store.update('Rename timeline', (p) => {
        TL.ensureTimelines(p);
        return TL.renameTimeline(p, id ?? p.timelineId, v);
      }, { structural: false });
    },

    async remove(id = store.project.timelineId) {
      const list = TL.listTimelines(store.project);
      const t = list.find((x) => x.id === id);
      if (!t || list.length < 2) return;
      const ok = !t.clips || (await confirmDialog({ title: 'Delete timeline?', message: `${t.name} and its ${t.clips} clip${t.clips === 1 ? '' : 's'} will be deleted. Its media stays in the project. You can undo this.`, confirm: 'Delete', danger: true }));
      if (!ok) return;
      leaveCompounds();
      const wasActive = id === store.project.timelineId;
      store.update('Delete timeline', (p) => TL.deleteTimeline(p, id));
      if (wasActive) {
        // Its neighbor is open now.
        store.clearSelection();
        store.seek(0);
        store.emit('timeline', { id: store.project.timelineId });
      }
      announce(`Deleted ${t.name}`);
    },

    /** Put a copy of another timeline into the open one at the playhead, as a compound clip. */
    insert(id) {
      leaveCompounds();
      let clip = null;
      store.update('Insert timeline', (p) => {
        // Like media: onto the base track (rippling it when that is on), else the first track with room.
        clip = TL.insertTimeline(p, id, store.time, { ...store.opts, main: true });
        if (!clip) return false;
      });
      if (clip) {
        store.select(clip.id);
        announce(`Inserted ${clip.name} as a compound clip`);
      } else toast('That timeline is empty.', { kind: 'info' });
    },

    move(id, index) {
      store.update('Reorder timelines', (p) => TL.moveTimeline(p, id, index), { structural: false });
    },

    /** Menu items: the timelines to switch between, then what can be done with the open one. */
    menuItems() {
      const list = api.list();
      const multi = list.length > 1;
      return [
        { heading: 'Timelines' },
        ...list.map((t) => ({ label: t.name, radio: true, checked: t.active, hint: clock(t.duration), onSelect: () => api.open(t.id) })),
        'separator',
        { label: 'New timeline...', icon: 'plus', shortcut: ctx.commands?.keyFor('newTimeline'), onSelect: () => api.createWithDialog() },
        { label: 'Duplicate timeline', icon: 'copy', onSelect: () => api.duplicate() },
        { label: 'Rename timeline...', icon: 'pencil', onSelect: () => api.rename() },
        multi ? { label: 'Insert timeline here', icon: 'layers', submenu: () => list.filter((t) => !t.active).map((t) => ({ label: t.name, disabled: !t.clips, onSelect: () => api.insert(t.id) })) } : null,
        multi ? { label: 'Delete timeline...', icon: 'trash', danger: true, onSelect: () => api.remove() } : null,
      ].filter(Boolean);
    },
  };
  return api;
}
