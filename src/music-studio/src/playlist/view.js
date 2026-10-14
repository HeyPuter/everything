// The playlist view: layout (source picker, track headers, ruler, clip
// canvas), its state (zoom, scroll, selection, tool, source, keyboard
// cursor), scrolling and zoom, the frame loop (draw when dirty, playhead as
// a DOM line so playback never forces a canvas redraw), the keyboard model
// of the arrangement canvas, drops and the panel actions.
//
// The canvas region is an overlaid native scroller (role="application")
// holding a spacer the size of the arrangement, so scrollbars, trackpads and
// Shift+wheel scroll natively; the WebGL canvas underneath draws the visible
// window from the scroll position.

import '../styles/playlist.css';
import { h, announce } from '../lib/dom.js';
import { clamp } from '../lib/util.js';
import { icon, registerIcons } from '../ui/icons.js';
import { createGfx } from '../render/gfx.js';
import { Viewport } from '../render/timeline.js';
import { openMenu, isContextKey } from '../ui/menu.js';
import { promptDialog } from '../ui/dialog.js';
import { getDragData, dragHasPayload } from '../lib/dnd.js';
import * as E from '../model/edits.js';
import { songLength, patternById } from '../model/project.js';
import { SNAPS, snapTicks, snapFloor, snapRound, ticksPerBar, ticksPerBeat, barLabel, formatBST, secondsToTicks, STEP } from '../model/time.js';
import { evaluateAutomation } from '../automation/evaluate.js';
import { hitPoint } from '../automation/points.js';
import { isSignedIn, readFile } from '../storage/puter.js';
import * as C from './clips.js';
import { trackLayout, trackAt, trackTop, trackHeight, clipZone } from './geometry.js';
import { drawCanvas, drawRulerLayer, resetColors, AUTO_EDIT_MIN_H } from './render.js';
import { createHeaders } from './headers.js';
import { createPicker, listSources } from './picker.js';
import { installPointer } from './pointer.js';
import { installCurves } from './curves.js';
import * as M from './menus.js';
import { LOOP_STRIP_H, TITLE_H, PICKER_W, DEFAULT_PX_PER_TICK, DEFAULT_TRACK_H } from './constants.js';

registerIcons({
  'pl-picker': [['rect', { x: '3', y: '4', width: '18', height: '16', rx: '1.5' }], ['path', { d: 'M9 4v16' }], ['path', { d: 'M5 8h2M5 11.5h2M5 15h2' }]],
  'pl-follow': [['path', { d: 'M8 3v18' }], ['path', { d: 'M12 12h8' }], ['path', { d: 'm17 9 3 3-3 3' }]],
  'pl-fit': [['path', { d: 'M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3' }], ['path', { d: 'M7 12h10' }], ['path', { d: 'm10 9-3 3 3 3M14 9l3 3-3 3' }]],
  'pl-add-track': [['rect', { x: '3', y: '5', width: '18', height: '5', rx: '1' }], ['path', { d: 'M12 14v6M9 17h6' }]],
});

export const TOOLS = [
  { id: 'draw', label: 'Draw', key: 'P', icon: 'tool-draw', tip: 'Click to place the selected source, drag right to set its length' },
  { id: 'paint', label: 'Paint', key: 'B', icon: 'tool-paint', tip: 'Drag to paint repeated copies' },
  { id: 'delete', label: 'Delete', key: 'D', icon: 'tool-delete', tip: 'Click or drag over clips to delete them' },
  { id: 'mute', label: 'Mute', key: 'T', icon: 'tool-mute', tip: 'Click or drag over clips to mute them' },
  { id: 'slice', label: 'Slice', key: 'C', icon: 'tool-slice', tip: 'Cut clips at the pointer' },
  { id: 'select', label: 'Select', key: 'E', icon: 'tool-select', tip: 'Drag to select; Ctrl or Cmd+drag selects with any tool' },
  { id: 'zoom', label: 'Zoom', key: 'Z', icon: 'tool-zoom', tip: 'Click to zoom in, Alt+click out, drag a range' },
  { id: 'playback', label: 'Playback', key: 'Y', icon: 'tool-play', tip: 'Press and hold to play from the pointer, drag to scrub' },
];

let clipboard = null; // shared across project loads in this session

const ui = (app) => app.prefs.get('playlistUi') || {};

export function createPlaylistView(app, host) {
  const { store, engine, prefs } = app;
  const coarse = matchMedia('(pointer: coarse)');

  const V = {
    app,
    store,
    vp: new Viewport({ pxPerTick: DEFAULT_PX_PER_TICK, minPx: 0.004, maxPx: 3 }),
    scrollY: 0,
    layout: trackLayout(store.project.tracks),
    byTrack: C.clipsByTrack(store.project.clips, store.project.tracks.length),
    selection: new Set(),
    selectedTrack: 0,
    source: store.view.pattern ? { kind: 'pattern', id: store.view.pattern } : null,
    cursor: { track: 0, tick: 0 },
    kbd: false,
    focused: false,
    overlay: null,
    hoverPoint: null,
    dirty: true,
    visible: false,
    lastFocusClip: null,
  };

  // ---------------------------------------------------------------- DOM

  const picker = createPicker(V);
  const headers = createHeaders(V);
  V.headers = headers;
  const pickerSplit = h('div.pl-picker-split', { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize clip source list', tabindex: '0', title: 'Drag to resize the clip source list' });
  const addTrackBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Add track', title: 'Add a track at the bottom', onclick: () => addTrack() }, icon('pl-add-track', 14));
  const corner = h('div.pl-corner', h('span.pl-corner-label', 'Tracks'), addTrackBtn);
  const rulerHost = h('div.pl-ruler', {
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Song position',
    'aria-valuemin': '0',
    dataset: { hint: 'Click or drag to set the song position. Drag the top strip (or Shift+drag) to set the loop; double-click clears it. Right-click for markers.' },
  });
  const rulerHead = h('div.pl-ruler-head', { 'aria-hidden': 'true' });
  rulerHost.append(rulerHead);
  const canvasHost = h('div.pl-canvas');
  const playhead = h('div.pl-playhead', { 'aria-hidden': 'true' });
  const spacer = h('div.pl-spacer');
  const helpId = `pl-help-${Math.random().toString(36).slice(2, 7)}`;
  const scroller = h(
    'div.pl-scroller',
    {
      tabindex: '0',
      role: 'application',
      'aria-roledescription': 'arrangement',
      'aria-label': 'Playlist arrangement',
      'aria-describedby': helpId,
    },
    spacer,
  );
  const help = h(
    'p.sr-only',
    { id: helpId },
    'Tab and Shift+Tab move between clips in time order. Arrow keys move the selected clips, or the cursor when nothing is selected; Alt+arrows always move the cursor. Enter opens the clip under the cursor or places the selected source there. Shift+Left and Right change the selected clips length. Delete removes the selection.',
  );
  canvasHost.append(playhead, scroller, help);
  const root = h('div.pl', picker.el, pickerSplit, corner, rulerHost, headers.el, canvasHost);
  host.body.append(root);

  const gMain = createGfx(canvasHost);
  const gRuler = createGfx(rulerHost);
  // The canvases sit under the scroller and the playhead line.
  canvasHost.prepend(gMain.canvas, gMain.overlay);
  rulerHost.prepend(gRuler.canvas, gRuler.overlay);

  // ---------------------------------------------------------------- toolbar

  const toolBtns = new Map();
  const toolGroup = h('div.pl-tool-group', { role: 'toolbar', 'aria-label': 'Playlist tools' });
  for (const t of TOOLS) {
    const b = h('button.icon-btn.sm', { type: 'button', 'aria-label': `${t.label} tool`, 'aria-pressed': 'false', title: `${t.label} (${t.key}): ${t.tip}`, onclick: () => V.setTool(t.id) }, icon(t.icon, 15));
    toolBtns.set(t.id, b);
    toolGroup.append(b);
  }
  toolGroup.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const list = [...toolBtns.values()];
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    list[(i + (e.key === 'ArrowLeft' ? -1 : 1) + list.length) % list.length].focus();
  });
  const pickerBtn = h('button.icon-btn.sm.pl-picker-btn', { type: 'button', 'aria-label': 'Show clip sources', 'aria-pressed': 'true', title: 'Show or hide the clip source list', onclick: () => prefs.merge('playlistUi', { picker: ui(app).picker === false }) }, icon('pl-picker', 15));
  const sourceSwatch = h('span.pl-source-swatch');
  const sourceName = h('span.pl-source-name');
  const sourceBtn = h('button.pl-source-btn', { type: 'button', 'aria-haspopup': 'menu', title: 'Source the Draw and Paint tools place' }, sourceSwatch, sourceName, icon('chevron-down', 12));
  sourceBtn.addEventListener('click', () => {
    const p = store.project;
    openMenu(
      listSources(p).map((src) => ({ type: 'radio', label: C.sourceName(p, src), swatch: C.sourceColor(p, src), checked: V.source?.kind === src.kind && V.source?.id === src.id, run: () => V.setSource(src) })),
      { anchor: sourceBtn, label: 'Clip source' },
    );
  });
  const snapSel = h('select.select.sm.pl-snap', { 'aria-label': 'Snap', title: 'Snap to grid (hold Alt while dragging to bypass)' }, ...SNAPS.map((s) => h('option', { value: s.id }, s.label)));
  snapSel.addEventListener('change', () => {
    prefs.merge('snap', { playlist: snapSel.value });
    announce(`Snap: ${SNAPS.find((s) => s.id === snapSel.value)?.label}`);
  });
  const snapWrap = h('label.pl-snap-wrap', { title: 'Snap to grid' }, icon('snap-grid', 14), snapSel);
  const followBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Follow playhead', 'aria-pressed': 'false', title: 'Follow the playhead while playing', onclick: () => prefs.toggle('autoScroll') }, icon('pl-follow', 15));
  const zoomOutBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out (-)', onclick: () => V.zoomAt(1 / 1.5) }, icon('zoom-out', 15));
  const zoomInBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in (=)', onclick: () => V.zoomAt(1.5) }, icon('zoom-in', 15));
  const fitBtn = h('button.icon-btn.sm', { type: 'button', 'aria-label': 'Zoom to fit song', title: 'Zoom to fit the song', onclick: () => V.zoomFit() }, icon('pl-fit', 15));
  const toolbar = h('div.pl-toolbar', pickerBtn, sourceBtn, h('span.tool-sep'), toolGroup, h('span.tool-sep'), snapWrap, followBtn, h('span.tool-sep'), zoomOutBtn, zoomInBtn, fitBtn);

  function syncToolbar() {
    for (const [id, b] of toolBtns) b.setAttribute('aria-pressed', String(V.tool() === id));
    snapSel.value = prefs.get('snap').playlist || 'line';
    followBtn.setAttribute('aria-pressed', String(Boolean(prefs.get('autoScroll'))));
    const showPicker = ui(app).picker !== false;
    pickerBtn.setAttribute('aria-pressed', String(showPicker));
    root.classList.toggle('no-picker', !showPicker);
    toolbar.classList.toggle('show-source', !showPicker);
    root.style.setProperty('--pl-picker-w', `${clamp(ui(app).pickerW || PICKER_W, 110, 360)}px`);
    syncSource();
  }

  function syncSource() {
    const p = store.project;
    const ok = V.source && C.sourceExists(p, V.source);
    sourceSwatch.style.background = ok ? C.sourceColor(p, V.source) : 'transparent';
    sourceName.textContent = ok ? C.sourceName(p, V.source) : 'No source';
    sourceBtn.setAttribute('aria-label', `Clip source: ${ok ? C.sourceName(p, V.source) : 'none'}. Change source`);
  }

  // ---------------------------------------------------------------- state helpers

  V.tool = () => app.tools.playlist || 'draw';
  V.setTool = (id) => {
    if (!TOOLS.some((t) => t.id === id)) return;
    app.tools.playlist = id;
    syncToolbar();
    const t = TOOLS.find((x) => x.id === id);
    announce(`${t.label} tool`);
    app.hint(`${t.label} tool: ${t.tip}`);
  };
  V.markDirty = () => {
    V.dirty = true;
  };
  V.grid = (e) => (e?.altKey ? 0 : snapTicks(prefs.get('snap').playlist, V.vp.pxPerTick, store.project.sig) || 0);
  V.stepGrid = () => V.grid() || STEP;
  V.snapFloor = (t, e) => Math.max(0, snapFloor(t, V.grid(e)));
  V.snapRound = (t, e) => Math.max(0, snapRound(t, V.grid(e)));
  V.barTicks = () => ticksPerBar(store.project.sig);
  V.songPos = () => (engine.mode === 'song' ? engine.position : V.cursor.tick);
  V.clipboard = () => clipboard;
  V.durations = () => {
    const out = {};
    for (const ch of store.project.channels) {
      if (ch.type === 'audio' && ch.sample) {
        const s = app.samples.get(ch.sample);
        if (s) out[ch.sample] = s.duration;
      }
    }
    return out;
  };

  /** Pointer position: canvas x, content y (scroll included), tick and track. */
  V.point = (e) => {
    const r = canvasHost.getBoundingClientRect();
    return V.pointAt(e.clientX - r.left, e.clientY - r.top + V.scrollY);
  };
  V.pointAt = (x, y) => ({ x, y, tick: Math.max(0, V.vp.tick(x)), track: trackAt(V.layout, y) });

  /** What is under a point: { clip, zone, auto } or null. */
  V.hit = (pt) => {
    const clip = C.clipAt(V.byTrack, pt.track, pt.tick);
    if (!clip) return null;
    const ppt = V.vp.pxPerTick;
    const x0 = V.vp.x(clip.start);
    const w = clip.len * ppt;
    const y0 = trackTop(V.layout, clip.track) + 1;
    const hh = trackHeight(V.layout, clip.track) - 2;
    const zone = clipZone(x0, w, pt.x, coarse.matches ? 12 : 6);
    const title = pt.y - y0 < TITLE_H;
    let auto = null;
    if (clip.kind === 'auto' && hh + 2 >= AUTO_EDIT_MIN_H && !title && zone === 'body') {
      const a = store.project.automation[clip.ref];
      if (a) {
        const cy = y0 + TITLE_H + 1;
        const ch = hh - TITLE_H - 3;
        const bottom = cy + ch;
        const toX = (t) => (t < clip.offset || t > clip.offset + clip.len ? -1e9 : x0 + (t - clip.offset) * ppt);
        const toY = (v) => bottom - v * ch;
        const index = hitPoint(a.points, toX, toY, pt.x, pt.y, coarse.matches ? 14 : 7);
        const lineY = toY(evaluateAutomation(a.points, clip.offset + (pt.x - x0) / ppt) ?? 0);
        auto = { a, index, onLine: Math.abs(pt.y - lineY) <= (coarse.matches ? 12 : 6), cy, ch, bottom };
      }
    }
    return { clip, zone, title, auto, x0, w };
  };

  V.setSelection = (ids) => {
    V.selection = new Set(ids);
    V.markDirty();
  };

  V.selectClips = (ids, { announce: say = true, reveal = false } = {}) => {
    V.setSelection(ids);
    const clips = store.project.clips.filter((c) => V.selection.has(c.id));
    if (clips.length === 1) V.lastFocusClip = clips[0].id;
    if (reveal && clips.length) V.revealClip(C.timeOrder(clips)[0]);
    if (say) {
      if (clips.length === 1) V.announceClip(clips[0]);
      else announce(clips.length ? `${clips.length} clips selected` : 'Selection cleared');
    }
  };

  V.clipText = (clip, prefix = '') => {
    const p = store.project;
    const t = p.tracks[clip.track];
    const kind = clip.kind === 'pattern' ? 'Pattern' : clip.kind === 'audio' ? 'Audio' : 'Automation';
    const tn = t && !/^Track \d+$/.test(t.name) ? ` (${t.name})` : '';
    return `${prefix}${kind} ${C.sourceName(p, C.sourceOf(clip))} on Track ${clip.track + 1}${tn}, bar ${barLabel(clip.start, p.sig)} to bar ${barLabel(clip.start + clip.len, p.sig)}${clip.mute ? ', muted' : ''}${V.selection.has(clip.id) && V.selection.size > 1 ? `, ${V.selection.size} selected` : ''}`;
  };
  V.announceClip = (clip, prefix = '') => {
    if (clip) announce(V.clipText(clip, prefix));
  };

  V.selectTrack = (i, { announce: say = true } = {}) => {
    const t = store.project.tracks[i];
    if (!t) return;
    V.selectedTrack = i;
    V.cursor.track = i;
    headers.render();
    V.markDirty();
    if (say) announce(`Track ${i + 1}: ${t.name}`);
  };

  V.setSource = (src, { focus = false } = {}) => {
    V.source = src;
    picker.sync();
    syncSource();
    if (focus) {
      if (ui(app).picker === false && !root.closest('.is-phone')) prefs.merge('playlistUi', { picker: true });
      picker.el.querySelector('[aria-selected="true"]')?.focus();
    }
  };

  V.openSource = (src) => {
    if (src.kind === 'pattern') {
      store.setPattern(src.id);
      V.setSource(src);
      app.shell.show('rack');
    } else if (src.kind === 'audio') {
      if (app.openChannelEditor) app.openChannelEditor(src.id);
      else app.notify('Channel settings are not available yet');
    } else {
      V.selectClips(store.project.clips.filter((c) => c.kind === 'auto' && c.ref === src.id).map((c) => c.id), { reveal: true });
    }
  };

  V.openClip = (clip) => {
    const p = store.project;
    if (clip.kind === 'pattern') {
      const pat = patternById(p, clip.ref);
      if (!pat) return;
      store.setPattern(pat.id);
      V.setSource(C.sourceOf(clip));
      const used = Object.keys(pat.notes).filter((k) => pat.notes[k].length);
      const ch = used.length === 1 ? p.channels.find((c) => c.id === used[0]) : null;
      const melodic = ch && ch.type !== 'drum' && new Set(pat.notes[ch.id].map((n) => n.key)).size > 1;
      if (melodic && app.shell.panels.has('pianoRoll')) {
        store.selectChannels([ch.id]);
        app.shell.show('pianoRoll');
      } else app.shell.show('rack');
    } else if (clip.kind === 'audio') {
      if (app.openChannelEditor) app.openChannelEditor(clip.ref);
    } else {
      V.selectClips([clip.id]);
      if ((store.project.tracks[clip.track]?.height || DEFAULT_TRACK_H) < AUTO_EDIT_MIN_H) {
        store.apply('Track height', (q) => E.updateTrack(q, clip.track, { height: C.TRACK_HEIGHTS.large }));
      }
    }
  };

  V.clipMenu = (clip, at, opts) => M.clipMenu(V, clip, at, opts);
  V.emptyMenu = (pt, at) => M.emptyMenu(V, pt, at);
  V.trackMenu = (i, at) => M.trackMenu(V, i, at);
  V.sourceMenu = (src, at) => M.sourceMenu(V, src, at);
  V.renameSource = (src) => M.renameSource(V, src);

  V.makeUnique = (clipId) => {
    const r = store.apply('Make unique', (p) => C.makeUnique(p, clipId));
    if (!r?.id) return;
    const clip = store.project.clips.find((c) => c.id === clipId);
    V.setSource(C.sourceOf(clip));
    if (clip.kind === 'pattern') store.setPattern(r.id);
    announce(`Clip now uses ${C.sourceName(store.project, C.sourceOf(clip))}`);
  };

  V.splitAtPlayhead = (ids) => {
    const pos = Math.round(V.songPos());
    const set = new Set(ids);
    const r = store.apply('Split clips', (p) => C.sliceClips(p, pos, (c) => set.has(c.id)));
    if (r?.ids?.length) announce(`Split ${r.ids.length} clip${r.ids.length === 1 ? '' : 's'}`);
  };

  V.placeAt = (track, tick) => {
    const src = V.source;
    if (!src || !C.sourceExists(store.project, src)) {
      app.notify('Pick a pattern, audio clip or automation in the picker first');
      return;
    }
    const r = store.apply('Add clip', (p) => C.placeClip(p, src, track, tick, undefined, V.durations()));
    V.selectClips([r.id], { announce: false });
    V.announceClip(store.project.clips.find((c) => c.id === r.id), 'Placed ');
  };

  V.pasteAt = (tick, track) => {
    if (!clipboard) return;
    const r = store.apply('Paste clips', (p) => C.pasteClips(p, clipboard, tick, track));
    if (r?.ids?.length) {
      V.selectClips(r.ids, { announce: false, reveal: true });
      announce(`Pasted ${r.ids.length} clip${r.ids.length === 1 ? '' : 's'}`);
    } else app.notify('Nothing to paste: the copied clips sources were deleted');
  };

  V.addMarker = async (tick) => {
    const name = await promptDialog({ title: 'Add marker', label: 'Name', value: C.nextMarkerName(store.project), confirm: 'Add', validate: (s) => (s.trim() ? '' : 'Enter a name.') });
    if (!name) return;
    store.apply('Add marker', (p) => C.addMarker(p, { pos: tick, name: name.trim().slice(0, 60) }));
    announce(`Marker ${name.trim()} at ${formatBST(tick, store.project.sig)}`);
  };

  V.loopSelection = () => {
    const sel = store.project.clips.filter((c) => V.selection.has(c.id));
    if (!sel.length) return;
    const a = Math.min(...sel.map((c) => c.start));
    const b = Math.max(...sel.map((c) => c.start + c.len));
    store.apply('Set loop', (p) => E.setLoop(p, { start: a, end: b }));
  };

  function addTrack() {
    const n = store.project.tracks.length;
    store.apply('Add track', (p) => E.ensureTracks(p, n + 1));
    V.selectTrack(n);
    V.revealTrack(n);
  }

  // ---------------------------------------------------------------- scrolling and zoom

  const viewH = () => scroller.clientHeight || 1;

  function syncSpacer() {
    const p = store.project;
    const bar = ticksPerBar(p.sig);
    const span = (scroller.clientWidth || 600) / V.vp.pxPerTick;
    const ticks = Math.max(songLength(p) + bar * 16, p.loop ? p.loop.end + bar * 8 : 0, V.vp.scroll + span * 1.5, bar * 64);
    spacer.style.width = `${Math.ceil(ticks * V.vp.pxPerTick)}px`;
    spacer.style.height = `${Math.ceil(V.layout.total + DEFAULT_TRACK_H * 3)}px`;
  }

  let applying = false;
  function applyScroll() {
    syncSpacer();
    applying = true;
    scroller.scrollLeft = V.vp.scroll * V.vp.pxPerTick;
    scroller.scrollTop = V.scrollY;
    applying = false;
    readScroll(true);
  }

  function readScroll(force) {
    const left = scroller.scrollLeft / V.vp.pxPerTick;
    // Keep sub-pixel scroll positions set in code unless the user scrolled.
    if (force ? Math.abs(left - V.vp.scroll) * V.vp.pxPerTick > 1 : true) V.vp.scroll = left;
    V.scrollY = scroller.scrollTop;
    headers.syncScroll();
    V.markDirty();
  }

  scroller.addEventListener('scroll', () => {
    if (applying) return;
    readScroll(false);
    if (scroller.scrollLeft + scroller.clientWidth > spacer.offsetWidth - 400) syncSpacer();
  });

  V.setScroll = (tick, top) => {
    V.vp.scroll = Math.max(0, tick);
    V.scrollY = clamp(top, 0, Math.max(0, V.layout.total + DEFAULT_TRACK_H * 3 - viewH()));
    applyScroll();
  };
  V.scrollBy = (dx, dy) => V.setScroll(V.vp.scroll + dx / V.vp.pxPerTick, V.scrollY + dy);

  V.zoomAt = (factor, x = V.vp.width / 2) => {
    V.vp.zoomAt(factor, x);
    applyScroll();
  };
  V.zoomToRange = (a, b) => {
    if (b - a < STEP) return;
    V.vp.fit(a, b);
    applyScroll();
  };
  V.zoomFit = () => {
    const p = store.project;
    const end = Math.max(songLength(p), ticksPerBar(p.sig) * 4);
    V.vp.fit(0, end * 1.04);
    V.vp.scroll = 0;
    applyScroll();
    announce('Zoomed to fit the song');
  };

  V.revealTrack = (i) => {
    const top = trackTop(V.layout, i);
    const bottom = top + trackHeight(V.layout, i);
    if (top < V.scrollY) V.setScroll(V.vp.scroll, top);
    else if (bottom > V.scrollY + viewH()) V.setScroll(V.vp.scroll, bottom - viewH());
  };
  V.revealTick = (tick) => {
    const span = V.vp.width / V.vp.pxPerTick;
    if (tick < V.vp.scroll || tick > V.vp.scroll + span * 0.95) V.setScroll(tick - span * 0.1, V.scrollY);
  };
  V.revealClip = (clip) => {
    if (!clip) return;
    V.revealTick(clip.start);
    V.revealTrack(clip.track);
  };

  const onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = canvasHost.getBoundingClientRect();
    V.zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), clamp(e.clientX - r.left, 0, V.vp.width));
  };
  scroller.addEventListener('wheel', onWheel, { passive: false });
  rulerHost.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) return onWheel(e);
      e.preventDefault();
      V.scrollBy(e.deltaX + e.deltaY, 0);
    },
    { passive: false },
  );

  // Picker splitter.
  pickerSplit.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      pickerSplit.setPointerCapture(e.pointerId);
    } catch {
      // The pointer may already be gone.
    }
    const x0 = e.clientX;
    const w0 = picker.el.offsetWidth;
    const move = (ev) => root.style.setProperty('--pl-picker-w', `${clamp(w0 + ev.clientX - x0, 110, 360)}px`);
    const up = (ev) => {
      pickerSplit.removeEventListener('pointermove', move);
      pickerSplit.removeEventListener('pointerup', up);
      prefs.merge('playlistUi', { pickerW: clamp(w0 + ev.clientX - x0, 110, 360) });
    };
    pickerSplit.addEventListener('pointermove', move);
    pickerSplit.addEventListener('pointerup', up);
  });
  pickerSplit.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const w = clamp((ui(app).pickerW || PICKER_W) + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 40 : 10), 110, 360);
    prefs.merge('playlistUi', { pickerW: w });
  });

  // ---------------------------------------------------------------- ruler

  rulerHost.addEventListener('contextmenu', (e) => e.preventDefault());
  rulerHost.addEventListener('pointerdown', (e) => {
    const r = rulerHost.getBoundingClientRect();
    const x = e.clientX - r.left;
    const tick = Math.max(0, V.vp.tick(x));
    if (e.button === 2) {
      M.rulerMenu(V, tick, { x: e.clientX, y: e.clientY });
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    rulerHost.focus({ preventScroll: true });
    try {
      rulerHost.setPointerCapture(e.pointerId);
    } catch {
      // The pointer may already be gone.
    }
    const loopMode = e.shiftKey || e.clientY - r.top < LOOP_STRIP_H + 1;
    let move;
    if (loopMode) {
      const a = V.snapRound(tick, e);
      store.begin('Set loop');
      move = (ev) => {
        const b = V.snapRound(Math.max(0, V.vp.tick(ev.clientX - r.left)), ev);
        store.preview((p) => E.setLoop(p, { start: Math.min(a, b), end: Math.max(a, b) }));
      };
    } else {
      if (engine.mode !== 'song') app.setMode('song');
      move = (ev) => engine.seek(V.snapFloor(Math.max(0, V.vp.tick(ev.clientX - r.left)), ev));
      move(e);
    }
    const up = () => {
      rulerHost.removeEventListener('pointermove', move);
      rulerHost.removeEventListener('pointerup', up);
      rulerHost.removeEventListener('pointercancel', up);
      if (loopMode) {
        store.commit();
        const l = store.project.loop;
        announce(l ? `Loop from bar ${barLabel(l.start, store.project.sig)} to bar ${barLabel(l.end, store.project.sig)}` : 'Loop cleared');
      }
    };
    rulerHost.addEventListener('pointermove', move);
    rulerHost.addEventListener('pointerup', up);
    rulerHost.addEventListener('pointercancel', up);
  });
  rulerHost.addEventListener('dblclick', () => {
    if (!store.project.loop) return;
    store.apply('Clear loop', (p) => E.setLoop(p, null));
    announce('Loop cleared');
  });
  rulerHost.addEventListener('keydown', (e) => {
    const p = store.project;
    const step = e.shiftKey ? ticksPerBar(p.sig) : ticksPerBeat(p.sig);
    const pos = engine.mode === 'song' ? engine.position : 0;
    const map = { ArrowLeft: pos - step, ArrowRight: pos + step, ArrowDown: pos - step, ArrowUp: pos + step, PageUp: pos + ticksPerBar(p.sig) * 4, PageDown: pos - ticksPerBar(p.sig) * 4, Home: 0, End: songLength(p) };
    if (e.key in map) {
      e.preventDefault();
      e.stopPropagation();
      if (engine.mode !== 'song') app.setMode('song');
      const t = Math.max(0, Math.round(map[e.key] / (e.key.startsWith('Arrow') ? step : 1)) * (e.key.startsWith('Arrow') ? step : 1));
      engine.seek(t);
      V.revealTick(t);
      syncRulerAria();
    } else if (isContextKey(e)) {
      e.preventDefault();
      const r = rulerHost.getBoundingClientRect();
      M.rulerMenu(V, pos, { x: r.left + V.vp.x(pos), y: r.bottom });
    }
  });
  let rulerAriaText = '';
  function syncRulerAria() {
    const p = store.project;
    const pos = engine.mode === 'song' ? engine.position : 0;
    const text = formatBST(pos, p.sig);
    if (text === rulerAriaText) return;
    rulerAriaText = text;
    rulerHost.setAttribute('aria-valuenow', String(Math.round(pos)));
    rulerHost.setAttribute('aria-valuemax', String(Math.max(songLength(p), Math.round(pos))));
    rulerHost.setAttribute('aria-valuetext', `Bar ${text}`);
  }

  // ---------------------------------------------------------------- canvas pointer and keyboard

  installPointer(V, scroller);
  installCurves(V);

  scroller.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 && e.button !== 2) return;
      const pt = V.point(e);
      V.cursor = { track: pt.track, tick: V.snapFloor(pt.tick, e) };
      if (pt.track < store.project.tracks.length && pt.track !== V.selectedTrack) {
        V.selectedTrack = pt.track;
        headers.render();
      }
    },
    true,
  );
  scroller.addEventListener('focus', () => {
    V.focused = true;
    V.markDirty();
  });
  scroller.addEventListener('blur', () => {
    V.focused = false;
    V.markDirty();
  });

  const clipUnderCursor = () => C.clipAt(V.byTrack, V.cursor.track, V.cursor.tick);

  scroller.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    const p = store.project;
    if (e.key === 'Escape' && V.cancelGesture()) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const order = C.timeOrder(p.clips);
      if (!order.length) return;
      const cur = order.findIndex((c) => c.id === V.lastFocusClip && V.selection.has(c.id));
      let next;
      if (cur < 0) {
        // From the cursor position.
        next = e.shiftKey ? order.filter((c) => c.start < V.cursor.tick).at(-1) : order.find((c) => c.start >= V.cursor.tick) || null;
        if (!next && !V.kbd) next = e.shiftKey ? order.at(-1) : order[0];
      } else next = order[cur + (e.shiftKey ? -1 : 1)] || null;
      if (!next) return; // let focus leave the arrangement
      e.preventDefault();
      V.kbd = true;
      V.cursor = { track: next.track, tick: next.start };
      V.selectClips([next.id], { reveal: true });
      return;
    }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key in arrows && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      V.kbd = true;
      const [dx, dy] = arrows[e.key];
      const g = V.stepGrid();
      if (V.selection.size && !e.altKey) {
        const ids = [...V.selection];
        if (e.shiftKey && dx) {
          store.apply('Resize clips', (q) => C.resizeClips(q, ids, 'right', dx * g, { minLen: g }));
        } else if (!e.shiftKey) {
          store.apply('Move clips', (q) => C.moveClips(q, ids, dx * g, dy));
        }
        const first = C.timeOrder(store.project.clips.filter((c) => V.selection.has(c.id)))[0];
        if (first) {
          V.cursor = { track: first.track, tick: first.start };
          V.revealClip(first);
          V.announceClip(first);
        }
      } else {
        const c = V.cursor;
        V.cursor = { track: Math.max(0, c.track + dy), tick: Math.max(0, snapRound(c.tick, g) + dx * g) };
        V.revealTick(V.cursor.tick);
        V.revealTrack(V.cursor.track);
        if (V.cursor.track < p.tracks.length && V.cursor.track !== V.selectedTrack) {
          V.selectedTrack = V.cursor.track;
          headers.render();
        }
        const under = clipUnderCursor();
        const t = p.tracks[V.cursor.track];
        announce(`${under ? `${V.clipText(under)}. ` : ''}Track ${V.cursor.track + 1}${t ? ` ${t.name}` : ''}, ${formatBST(V.cursor.tick, p.sig)}`);
      }
      V.markDirty();
      return;
    }
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      V.kbd = true;
      const sel = p.clips.filter((c) => V.selection.has(c.id));
      const under = sel.length === 1 ? sel[0] : clipUnderCursor();
      if (under) V.openClip(under);
      else V.placeAt(V.cursor.track, V.snapFloor(V.cursor.tick));
      return;
    }
    if (isContextKey(e)) {
      e.preventDefault();
      const r = canvasHost.getBoundingClientRect();
      const sel = p.clips.find((c) => V.selection.has(c.id)) || clipUnderCursor();
      const x = r.left + clamp(V.vp.x(sel ? sel.start : V.cursor.tick), 0, V.vp.width) + 8;
      const y = r.top + trackTop(V.layout, sel ? sel.track : V.cursor.track) - V.scrollY + 18;
      const ap = V.activePoint;
      const pointClip = ap && p.clips.find((c) => c.id === ap.clip);
      if (pointClip && (!sel || sel.id === pointClip.id)) V.clipMenu(pointClip, { x, y }, { curve: ap.index });
      else if (sel) V.clipMenu(sel, { x, y });
      else V.emptyMenu({ track: V.cursor.track, tick: V.cursor.tick }, { x, y });
    }
  });

  // ---------------------------------------------------------------- drops

  let dropFiles = false;
  scroller.addEventListener('dragover', (e) => {
    if (!dragHasPayload(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const pt = V.point(e);
    dropFiles = e.dataTransfer.types.includes('Files');
    V.overlay = { type: 'drop', track: pt.track, tick: V.snapFloor(pt.tick, e), len: ticksPerBar(store.project.sig) };
    V.markDirty();
  });
  scroller.addEventListener('dragleave', () => {
    if (V.overlay?.type === 'drop') {
      V.overlay = null;
      V.markDirty();
    }
  });
  scroller.addEventListener('drop', async (e) => {
    e.preventDefault();
    V.overlay = null;
    V.markDirty();
    const pt = V.point(e);
    const tick = V.snapFloor(pt.tick, e);
    const payload = getDragData(e);
    try {
      if (payload) await dropPayload(payload, pt.track, tick);
      else if (dropFiles && e.dataTransfer.files?.length) await dropAudioFiles([...e.dataTransfer.files], pt.track, tick);
    } catch (err) {
      app.reportError(err);
    }
  });

  async function dropPayload(payload, track, tick) {
    const p = store.project;
    if (payload.kind === 'pattern' && patternById(p, payload.id)) {
      V.setSource({ kind: 'pattern', id: payload.id });
      V.placeAt(track, tick);
    } else if (payload.kind === 'channel') {
      const ch = p.channels.find((c) => c.id === payload.id);
      if (ch?.type === 'audio') {
        V.setSource({ kind: 'audio', id: ch.id });
        V.placeAt(track, tick);
      } else app.notify('Drop a pattern, an audio clip or audio files on the playlist');
    } else if (payload.kind === 'automation' && p.automation[payload.id]) {
      V.setSource({ kind: 'auto', id: payload.id });
      V.placeAt(track, tick);
    } else if (payload.kind === 'preset' || payload.kind === 'instrument') {
      // A new channel with a fresh pattern on the playlist, ready to write into.
      const chId = app.addChannel({ type: payload.type, name: payload.name, params: payload.params });
      const r = store.apply('New pattern', (q) => E.addPattern(q));
      store.setPattern(r.id);
      store.selectChannels([chId]);
      V.setSource({ kind: 'pattern', id: r.id });
      V.placeAt(track, tick);
    } else if (payload.kind === 'sample' && p.samples[payload.id]) {
      // Reuse an audio channel that already plays this sample, else make one.
      const existing = p.channels.find((c) => c.type === 'audio' && c.sample === payload.id);
      const id = existing?.id || app.addChannel({ type: 'audio', name: payload.name || p.samples[payload.id].name, sample: payload.id, select: false });
      V.setSource({ kind: 'audio', id });
      V.placeAt(track, tick);
    } else if (payload.kind === 'file') {
      if (!app.importAudio) {
        app.notify('Audio import is not available yet');
        return;
      }
      if (!isSignedIn()) {
        app.notify('Sign in to use files from your Puter cloud');
        return;
      }
      const blob = await readFile(payload.path);
      await importOne(blob, payload.name, track, tick, payload.path);
    }
  }

  const AUDIO_EXT = /\.(wav|wave|mp3|ogg|oga|flac|m4a|aac|aif|aiff|webm|opus)$/i;
  async function dropAudioFiles(files, track, tick) {
    const audio = files.filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
    if (!audio.length) {
      app.notify('Drop audio files (WAV, MP3, OGG, FLAC...) to make audio clips');
      return;
    }
    if (!app.importAudio) {
      app.notify('Audio import is not available yet');
      return;
    }
    for (let i = 0; i < audio.length; i++) await importOne(audio[i], audio[i].name, track + i, tick);
  }

  async function importOne(blob, name, track, tick, path) {
    const clean = String(name || 'Audio').replace(/\.[^.]+$/, '');
    app.notify(`Importing ${clean}...`);
    const r = await app.importAudio(blob, { name: clean, path, as: 'audio' });
    if (!r?.channelId) return;
    const len = Math.max(1, Math.round(secondsToTicks(r.duration || 0, store.project.bpm))) || ticksPerBar(store.project.sig);
    const out = store.apply('Add audio clip', (p) => C.placeClip(p, { kind: 'audio', id: r.channelId }, track, tick, len));
    V.setSource({ kind: 'audio', id: r.channelId });
    V.selectClips([out.id], { announce: false });
    V.announceClip(store.project.clips.find((c) => c.id === out.id), 'Placed ');
  }

  // ---------------------------------------------------------------- store, engine, prefs

  function rebuildIndex(p) {
    V.layout = trackLayout(p.tracks);
    V.byTrack = C.clipsByTrack(p.clips, p.tracks.length);
  }

  store.on('change', (p, prev, { source }) => {
    if (source === 'load') {
      V.selection = new Set();
      V.selectedTrack = 0;
      V.cursor = { track: 0, tick: 0 };
      V.vp.scroll = 0;
      V.scrollY = 0;
    }
    if (p.tracks !== prev.tracks || p.clips !== prev.clips || source === 'load') rebuildIndex(p);
    if (p.tracks !== prev.tracks || source === 'load') {
      V.selectedTrack = Math.min(V.selectedTrack, p.tracks.length - 1);
      headers.render();
    }
    if (p.patterns !== prev.patterns || p.channels !== prev.channels || p.automation !== prev.automation || p.clips !== prev.clips || source === 'load') {
      if (V.source && !C.sourceExists(p, V.source)) V.source = store.view.pattern ? { kind: 'pattern', id: store.view.pattern } : null;
      picker.render();
      syncSource();
    }
    if (p.clips !== prev.clips && V.selection.size) {
      const ids = new Set(p.clips.map((c) => c.id));
      for (const id of V.selection) if (!ids.has(id)) V.selection.delete(id);
    }
    if (source === 'load') applyScroll();
    else syncSpacer();
    V.markDirty();
  });
  store.on('view', () => {
    if (!V.source || V.source.kind === 'pattern') V.source = store.view.pattern ? { kind: 'pattern', id: store.view.pattern } : V.source;
    picker.sync();
    syncSource();
  });
  engine.on('state', () => {
    syncRulerAria();
    V.markDirty();
  });
  app.samples.on('change', () => V.markDirty());
  prefs.on('change', (k) => {
    if (k === 'snap' || k === 'autoScroll' || k === 'playlistUi') {
      syncToolbar();
      if (k === 'playlistUi') requestAnimationFrame(() => resize());
    }
    if (k === 'snap') V.markDirty();
  });
  app.on('tool', (scope) => {
    if (scope === 'playlist') syncToolbar();
  });
  window.addEventListener('themechange', () => {
    resetColors();
    V.markDirty();
  });

  // ---------------------------------------------------------------- frame

  let lastHeadX = NaN;
  function updatePlayhead() {
    const song = engine.mode === 'song';
    const pos = engine.position;
    if (song && engine.playing && prefs.get('autoScroll') && !V.hasGesture?.()) {
      const span = V.vp.width / V.vp.pxPerTick;
      if (pos > V.vp.scroll + span * 0.96 || pos < V.vp.scroll) V.setScroll(pos - span * 0.02, V.scrollY);
    }
    const x = song ? Math.round(V.vp.x(pos)) : -10;
    if (x === lastHeadX) return;
    lastHeadX = x;
    const vis = song && x >= 0 && x <= V.vp.width;
    playhead.hidden = !vis;
    rulerHead.hidden = !vis;
    if (vis) {
      playhead.style.transform = `translateX(${x}px)`;
      rulerHead.style.transform = `translateX(${x}px)`;
    }
    syncRulerAria();
  }

  V.draw = () => {
    V.dirty = false;
    gMain.frame((d) => drawCanvas(V, d));
    gRuler.frame((d) => drawRulerLayer(V, d));
    lastHeadX = NaN;
    updatePlayhead();
  };

  app.on('frame', () => {
    if (!V.visible) return;
    updatePlayhead();
    if (V.dirty) V.draw();
  });

  function resize() {
    V.vp.width = scroller.clientWidth || canvasHost.clientWidth;
    syncSpacer();
    gMain.resize();
    gRuler.resize();
    V.markDirty();
  }

  // ---------------------------------------------------------------- actions

  const selected = () => store.project.clips.filter((c) => V.selection.has(c.id));
  const firstSelectedTrack = () => {
    const sel = selected();
    return sel.length ? Math.min(...sel.map((c) => c.track)) : V.selectedTrack;
  };
  V.actions = {
    copy() {
      const board = C.copyClips(store.project, [...V.selection]);
      if (!board) return;
      clipboard = board;
      app.notify(`Copied ${board.clips.length} clip${board.clips.length === 1 ? '' : 's'}`);
    },
    cut() {
      const board = C.copyClips(store.project, [...V.selection]);
      if (!board) return;
      clipboard = board;
      store.apply('Cut clips', (p) => E.removeClips(p, [...V.selection]));
      announce(`Cut ${board.clips.length} clip${board.clips.length === 1 ? '' : 's'}`);
    },
    paste() {
      if (!clipboard) {
        app.notify('Copy some clips first');
        return;
      }
      V.pasteAt(Math.round(V.songPos()), firstSelectedTrack());
    },
    delete() {
      const n = V.selection.size;
      if (!n) return;
      store.apply('Delete clips', (p) => E.removeClips(p, [...V.selection]));
      V.setSelection([]);
      announce(`Deleted ${n} clip${n === 1 ? '' : 's'}`);
    },
    selectAll() {
      V.selectClips(store.project.clips.map((c) => c.id));
    },
    deselect() {
      if (V.cancelGesture()) return;
      if (V.activePoint) {
        V.activePoint = null;
        V.markDirty();
        return;
      }
      if (V.selection.size) V.selectClips([]);
    },
    duplicate() {
      const ids = [...V.selection];
      if (!ids.length) return;
      const r = store.apply('Duplicate clips', (p) => C.duplicateClips(p, ids));
      V.selectClips(r.ids, { announce: false, reveal: true });
      announce(`Duplicated ${r.ids.length} clip${r.ids.length === 1 ? '' : 's'}`);
    },
  };

  // ---------------------------------------------------------------- start

  headers.render();
  picker.render();
  syncToolbar();
  syncRulerAria();

  return {
    toolbar,
    actions: V.actions,
    view: V,
    draw: () => V.draw(),
    setTool: (id) => V.setTool(id),
    selectClips: (ids, opts) => V.selectClips(ids, opts),
    onShow() {
      V.visible = true;
      requestAnimationFrame(() => {
        resize();
        applyScroll();
        V.draw();
      });
    },
    onHide() {
      V.visible = false;
      V.cancelGesture?.();
    },
    onResize() {
      resize();
    },
    focus() {
      scroller.focus({ preventScroll: true });
    },
  };
}
