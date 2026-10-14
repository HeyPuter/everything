// Piano roll header toolbar: channel picker, tools, snap, scale highlight,
// ghost notes and event lane toggles, quick tool buttons and the options menu.
// Narrow panels hide the less used controls (they stay in the options menu)
// through container queries in styles/pianoroll.css.

import { h, announce } from '../lib/dom.js';
import { icon } from '../ui/icons.js';
import { openMenu } from '../ui/menu.js';
import { SNAPS } from '../model/time.js';
import { SCALES, ROOT_NAMES, scaleLabel, detectScale, chordById } from './scales.js';
import { shared } from './state.js';

export const TOOLS = [
  { id: 'draw', label: 'Draw', key: 'P', icon: 'tool-draw', hint: 'Draw: click to add a note, drag to set its length. Drag notes to move, edges to resize, Shift+drag to duplicate, right-click to delete.' },
  { id: 'paint', label: 'Paint', key: 'B', icon: 'tool-paint', hint: 'Paint: drag to paint a run of notes.' },
  { id: 'delete', label: 'Delete', key: 'D', icon: 'tool-delete', hint: 'Delete: click or drag across notes to remove them.' },
  { id: 'slice', label: 'Slice', key: 'C', icon: 'tool-slice', hint: 'Slice: click a note to cut it at the line; drag up or down to cut several rows.' },
  { id: 'select', label: 'Select', key: 'E', icon: 'tool-select', hint: 'Select: drag a box to select notes (Shift adds). Drag selected notes to move them.' },
  { id: 'zoom', label: 'Zoom', key: 'Z', icon: 'tool-zoom', hint: 'Zoom: drag a range to zoom to it, click to zoom in, Alt+click to zoom out.' },
  { id: 'audition', label: 'Audition', key: 'Y', icon: 'tool-play', hint: 'Audition: press and drag over rows to hear them.' },
];

export function buildToolbar(ed) {
  const app = ed.app;

  // ---------------------------------------------------------- channel picker
  const swatch = h('span.pr-swatch');
  const chName = h('span.pr-ch-name');
  const chBtn = h('button.pr-channel', { type: 'button', 'aria-haspopup': 'menu', title: 'Channel to edit', dataset: { hint: 'The channel whose notes the piano roll edits. Selecting a channel in the rack changes it too.' } }, swatch, chName, icon('chevron-down', 14));
  chBtn.addEventListener('click', () => {
    const p = app.store.project;
    openMenu(
      [
        ...p.channels.map((c) => ({ type: 'radio', label: c.name, swatch: c.color, checked: c.id === app.store.view.channel, run: () => app.store.selectChannels([c.id]) })),
        ...(p.channels.length ? [{ type: 'sep' }] : []),
        { type: 'cmd', label: 'Add a synth', icon: 'synth', run: () => app.addChannel({ type: 'synth', name: 'Poly Synth' }) },
      ],
      { anchor: chBtn, label: 'Channel' },
    );
  });

  // ---------------------------------------------------------- tools
  const toolBtns = TOOLS.map((t) => {
    const b = h('button.icon-btn.sm', { type: 'button', 'aria-label': t.label, 'aria-pressed': 'false', title: `${t.label} (${t.key})`, dataset: { hint: `${t.hint} Shortcut: ${t.key}.`, tool: t.id }, onclick: () => ed.setTool(t.id) }, icon(t.icon, 15));
    return b;
  });
  const toolGroup = h('div.pr-tools', { role: 'group', 'aria-label': 'Tools' }, ...toolBtns);
  const toolMenuBtn = h('button.icon-btn.sm.pr-tool-menu', { type: 'button', 'aria-haspopup': 'menu', title: 'Tool' });
  toolMenuBtn.addEventListener('click', () =>
    openMenu(
      TOOLS.map((t) => ({ type: 'radio', label: t.label, icon: t.icon, keys: t.key, checked: ed.tool === t.id, run: () => ed.setTool(t.id) })),
      { anchor: toolMenuBtn, label: 'Tools' },
    ),
  );

  // ---------------------------------------------------------- snap
  const snap = h('select.select.sm.pr-snap-select', { 'aria-label': 'Snap to grid' });
  for (const s of SNAPS) snap.append(h('option', { value: s.id }, s.label));
  snap.addEventListener('change', () => {
    app.prefs.merge('snap', { pianoRoll: snap.value });
    announce(`Snap: ${snap.selectedOptions[0]?.textContent}`);
    ed.surface.focus({ preventScroll: true });
  });
  const snapWrap = h('label.pr-snap', { title: 'Snap to grid. Hold Alt while dragging to place freely.', dataset: { hint: 'Snap: where notes land when drawn, moved or resized. "Line" follows the zoom. Hold Alt while dragging for free placement.' } }, icon('magnet', 14), snap);

  // ---------------------------------------------------------- scale
  const scaleText = h('span');
  const scaleBtn = h('button.btn.sm.ghost.pr-scale', { type: 'button', 'aria-haspopup': 'menu', title: 'Scale highlight', dataset: { hint: 'Scale highlight: shade the rows outside a scale. The riff generator and scale chords use it too.' } }, icon('piano-keys', 14), scaleText);
  scaleBtn.addEventListener('click', () => openMenu(scaleItems(ed), { anchor: scaleBtn, label: 'Scale highlight' }));

  // ---------------------------------------------------------- toggles and quick tools
  const ghostBtn = h('button.icon-btn.sm.pr-opt', { type: 'button', 'aria-label': 'Ghost notes', 'aria-pressed': 'false', title: 'Ghost notes: show other channels in this pattern', onclick: () => app.commands.run('pianoRoll.ghosts') }, icon('layers', 15));
  const laneBtn = h('button.icon-btn.sm.pr-opt', { type: 'button', 'aria-label': 'Event lane', 'aria-pressed': 'false', title: 'Event lane: velocity and pan under the notes', onclick: () => app.commands.run('pianoRoll.lane') }, icon('sliders-horizontal', 15));
  const quickBtn = (id, glyph, extra = '') => {
    const keys = app.commands.keysLabel(id);
    const label = app.commands.label(id).replace(/\.\.\.$/, '');
    return h(`button.icon-btn.sm.pr-quick${extra}`, { type: 'button', 'aria-label': label, title: `${label}${keys ? ` (${keys})` : ''}`, onclick: () => app.commands.run(id) }, icon(glyph, 15));
  };
  const quantBtn = quickBtn('tools.quantize', 'quantize');
  const chordBtn = quickBtn('tools.chords', 'chord');
  const riffBtn = quickBtn('tools.riff', 'wand-sparkles');
  const moreBtn = h('button.icon-btn.sm', { type: 'button', 'aria-haspopup': 'menu', 'aria-label': 'Piano roll options', title: 'Piano roll options (Shift+F10)' }, icon('ellipsis', 16));
  const openMore = (pos) => openMenu(moreItems(ed), pos ? { ...pos, label: 'Piano roll options' } : { anchor: moreBtn, label: 'Piano roll options' });
  moreBtn.addEventListener('click', () => openMore());

  const sep = () => h('span.tool-sep.pr-sep', { 'aria-hidden': 'true' });
  const inner = h('div.pr-toolbar-inner', chBtn, sep(), toolGroup, toolMenuBtn, sep(), snapWrap, h('span.pr-sep-scale', sep()), scaleBtn, h('div.pr-opts', ghostBtn, laneBtn, sep(), quantBtn, chordBtn, riffBtn), h('span.pr-spacer'), moreBtn);
  const el = h('div.pr-toolbar', inner);

  let last = '';
  const sync = () => {
    const ch = ed.channel;
    const p = ed.prefs;
    const tool = ed.tool;
    const key = [ch?.id, ch?.name, ch?.color, tool, ed.snapId, p.scale, p.scaleRoot, p.ghosts, p.lane, shared.stamp?.chord, shared.stamp?.inversion].join('|');
    if (key === last) return;
    last = key;
    swatch.style.background = ch?.color || 'transparent';
    chName.textContent = ch ? ch.name : 'No channel';
    chBtn.setAttribute('aria-label', `Channel: ${ch ? ch.name : 'none'}. Choose the channel to edit`);
    for (const b of toolBtns) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    const t = TOOLS.find((x) => x.id === tool) || TOOLS[0];
    toolMenuBtn.replaceChildren(icon(t.icon, 15));
    toolMenuBtn.setAttribute('aria-label', `Tool: ${t.label}`);
    if (snap.value !== ed.snapId) snap.value = ed.snapId;
    scaleText.textContent = p.scale ? scaleLabel(p.scaleRoot, p.scale) : 'Scale';
    scaleBtn.setAttribute('aria-label', `Scale highlight: ${p.scale ? scaleLabel(p.scaleRoot, p.scale) : 'off'}`);
    scaleBtn.classList.toggle('on', Boolean(p.scale));
    ghostBtn.setAttribute('aria-pressed', String(Boolean(p.ghosts)));
    laneBtn.setAttribute('aria-pressed', String(Boolean(p.lane)));
    chordBtn.setAttribute('aria-pressed', String(Boolean(shared.stamp)));
    chordBtn.title = shared.stamp ? `Chords: stamping ${chordById(shared.stamp.chord)?.label.toLowerCase()}` : 'Chords';
  };
  sync();
  return { el, sync, openMore };
}

/** Scale highlight menu: off, root note, scale type, detect from the notes. */
export function scaleItems(ed) {
  const p = ed.prefs;
  const set = (changes, msg) => {
    ed.setPref(changes);
    const q = ed.prefs;
    announce(msg || (q.scale ? `Scale highlight: ${scaleLabel(q.scaleRoot, q.scale)}` : 'Scale highlight off'));
  };
  return [
    { type: 'radio', label: 'Off', checked: !p.scale, run: () => set({ scale: null }) },
    {
      type: 'cmd',
      label: 'Detect from notes',
      icon: 'sparkles',
      enabled: ed.notes.length > 0,
      run: () => {
        const r = detectScale(ed.notes);
        if (r) set({ scale: r.scale, scaleRoot: r.root });
      },
    },
    { type: 'sep' },
    { type: 'submenu', label: `Root: ${ROOT_NAMES[p.scaleRoot]}`, items: ROOT_NAMES.map((n, i) => ({ type: 'radio', label: n, checked: p.scaleRoot === i, run: () => set({ scaleRoot: i, scale: p.scale || 'major' }) })) },
    { type: 'heading', label: 'Scale' },
    ...SCALES.map((s) => ({ type: 'radio', label: s.label, checked: p.scale === s.id, run: () => set({ scale: s.id }) })),
  ];
}

function moreItems(ed) {
  const app = ed.app;
  const c = (id) => app.commands.menuItem(id);
  const p = ed.prefs;
  return [
    c('edit.selectAll'),
    c('edit.deselect'),
    c('pianoRoll.invertSelection'),
    { type: 'sep' },
    c('tools.quantize'),
    c('tools.chords'),
    c('tools.riff'),
    { type: 'sep' },
    c('pianoRoll.legato'),
    c('pianoRoll.reverse'),
    c('pianoRoll.flip'),
    c('pianoRoll.randomizeVelocity'),
    c('pianoRoll.transpose'),
    { type: 'sep' },
    c('pianoRoll.zoomIn'),
    c('pianoRoll.zoomOut'),
    c('pianoRoll.zoomFit'),
    { type: 'sep' },
    c('pianoRoll.ghosts'),
    c('pianoRoll.lane'),
    { type: 'submenu', label: 'Event lane shows', items: [
      { type: 'radio', label: 'Velocity', checked: p.laneType !== 'pan', run: () => ed.setPref({ laneType: 'vel', lane: true }) },
      { type: 'radio', label: 'Pan', checked: p.laneType === 'pan', run: () => ed.setPref({ laneType: 'pan', lane: true }) },
    ] },
    { type: 'submenu', label: 'Scale highlight', items: () => scaleItems(ed) },
    { type: 'sep' },
    c('options.recordQuantize'),
    c('options.stepEdit'),
    c('options.typingKeyboard'),
  ].filter(Boolean);
}
