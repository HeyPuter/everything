// Channel actions shared by the rack's context menu, its panel actions and
// commands: rename, color, clone, delete, move, step operations, mixer
// routing and instrument type. Each action is one undo step.

import * as E from '../model/edits.js';
import { COLORS, channelById } from '../model/project.js';
import { INSTRUMENTS, defaultParams } from '../instruments/catalog.js';
import { promptDialog, confirmDialog } from '../ui/dialog.js';
import { closeWindows } from '../ui/windows.js';
import { announce } from '../lib/dom.js';
import { editChannelNotes, fillSteps, shiftNotes, randomSteps, paintSteps, freeInsert, stepCount, fitsSteps } from './steps.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function channelActions(app) {
  const store = app.store;
  const ch = (id) => channelById(store.project, id);
  const count = () => stepCount(store.pattern, store.project.sig);
  const editNotes = (label, id, fn) => store.apply(label, (p) => editChannelNotes(p, store.view.pattern, id, fn));

  const a = {
    /** Ids the menu acts on: the selection when it includes `id`, else just `id`. */
    targets(id) {
      const sel = store.view.selectedChannels;
      if (id && !sel.has(id)) return [id];
      const order = store.project.channels.map((c) => c.id).filter((x) => sel.has(x));
      return order.length ? order : id ? [id] : [];
    },

    select(id, { extend = false, toggle = false, anchor = null } = {}) {
      const sel = store.view.selectedChannels;
      const ids = store.project.channels.map((c) => c.id);
      if (extend && anchor && ids.includes(anchor)) {
        const [i0, i1] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
        store.selectChannels(ids.slice(i0, i1 + 1), { primary: id });
      } else if (toggle) {
        const next = new Set(sel);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        store.selectChannels(ids.filter((x) => next.has(x)), { primary: next.has(id) ? id : store.view.channel });
      } else store.selectChannels([id], { primary: id });
    },

    async rename(id) {
      const c = ch(id);
      if (!c) return;
      const name = await promptDialog({ title: 'Rename channel', label: 'Name', value: c.name, confirm: 'Rename', validate: (v) => (v.trim() ? '' : 'Enter a name.') });
      if (name) a.setName(id, name);
    },

    setName(id, name) {
      const c = ch(id);
      const n = String(name).trim().slice(0, 60);
      if (!c || !n || n === c.name) return;
      store.apply('Rename channel', (p) => {
        let next = E.updateChannel(p, id, { name: n });
        // An insert named after the channel follows the rename.
        if (c.mixer > 0 && p.mixer[c.mixer]?.name === c.name) next = E.updateMixerTrack(next, c.mixer, { name: n });
        return next;
      });
    },

    setColor(ids, color) {
      store.apply(ids.length > 1 ? 'Color channels' : 'Channel color', (p) => {
        let next = p;
        for (const id of ids) {
          const c = channelById(p, id);
          if (!c) continue;
          next = E.updateChannel(next, id, { color });
          if (c.mixer > 0 && p.mixer[c.mixer]?.color === c.color && p.channels.filter((x) => x.mixer === c.mixer).length === 1) next = E.updateMixerTrack(next, c.mixer, { color });
        }
        return next;
      });
    },

    clone(ids, { withNotes = false } = {}) {
      const made = [];
      store.apply(ids.length > 1 ? 'Clone channels' : 'Clone channel', (p) => {
        let next = p;
        // Clone from the bottom up so each copy lands right under its source.
        for (const id of [...ids].reverse()) {
          const r = E.cloneChannel(next, id, { withNotes });
          if (r.id) {
            next = r.project;
            made.unshift(r.id);
          }
        }
        return next;
      });
      if (made.length) {
        store.selectChannels(made);
        announce(`Cloned ${plural(made.length, 'channel')}`);
      }
      return made;
    },

    async remove(ids) {
      const list = ids.filter((id) => ch(id));
      if (!list.length) return false;
      const p = store.project;
      const set = new Set(list);
      const hasNotes = p.patterns.some((pat) => list.some((id) => pat.notes[id]?.length)) || p.clips.some((c) => c.kind === 'audio' && set.has(c.ref));
      if (hasNotes) {
        const what = list.length === 1 ? `"${ch(list[0]).name}"` : plural(list.length, 'channel');
        const ok = await confirmDialog({ title: list.length === 1 ? 'Delete channel' : 'Delete channels', message: `${what} ${list.length === 1 ? 'has' : 'have'} notes. Delete ${list.length === 1 ? 'it' : 'them'} and ${list.length === 1 ? 'its' : 'their'} notes in every pattern?`, confirm: 'Delete', danger: true });
        if (!ok) return false;
      }
      const names = list.map((id) => ch(id).name);
      store.apply(list.length > 1 ? 'Delete channels' : 'Delete channel', (proj) => E.removeChannels(proj, list));
      for (const id of list) closeWindows(`channel:${id}`);
      app.notify(list.length === 1 ? `Deleted ${names[0]}` : `Deleted ${plural(list.length, 'channel')}`);
      return true;
    },

    move(ids, delta) {
      const chans = store.project.channels;
      const idx = ids.map((id) => chans.findIndex((c) => c.id === id)).filter((i) => i >= 0).sort((x, y) => x - y);
      if (!idx.length) return;
      if (delta < 0 && idx[0] === 0) return;
      if (delta > 0 && idx.at(-1) === chans.length - 1) return;
      store.apply(ids.length > 1 ? 'Move channels' : 'Move channel', (p) => {
        let next = p;
        const order = delta > 0 ? [...idx].reverse() : idx;
        for (const i of order) next = E.moveChannel(next, chans[i].id, i + delta);
        return next;
      });
      announce(`Moved ${delta < 0 ? 'up' : 'down'}`);
    },

    moveTo(id, index) {
      store.apply('Move channel', (p) => E.moveChannel(p, id, index));
    },

    openPianoRoll(id) {
      store.selectChannels([id], { primary: id });
      app.shell.show('pianoRoll');
    },

    openEditor(id) {
      app.openChannelEditor?.(id);
    },

    toggleMute(ids) {
      const chans = ids.map(ch).filter(Boolean);
      if (!chans.length) return;
      const mute = !chans[0].mute;
      store.apply(mute ? 'Mute channel' : 'Unmute channel', (p) => chans.reduce((next, c) => E.updateChannel(next, c.id, { mute }), p));
      announce(`${chans.length === 1 ? chans[0].name : plural(chans.length, 'channel')} ${mute ? 'muted' : 'on'}`);
    },

    solo(id) {
      store.apply('Solo channel', (p) => E.soloChannel(p, id));
      const c = ch(id);
      announce(c?.solo ? `${c.name} solo` : 'Solo off');
    },

    fill(ids, every) {
      const n = count();
      store.apply(`Fill every ${every} steps`, (p) => ids.reduce((next, id) => editChannelNotes(next, store.view.pattern, id, (_, c) => fillSteps(n, every, c.root)), p));
    },

    shift(ids, by) {
      const n = count();
      store.apply(by < 0 ? 'Shift steps left' : 'Shift steps right', (p) => ids.reduce((next, id) => editChannelNotes(next, store.view.pattern, id, (notes) => shiftNotes(notes, by, n)), p));
    },

    clear(ids) {
      store.apply(ids.length > 1 ? 'Clear channels' : 'Clear steps', (p) => ids.reduce((next, id) => editChannelNotes(next, store.view.pattern, id, (notes) => (notes.length ? [] : notes)), p));
    },

    randomize(ids, density = 0.5) {
      const n = count();
      const sig = store.project.sig;
      store.apply('Randomize steps', (p) => ids.reduce((next, id) => editChannelNotes(next, store.view.pattern, id, (_, c) => randomSteps(n, { root: c.root, density, sig })), p));
    },

    /** Paints steps (used by keyboard toggles and tests). */
    setStep(id, step, on) {
      editNotes(on ? 'Step on' : 'Step off', id, (notes, c) => paintSteps(notes, [step], on, c.root));
    },

    assignFree(ids) {
      store.apply('Assign mixer inserts', (p) => {
        let next = p;
        for (const id of ids) {
          const c = channelById(next, id);
          const i = freeInsert(next, id);
          if (!c || !i) continue;
          next = E.updateChannel(next, id, { mixer: i });
          next = E.updateMixerTrack(next, i, { name: c.name, color: c.color });
        }
        return next;
      });
      const c = ch(ids[0]);
      if (c) app.notify(c.mixer ? `${c.name} routed to insert ${c.mixer}` : 'Every insert is in use');
    },

    setInsert(id, index) {
      store.apply('Route to insert', (p) => E.updateChannel(p, id, { mixer: index }));
    },

    changeType(ids, type) {
      store.apply('Change instrument', (p) => ids.reduce((next, id) => {
        const c = channelById(next, id);
        if (!c || c.type === type) return next;
        return E.updateChannel(next, id, { type, params: defaultParams(type), name: c.name === INSTRUMENTS[c.type]?.label ? INSTRUMENTS[type].label : c.name });
      }, p));
    },

    fits(id) {
      const c = ch(id);
      return c ? fitsSteps(store.pattern.notes[id], c.root) : true;
    },
  };
  return a;
}

/** Context menu items for channel `id` (acting on the selection when it includes it). */
export function channelMenuItems(app, actions, id) {
  const ids = actions.targets(id);
  const c = channelById(app.store.project, id);
  if (!c) return [];
  const many = ids.length > 1;
  const stepRow = actions.fits(id);
  const chans = app.store.project.channels;
  const index = chans.findIndex((x) => x.id === id);
  return [
    { type: 'heading', label: many ? `${ids.length} channels` : c.name },
    { label: 'Open editor', keys: 'Enter', icon: 'sliders-horizontal', enabled: !many, run: () => actions.openEditor(id) },
    { label: 'Open in piano roll', icon: 'win-piano', enabled: !many, run: () => actions.openPianoRoll(id) },
    { label: 'Rename...', keys: 'F2', icon: 'pencil', enabled: !many, run: () => actions.rename(id) },
    { type: 'submenu', label: 'Color', items: () => COLORS.map((col, i) => ({ type: 'radio', label: `Color ${i + 1}`, swatch: col, checked: !many && c.color === col, run: () => actions.setColor(ids, col) })) },
    { type: 'sep' },
    { label: c.mute ? 'Unmute' : 'Mute', keys: 'M', run: () => actions.toggleMute(ids) },
    { label: c.solo ? 'Unsolo' : 'Solo', keys: 'S', enabled: !many, run: () => actions.solo(id) },
    { type: 'sep' },
    { label: many ? 'Clone channels' : 'Clone', keys: app.commands.keysLabel('edit.duplicate'), icon: 'copy', run: () => actions.clone(ids) },
    { label: 'Clone with notes', run: () => actions.clone(ids, { withNotes: true }) },
    { label: many ? 'Delete channels' : 'Delete', keys: 'Del', icon: 'trash-2', run: () => actions.remove(ids) },
    { label: 'Move up', keys: app.commands.keysLabel('rack.moveUp'), icon: 'arrow-up', enabled: index > 0, run: () => actions.move(ids, -1) },
    { label: 'Move down', keys: app.commands.keysLabel('rack.moveDown'), icon: 'arrow-down', enabled: index < chans.length - 1, run: () => actions.move(ids, 1) },
    { type: 'sep' },
    {
      type: 'submenu',
      label: 'Steps',
      items: () => [
        { label: 'Fill every 2 steps', enabled: stepRow, run: () => actions.fill(ids, 2) },
        { label: 'Fill every 4 steps', enabled: stepRow, run: () => actions.fill(ids, 4) },
        { label: 'Fill every 8 steps', enabled: stepRow, run: () => actions.fill(ids, 8) },
        { type: 'sep' },
        { label: 'Shift left', icon: 'chevron-left', run: () => actions.shift(ids, -1) },
        { label: 'Shift right', icon: 'chevron-right', run: () => actions.shift(ids, 1) },
        { type: 'sep' },
        { label: 'Randomize', icon: 'dices', enabled: stepRow, run: () => actions.randomize(ids) },
        { label: stepRow ? 'Clear steps' : 'Clear notes', icon: 'eraser', run: () => actions.clear(ids) },
      ],
    },
    { label: 'Assign to free mixer insert', icon: 'win-mixer', run: () => actions.assignFree(ids) },
    {
      type: 'submenu',
      label: 'Change instrument',
      items: () => ['synth', 'drum', 'sampler'].map((t) => ({ type: 'radio', label: INSTRUMENTS[t].label, checked: !many && c.type === t, run: () => actions.changeType(ids, t) })),
    },
  ];
}

