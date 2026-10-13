/**
 * Timeline panel: toolbar, track headers, ruler, tracks with clips,
 * playhead, snapping, drag to move between tracks, trim handles, marquee
 * selection, transitions and drops from the assets panel.
 *
 * Clips are DOM elements (so they are focusable and labeled for assistive
 * technology), virtualized to the visible range. Filmstrips and waveforms
 * are drawn on small canvases covering only the visible part of each clip.
 */
import { h, announce, clamp } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { US, timecode, spokenDuration, snapToFrame } from '../../lib/time.js';
import { shortcutLabel } from '../../lib/platform.js';
import * as T from '../../model/timeline.js';
import { beatTimes } from '../../model/audio.js';
import { hasCurve, sourceMapper } from '../../model/speed-curve.js';
import { keyTimes } from '../../model/keyframes.js';
import { TRANSITIONS } from '../../model/catalog.js';
import { MediaService } from '../../media/media-service.js';
import { drawRuler } from './ruler.js';
import { showMenu } from '../menu.js';
import { prefs, setPref } from '../prefs.js';
import { isBodyEffect } from '../../model/body-effects.js';
import { saveClipPreset, presetMenu } from '../clip-presets.js';
import { toast } from '../dialog.js';
import { LABEL_COLORS, LABEL_NAMES, EASE_LABELS, easeLabel } from '../organize-actions.js';
import { CLIP_LABELS } from '../../model/project.js';
import { canHaveEffects } from '../../model/clip-effects.js';
import { angleAt, angleName, visibleCuts } from '../../model/multicam.js';
import { createPinch, longPress } from '../../lib/gestures.js';
import '../../styles/organize.css';
import { createKeyframePanel } from './keyframe-panel.js';
import { pref, onPrefsChange } from '../preferences-dialog.js';

const BASE_PAD = 16; // px before time 0 (half the view on phones, see setCentered)
const GAP_TOP = 28; // drop zone above the first track
const GAP_BOTTOM = 40;
const TRACK_GAP = 4;
const SNAP_PX = 8;
const MIN_PPS = 0.5;
const MAX_PPS = 1200;
const EDGE_PX = 7;

const HEIGHTS = { video: 52, main: 64, audio: 44, text: 30, effect: 26, filter: 26, adjust: 26 };
const TYPE_LABEL = { video: 'Video', image: 'Photo', audio: 'Audio', text: 'Text', sticker: 'Graphic', avatar: 'Avatar', effect: 'Effect', filter: 'Filter', adjust: 'Color layer', compound: 'Compound clip' };
const TRACK_ICON = { video: 'film', audio: 'music', text: 'text', effect: 'effects', filter: 'filters', adjust: 'adjust' };
const TRACK_NAME = { video: 'Video', audio: 'Audio', text: 'Text', effect: 'Effects', filter: 'Filters', adjust: 'Color' };
const SIZE_FACTOR = { small: 0.7, medium: 1, large: 1.6 };
const TOOL_LABEL = { select: 'Select tool', split: 'Split tool', forwardTrack: 'Select forward on track', forwardAll: 'Select forward on all tracks' };
const TOOL_ICON = { select: 'select', split: 'split', forwardTrack: 'arrowRight', forwardAll: 'rows' };

// Touch screens get lanes tall enough for 40px tap targets.
const coarse = globalThis.matchMedia?.('(pointer: coarse)') || { matches: false };

function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export function createTimeline(ctx) {
  const { store, player, actions, media } = ctx;
  let PAD = BASE_PAD;
  let centered = false; // phone layout: the playhead stays in the middle and scrolling seeks
  let pps = prefs().zoom || 40;
  let tool = 'select';
  let rows = [];
  let drag = null;
  let renderQueued = false;
  let canvasQueued = false;
  let activeId = null; // roving focus clip
  const clipEls = new Map();
  // Multi-camera clips on screen: their label names the angle at the playhead.
  let multicams = [];
  const trChips = new Map();

  // ---- Toolbar -----------------------------------------------------------
  const tb = (iconName, label, cmd, extra = {}) => {
    const key = cmd ? ctx.commands.keyFor(cmd) : '';
    const b = h('button.icon-btn', { type: 'button', 'aria-label': label, 'data-tip': label, 'data-tip-key': key ? shortcutLabel(key) : null, 'data-cmd': cmd || null, 'data-icon': iconName, ...extra }, icon(iconName, 18));
    if (cmd) b.addEventListener('click', () => ctx.commands.run(cmd));
    return b;
  };
  const toolBtn = h('button.icon-btn.tool-btn', { type: 'button', 'aria-label': 'Select tool', 'data-tip': 'Tool' }, icon('select', 18), icon('chevronDown', 12));
  toolBtn.addEventListener('click', () => showMenu(toolBtn, [
    { label: 'Select', icon: 'select', shortcut: ctx.commands.keyFor('selectTool'), checked: tool === 'select', radio: true, onSelect: () => setTool('select') },
    { label: 'Split', icon: 'split', shortcut: ctx.commands.keyFor('splitTool'), checked: tool === 'split', radio: true, onSelect: () => setTool('split') },
    { label: 'Select forward on track', icon: 'arrowRight', checked: tool === 'forwardTrack', radio: true, onSelect: () => setTool('forwardTrack') },
    { label: 'Select forward on all tracks', icon: 'rows', checked: tool === 'forwardAll', radio: true, onSelect: () => setTool('forwardAll') },
  ], { label: 'Tools' }));
  // Add menu: quick ways to put something new on the timeline.
  const addBtn = h('button.icon-btn.add-btn', { type: 'button', 'aria-label': 'Add', 'data-tip': 'Add', 'aria-haspopup': 'menu' }, icon('plus', 18));
  addBtn.addEventListener('click', () => {
    const at = timecode(store.time, store.fps);
    const track = (kind) => () => store.update('Add track', (p) => Boolean(T.addTrack(p, kind)), { keepEmptyTracks: true });
    showMenu(addBtn, [
      { label: 'Import media...', icon: 'import', shortcut: ctx.commands.keyFor('import'), onSelect: () => ctx.commands.run('import') },
      { label: `Text at ${at}`, icon: 'text', shortcut: ctx.commands.keyFor('addText'), onSelect: () => ctx.commands.run('addText') },
      { label: 'Record voiceover...', icon: 'mic', onSelect: () => ctx.openVoiceover?.() },
      { label: `Marker at ${at}`, icon: 'bookmark', shortcut: ctx.commands.keyFor('marker'), onSelect: () => ctx.commands.run('marker') },
      'separator',
      { label: 'Video track', icon: 'film', onSelect: track('video') },
      { label: 'Audio track', icon: 'music', onSelect: track('audio') },
      { label: 'Text track', icon: 'text', onSelect: track('text') },
    ], { label: 'Add' });
  });
  const undoBtn = tb('undo', 'Undo', 'undo');
  const redoBtn = tb('redo', 'Redo', 'redo');
  const splitBtn = tb('split', 'Split', 'split');
  const delLeftBtn = tb('deleteLeft', 'Delete left', 'deleteLeft');
  const delRightBtn = tb('deleteRight', 'Delete right', 'deleteRight');
  const deleteBtn = tb('trash', 'Delete', 'delete');
  const freezeBtn = tb('freeze', 'Freeze frame', 'freeze');
  const cropBtn = tb('crop', 'Crop', 'crop');
  const mirrorBtn = tb('flipH', 'Mirror', 'mirror');
  const rotateBtn = tb('rotate', 'Rotate', 'rotate');
  const kfBtn = tb('keyframeAdd', 'Add keyframe', 'keyframe');
  const markerBtn = tb('bookmark', 'Add marker', 'marker');
  const kfPanelBtn = tb('easing', 'Keyframe panel', 'toggleKeyframePanel', { 'aria-pressed': 'false' });
  kfPanelBtn.classList.add('toggle');
  const micBtn = tb('mic', 'Record voiceover', null);
  micBtn.addEventListener('click', () => ctx.openVoiceover ? ctx.openVoiceover() : toast('Voiceover recording is not available yet.'));
  const toggle = (name, iconName, label, cmd) => {
    const b = tb(iconName, label, cmd, { 'aria-pressed': String(Boolean(store.toggles[name])) });
    b.classList.add('toggle');
    return b;
  };
  const rippleBtn = toggle('ripple', 'ripple', 'Ripple base track', 'toggleRipple');
  const snapBtn = toggle('snap', 'snapping', 'Snapping', 'toggleSnap');
  const linkBtn = toggle('linkOverlays', 'link', 'Overlays follow base clips', 'toggleLinkOverlays');
  const hoverBtn = toggle('hoverPreview', 'hoverPreview', 'Hover preview', 'toggleHoverPreview');
  const zoomOutBtn = tb('zoomOut', 'Zoom out', 'zoomOut');
  const zoomInBtn = tb('zoomIn', 'Zoom in', 'zoomIn');
  const fitBtn = tb('zoomFit', 'Zoom to fit', 'zoomFit');
  const zoomSlider = h('input.zoom-slider', { type: 'range', min: 0, max: 1000, step: 1, 'aria-label': 'Timeline zoom' });
  zoomSlider.addEventListener('input', () => {
    const v = Number(zoomSlider.value) / 1000;
    setPps(MIN_PPS * (MAX_PPS / MIN_PPS) ** v, 'center');
  });
  const nestBack = h('button.btn.small.nest-back', { type: 'button', hidden: true }, icon('back', 14), h('span.nest-label'));
  nestBack.addEventListener('click', () => actions.closeCompound());
  const toolbar = h('div.tl-toolbar', { role: 'toolbar', 'aria-label': 'Timeline tools' },
    h('div.tl-tools', nestBack, addBtn, h('span.tb-sep'), toolBtn, h('span.tb-sep'), undoBtn, redoBtn, h('span.tb-sep'), splitBtn, delLeftBtn, delRightBtn, deleteBtn, h('span.tb-sep.hide-sm'), h('span.hide-sm.tb-group', cropBtn, freezeBtn, mirrorBtn, rotateBtn, kfBtn, kfPanelBtn, markerBtn)),
    h('div.tl-tools.right', micBtn, h('span.tb-sep'), rippleBtn, snapBtn, linkBtn, hoverBtn, h('span.tb-sep'), zoomOutBtn, h('span.zoom-wrap', zoomSlider), zoomInBtn, fitBtn),
  );
  toolbar.addEventListener('keydown', (e) => {
    // Toolbar pattern: arrow keys move between buttons.
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.target.matches('input[type=range]')) return;
    const btns = [...toolbar.querySelectorAll('button:not(:disabled)')].filter((b) => b.offsetParent !== null);
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length].focus();
  });

  // ---- Body ----------------------------------------------------------------
  const rulerCanvas = h('canvas.tl-ruler-canvas', { 'aria-hidden': 'true' });
  const ruler = h('div.tl-ruler', { role: 'slider', tabindex: '0', 'aria-label': 'Playhead position', 'aria-valuemin': '0', 'data-own-arrows': '' }, rulerCanvas);
  const headers = h('div.tl-headers');
  const tracksEl = h('div.tl-tracks', { 'data-space-plays': '', 'data-own-arrows': '' });
  const playhead = h('div.tl-playhead', { 'aria-hidden': 'true' }, h('div.tl-playhead-cap'));
  const previewLine = h('div.tl-preview-line', { 'aria-hidden': 'true', hidden: true });
  const snapLine = h('div.tl-snap-line', { 'aria-hidden': 'true', hidden: true });
  const insertLine = h('div.tl-insert-line', { 'aria-hidden': 'true', hidden: true });
  const marquee = h('div.tl-marquee', { 'aria-hidden': 'true', hidden: true });
  const rangeEl = h('div.tl-range', { 'aria-hidden': 'true', hidden: true });
  const content = h('div.tl-content', tracksEl, rangeEl, playhead, previewLine, snapLine, insertLine, marquee);
  const corner = h('div.tl-corner');
  const scroller = h('div.tl-scroll', h('div.tl-grid', corner, ruler, headers, content));
  const emptyHint = h('div.tl-empty', { hidden: true }, icon('film', 18), h('span', 'Drag and drop media here to start creating'));
  const el = h('section.panel.timeline-panel', { 'aria-label': 'Timeline' }, toolbar, scroller, emptyHint);

  const timeToX = (t) => PAD + (t / US) * pps;
  const viewListeners = new Set();
  const notifyView = () => viewListeners.forEach((fn) => fn());
  const xToTime = (x) => Math.max(0, ((x - PAD) / pps) * US);

  function setTool(t) {
    tool = TOOL_LABEL[t] ? t : 'select';
    toolBtn.replaceChildren(icon(TOOL_ICON[tool], 18), icon('chevronDown', 12));
    toolBtn.setAttribute('aria-label', TOOL_LABEL[tool]);
    el.classList.toggle('tool-split', tool === 'split');
    el.classList.toggle('tool-forward', tool === 'forwardTrack' || tool === 'forwardAll');
    announce(tool === 'split' ? 'Split tool. Click a clip to split it.' : tool === 'select' ? 'Select tool' : `${TOOL_LABEL[tool]}. Click a clip to select it and everything after it.`);
  }

  function setPps(next, anchor = 'playhead') {
    const old = pps;
    pps = clamp(next, MIN_PPS, MAX_PPS);
    if (pps === old) return;
    const vw = scroller.clientWidth - headerWidth();
    let anchorT;
    let anchorPx;
    if (typeof anchor === 'object') {
      anchorT = anchor.time;
      anchorPx = anchor.px;
    } else if (anchor === 'center') {
      anchorPx = vw / 2;
      anchorT = xToTimeWith(old, scroller.scrollLeft + anchorPx);
    } else {
      anchorT = store.time;
      anchorPx = PAD + (store.time / US) * old - scroller.scrollLeft;
      if (anchorPx < 0 || anchorPx > vw) anchorPx = vw / 2;
    }
    setPref('zoom', pps);
    render(true);
    scroller.scrollLeft = Math.max(0, PAD + (anchorT / US) * pps - anchorPx);
    syncZoomSlider();
  }

  function xToTimeWith(p, x) {
    return Math.max(0, ((x - PAD) / p) * US);
  }

  function syncZoomSlider() {
    zoomSlider.value = String(Math.round((Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 1000));
    zoomSlider.style.setProperty('--pct', `${Number(zoomSlider.value) / 10}%`);
  }

  function zoomToFit() {
    const vw = Math.max(200, scroller.clientWidth - headerWidth() - PAD * 2 - 40);
    const d = Math.max(store.duration, 10 * US);
    setPps(vw / (d / US), { time: 0, px: PAD });
    scroller.scrollLeft = 0;
  }

  function headerWidth() {
    return headers.offsetWidth || 92;
  }

  // ---- Layout -----------------------------------------------------------
  function computeRows() {
    let y = GAP_TOP;
    rows = store.project.tracks.map((track, index) => {
      const base = track.main ? HEIGHTS.main : HEIGHTS[track.kind] || 40;
      const hgt = Math.max(Math.round(base * (SIZE_FACTOR[track.size] || 1)), coarse.matches ? 40 : 0, 20);
      const row = { track, index, y, h: hgt };
      y += hgt + TRACK_GAP;
      return row;
    });
    return y - TRACK_GAP + GAP_BOTTOM;
  }

  let headerSig = '';
  function renderHeaders(totalH) {
    const anySolo = store.project.tracks.some((t) => t.solo);
    const sig = `${anySolo}|` + store.project.tracks.map((t) => `${t.id}:${t.kind}:${t.main}:${t.locked}:${t.hidden}:${t.muted}:${t.solo}:${t.name}:${t.size}`).join('|');
    headers.style.height = `${totalH}px`;
    if (sig === headerSig) return;
    headerSig = sig;
    const counts = {};
    headers.replaceChildren(...rows.map(({ track, y, h: hgt }) => {
      counts[track.kind] = (counts[track.kind] || 0) + 1;
      const name = track.name || (track.main ? 'Base track' : `${TRACK_NAME[track.kind]} track ${counts[track.kind]}`);
      track._label = name;
      const btn = (prop, on, off, labelOn, labelOff) => {
        const b = h('button.icon-btn.small', { type: 'button', 'aria-pressed': String(Boolean(track[prop])), 'aria-label': `${track[prop] ? labelOff : labelOn} ${name}`, 'data-tip': track[prop] ? labelOff : labelOn }, icon(track[prop] ? on : off, 14));
        b.addEventListener('click', () => actions.toggleTrack(track.id, prop));
        return b;
      };
      const controls = [btn('locked', 'lock', 'unlock', 'Lock', 'Unlock')];
      if (track.kind !== 'audio') controls.push(btn('hidden', 'eyeOff', 'eye', 'Hide', 'Show'));
      if (track.kind === 'audio' || track.kind === 'video') controls.push(btn('muted', 'mute', 'volume', 'Mute', 'Unmute'));
      if (track.solo || (anySolo && (track.kind === 'audio' || track.kind === 'video'))) {
        const solo = h('button.icon-btn.small.solo-btn', { type: 'button', 'aria-pressed': String(Boolean(track.solo)), 'aria-label': `${track.solo ? 'Unsolo' : 'Solo'} ${name}`, 'data-tip': track.solo ? 'Unsolo' : 'Solo' }, icon('solo', 14));
        solo.addEventListener('click', () => actions.toggleSolo(track.id));
        controls.push(solo);
      }
      const more = h('button.icon-btn.small.tl-header-more', { type: 'button', 'aria-label': `${name} options`, 'aria-haspopup': 'menu', 'data-tip': 'Track options' }, icon('more', 14));
      more.addEventListener('click', () => trackMenu(more, track));
      controls.push(more);
      const head = h(`div.tl-header${track.main ? '.main' : ''}${track.solo ? '.solo' : ''}`, { style: { top: `${y}px`, height: `${hgt}px` }, role: 'group', 'aria-label': name },
        h('span.tl-header-icon', { 'data-tip': name }, icon(TRACK_ICON[track.kind], 14)),
        hgt >= 40 || track.name ? h('span.tl-header-name', { title: name }, name) : null,
        h('div.tl-header-btns', controls),
      );
      head.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        trackMenu({ x: e.clientX, y: e.clientY }, track);
      });
      head.addEventListener('dblclick', (e) => {
        if (e.target.closest('button')) return;
        actions.renameTrack(track.id);
      });
      if (track.main) {
        const cover = h('button.tl-cover', { type: 'button', 'aria-label': 'Set thumbnail to the frame at the playhead', 'data-tip': 'Use the frame at the playhead as the project thumbnail' }, icon('pencil', 12), h('span', 'Cover'));
        cover.addEventListener('click', () => {
          store.update('Set thumbnail', (p) => {
            p.cover = { time: store.time };
          }, { structural: false });
          ctx.editor.saveCover();
          toast('Thumbnail set to the current frame.', { kind: 'success' });
        });
        head.append(cover);
      }
      return head;
    }));
  }

  function trackMenu(anchor, track) {
    const av = track.kind === 'audio' || track.kind === 'video';
    const tracks = store.project.tracks;
    const i = tracks.indexOf(track);
    const canUp = !track.main && tracks[i - 1]?.kind === track.kind && !tracks[i - 1]?.main;
    const canDown = !track.main && tracks[i + 1]?.kind === track.kind && !tracks[i + 1]?.main;
    showMenu(anchor, [
      { label: 'Rename track...', icon: 'pencil', onSelect: () => actions.renameTrack(track.id) },
      { label: 'Select all clips on track', icon: 'select', disabled: !track.clips.length, onSelect: () => actions.selectTrackClips(track.id) },
      av ? { label: track.solo ? 'Unsolo track' : 'Solo track', icon: 'solo', checked: Boolean(track.solo), onSelect: () => actions.toggleSolo(track.id) } : null,
      { label: 'Track height', icon: 'rows', submenu: () => ['small', 'medium', 'large'].map((sz) => ({ label: sz[0].toUpperCase() + sz.slice(1), radio: true, checked: (track.size || 'medium') === sz, onSelect: () => actions.setTrackSize(track.id, sz) })) },
      'separator',
      { label: 'Move up', icon: 'arrowUp', disabled: !canUp, onSelect: () => actions.moveTrack(track.id, -1) },
      { label: 'Move down', icon: 'arrowDown', disabled: !canDown, onSelect: () => actions.moveTrack(track.id, 1) },
      { label: `Add ${TRACK_NAME[track.kind].toLowerCase()} track above`, icon: 'insertAbove', onSelect: () => actions.addTrackNear(track.id, track.kind, false) },
      track.kind !== 'video' || !track.main ? { label: `Add ${TRACK_NAME[track.kind].toLowerCase()} track below`, icon: 'insertBelow', onSelect: () => actions.addTrackNear(track.id, track.kind, true) } : null,
      'separator',
      { label: track.main ? 'Clear base track' : 'Delete track', icon: 'trash', danger: true, disabled: track.main && !track.clips.length, onSelect: () => actions.deleteTrack(track.id) },
    ].filter(Boolean), { label: track._label || 'Track' });
  }

  function visibleRange() {
    const left = scroller.scrollLeft - 400;
    const right = scroller.scrollLeft + scroller.clientWidth + 400;
    return [xToTime(left), xToTime(right)];
  }

  function clipAria(clip, track) {
    const label = T.clipLabel(store.project, clip);
    const bits = [`${TYPE_LABEL[clip.type]}: ${label}`, `starts at ${spokenDuration(clip.start)}`, `length ${spokenDuration(clip.duration)}`];
    if (track.main) bits.push('base track');
    if (hasCurve(clip)) bits.push('speed curve');
    else if (clip.speed && clip.speed !== 1) bits.push(`speed ${clip.speed}x`);
    if (clip.muted) bits.push('muted');
    if (track.locked) bits.push('locked');
    return bits.join(', ');
  }

  function clipEl(clip, track) {
    let e = clipEls.get(clip.id);
    if (!e) {
      const name = h('span.clip-name');
      const dur = h('span.clip-dur');
      const badges = h('span.clip-badges');
      const cv = h('canvas.clip-canvas', { 'aria-hidden': 'true' });
      const kf = h('div.clip-kf', { 'aria-hidden': 'true' });
      const cuts = h('div.clip-cuts', { 'aria-hidden': 'true' });
      const node = h('div.tl-clip', { role: 'option', tabindex: '-1', 'data-id': clip.id },
        cv,
        cuts,
        h('div.clip-head', h('span.clip-type', icon(iconForClip(clip), 12)), name, dur, badges),
        kf,
        h('div.clip-trim.l', { 'data-edge': 'start', 'aria-hidden': 'true' }),
        h('div.clip-trim.r', { 'data-edge': 'end', 'aria-hidden': 'true' }),
      );
      e = { node, name, dur, badges, cv, kf, cuts, sig: '', cutSig: '' };
      clipEls.set(clip.id, e);
    }
    return e;
  }

  function iconForClip(c) {
    if (c.multicam) return 'multicam';
    return { video: 'film', image: 'image', audio: 'music', text: 'text', sticker: 'sticker', avatar: 'avatar', effect: 'effects', filter: 'filters', adjust: 'adjust', compound: 'layers' }[c.type];
  }

  function render(force = false) {
    renderQueued = false;
    const totalH = computeRows();
    const dur = store.duration;
    const vw = scroller.clientWidth;
    const width = Math.max(vw, timeToX(dur) + Math.max(vw * 0.6, 300));
    content.style.width = `${width}px`;
    content.style.height = `${totalH}px`;
    tracksEl.style.height = `${totalH}px`;
    ruler.style.width = `${width}px`;
    renderHeaders(totalH);
    const [t0, t1] = visibleRange();
    const keep = new Set();
    multicams = [];
    const fps = store.fps;
    // Track rows (lanes).
    let lanes = tracksEl.querySelectorAll(':scope > .tl-lane');
    if (lanes.length !== rows.length || force || [...lanes].some((l, i) => l.dataset.track !== rows[i].track.id)) {
      const counts = {};
      tracksEl.replaceChildren(...rows.map(({ track, y, h: hgt }) => {
        counts[track.kind] = (counts[track.kind] || 0) + 1;
        const name = track.main ? 'Base track' : `${TRACK_NAME[track.kind]} track ${counts[track.kind]}`;
        return h(`div.tl-lane.kind-${track.kind}${track.main ? '.main' : ''}`, { role: 'listbox', 'aria-label': name, 'aria-multiselectable': 'true', 'aria-orientation': 'horizontal', 'data-track': track.id, style: { top: `${y}px`, height: `${hgt}px` } });
      }));
      lanes = tracksEl.querySelectorAll(':scope > .tl-lane');
      clipEls.forEach((v) => v.node.remove());
    }
    rows.forEach((row, i) => {
      const lane = lanes[i];
      lane.style.top = `${row.y}px`;
      lane.style.height = `${row.h}px`;
      lane.classList.toggle('locked', row.track.locked);
      lane.classList.toggle('hidden-track', row.track.hidden);
      for (const clip of row.track.clips) {
        const visible = T.clipEnd(clip) >= t0 && clip.start <= t1;
        if (!visible && !store.selection.has(clip.id) && clip.id !== activeId) continue;
        keep.add(clip.id);
        const e = clipEl(clip, row.track);
        if (e.node.parentNode !== lane) lane.append(e.node);
        const x = timeToX(clip.start);
        const w = Math.max(2, (clip.duration / US) * pps);
        e.node.style.transform = `translateX(${x}px)`;
        e.node.style.width = `${w}px`;
        e.node.className = `tl-clip type-${clip.type}${store.selection.has(clip.id) ? ' selected' : ''}${row.track.locked ? ' locked' : ''}${w < 40 ? ' narrow' : ''}${clip.caption ? ' caption' : ''}${clip.disabled ? ' disabled' : ''}${clip.group ? ' grouped' : ''}${clip.label ? ' labeled' : ''}`;
        if (clip.label) e.node.style.setProperty('--clip-tag', LABEL_COLORS[clip.label]);
        else e.node.style.removeProperty('--clip-tag');
        e.node.setAttribute('aria-selected', String(store.selection.has(clip.id)));
        e.node.tabIndex = clip.id === activeId ? 0 : -1;
        const label = clipText(clip);
        if (clip.multicam) multicams.push(clip);
        const sig = `${label}|${clip.duration}|${clip.speed}|${clip.muted}|${row.track.locked}|${clip.start}|${clip.disabled}|${clip.group}|${clip.label}|${hasCurve(clip)}|${Boolean(clip.filter)}|${clip.effects?.length || 0}`;
        if (e.sig !== sig) {
          e.sig = sig;
          e.name.textContent = label;
          e.dur.textContent = clip.type === 'video' || clip.type === 'audio' || clip.type === 'image' ? timecode(clip.duration, fps) : '';
          const badges = [];
          if (hasCurve(clip)) badges.push(h('span.badge.curve-badge', { title: 'Speed curve' }, icon('speedCurve', 10)));
          else if (clip.speed && clip.speed !== 1) badges.push(h('span.badge', `${+clip.speed.toFixed(2)}x`));
          if (clip.freeze) badges.push(h('span.badge', icon('freeze', 10)));
          if (clip.muted) badges.push(h('span.badge', icon('mute', 10)));
          if (clip.filter) badges.push(h('span.badge', icon('filters', 10)));
          if (clip.effects?.length) badges.push(h('span.badge', { title: `${clip.effects.length} clip ${clip.effects.length === 1 ? 'effect' : 'effects'}` }, icon('effects', 10), clip.effects.length > 1 ? String(clip.effects.length) : null));
          if (clip.group) badges.push(h('span.badge', { title: 'Grouped' }, icon('group', 10)));
          if (clip.disabled) badges.push(h('span.badge', { title: 'Disabled' }, icon('powerOff', 10)));
          e.badges.replaceChildren(...badges);
          e.node.setAttribute('aria-label', clipAria(clip, row.track));
        }
        if (clip.multicam || e.cutSig) renderCuts(e, clip);
        // Keyframe diamonds for the selected clip.
        if (store.selection.has(clip.id) && clip.keyframes && Object.keys(clip.keyframes).length) {
          const local = store.time - clip.start;
          const near = Math.round(US / store.fps / 2);
          e.kf.replaceChildren(...keyTimes(clip.keyframes).map((t) => h(`span.kf-dot${Math.abs(t - local) <= near ? '.current' : ''}`, { 'data-t': String(t), 'data-ease': T.keyEaseAt(clip, t) || 'linear', title: `Keyframe at ${timecode(clip.start + t, fps)} (${T.keyEaseAt(clip, t) ? easeLabel(T.keyEaseAt(clip, t)) : 'Mixed easing'})`, style: { left: `${(t / US) * pps}px` } })));
        } else if (e.kf.childNodes.length) e.kf.replaceChildren();
      }
    });
    for (const [id, e] of clipEls) {
      if (!keep.has(id)) {
        e.node.remove();
        if (!T.findClip(store.project, id)) clipEls.delete(id);
      }
    }
    renderTransitions();
    const range = store.project.range;
    rangeEl.hidden = !range;
    if (range) Object.assign(rangeEl.style, { left: `${timeToX(range.in)}px`, width: `${Math.max(1, timeToX(range.out) - timeToX(range.in))}px` });
    placePlayhead();
    drawRulerNow();
    emptyHint.hidden = T.allClips(store.project).length > 0;
    ruler.setAttribute('aria-valuemax', String(Math.round(dur / US)));
    queueCanvases();
    notifyView();
  }

  /** Clip name, plus the angle showing at the playhead on a multi-camera clip. */
  function clipText(clip) {
    const label = T.clipLabel(store.project, clip);
    if (!clip.multicam) return label;
    const inner = Math.min(clip.in + clip.duration - 1, Math.max(clip.in, store.time - clip.start + clip.in));
    return `${label} · ${angleName(clip, angleAt(clip.multicam, inner))}`;
  }

  function refreshAngleLabels() {
    for (const clip of multicams) {
      const e = clipEls.get(clip.id);
      const text = clipText(clip);
      if (e && e.name.textContent !== text) e.name.textContent = text;
    }
  }

  /** A multi-camera clip's angle cuts: a mark with the angle number where each run starts. */
  function renderCuts(e, clip) {
    const mc = clip.multicam;
    const sig = mc ? `${pps}|${clip.in}|${clip.duration}|${JSON.stringify(mc.cuts)}` : '';
    if (sig === e.cutSig) return;
    e.cutSig = sig;
    if (!mc) {
      e.cuts.replaceChildren();
      return;
    }
    const runs = [{ t: clip.in, angle: angleAt(mc, clip.in) }, ...visibleCuts(clip)];
    e.cuts.replaceChildren(...runs.map((c, i) => h(`span.mc-mark${i ? '' : '.first'}`, { style: { left: `${((c.t - clip.in) / US) * pps}px` } }, String(c.angle + 1))));
  }

  function renderTransitions() {
    const keep = new Set();
    rows.forEach((row) => {
      if (row.track.kind !== 'video') return;
      const clips = row.track.clips;
      for (let i = 0; i < clips.length - 1; i++) {
        const a = clips[i];
        const b = clips[i + 1];
        if (Math.abs(b.start - T.clipEnd(a)) > 2000) continue;
        const has = Boolean(a.transition);
        // Show chips for existing transitions; others appear on hover as "add" targets.
        const id = a.id;
        keep.add(id);
        let chip = trChips.get(id);
        if (!chip) {
          chip = h('button.tl-transition', { type: 'button' });
          chip.addEventListener('click', (e) => {
            e.stopPropagation();
            const clip = T.findClip(store.project, id)?.clip;
            if (clip?.transition) store.selectTransition(id);
            else {
              ctx.assets.show('transitions');
              actions.applyTransition('mix', { clipId: id });
              store.selectTransition(id);
            }
          });
          trChips.set(id, chip);
        }
        const name = has ? TRANSITIONS.find((t) => t.id === a.transition.id)?.label || 'Transition' : null;
        chip.className = `tl-transition${has ? ' has' : ''}${store.transition === id ? ' selected' : ''}`;
        chip.setAttribute('aria-label', has ? `${name} transition between ${T.clipLabel(store.project, a)} and ${T.clipLabel(store.project, b)}` : `Add transition after ${T.clipLabel(store.project, a)}`);
        chip.setAttribute('data-tip', has ? name : 'Add transition');
        chip.replaceChildren(icon('transition', 12));
        const w = has ? Math.max(18, (a.transition.duration / US) * pps) : 18;
        chip.style.left = `${timeToX(T.clipEnd(a)) - w / 2}px`;
        chip.style.top = `${row.y + row.h / 2 - 9}px`;
        chip.style.width = `${w}px`;
        if (chip.parentNode !== content) content.append(chip);
      }
    });
    for (const [id, chip] of trChips) {
      if (!keep.has(id)) {
        chip.remove();
        trChips.delete(id);
      }
    }
  }

  function placePlayhead() {
    const t = store.time;
    playhead.style.transform = `translateX(${timeToX(t)}px)`;
    playhead.style.height = `${content.offsetHeight || 200}px`;
    ruler.setAttribute('aria-valuenow', String(Math.round(t / US)));
    ruler.setAttribute('aria-valuetext', timecode(t, store.fps));
  }

  function drawRulerNow() {
    const width = scroller.clientWidth - headerWidth();
    rulerCanvas.style.transform = `translateX(${scroller.scrollLeft}px)`;
    drawRuler(rulerCanvas, {
      scrollLeft: scroller.scrollLeft,
      width: Math.max(10, width),
      pps,
      pad: PAD,
      fps: store.fps,
      markers: store.project.markers,
      range: store.project.range || null,
      colors: {
        major: cssVar(el, '--ruler', '#888'),
        minor: cssVar(el, '--border-strong', '#444'),
        text: cssVar(el, '--text-3', '#888'),
        marker: cssVar(el, '--marker', '#f5b83d'),
        range: cssVar(el, '--range-fill', 'rgba(79,143,247,0.22)'),
        rangeEdge: cssVar(el, '--accent', '#4f8ff7'),
        labelBg: cssVar(el, '--range-label-bg', 'rgba(0,0,0,0.55)'),
      },
    });
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => render());
  }

  // ---- Clip canvases (filmstrip, waveform) --------------------------------
  function queueCanvases() {
    if (canvasQueued) return;
    canvasQueued = true;
    requestAnimationFrame(drawCanvases);
  }

  function drawCanvases() {
    canvasQueued = false;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const viewL = scroller.scrollLeft;
    const viewR = viewL + scroller.clientWidth;
    for (const row of rows) {
      for (const clip of row.track.clips) {
        const e = clipEls.get(clip.id);
        if (!e || !e.node.isConnected) continue;
        const x = timeToX(clip.start);
        const w = (clip.duration / US) * pps;
        // Visible slice of the clip, in clip-local px.
        const s0 = Math.max(0, viewL - x - 50);
        const s1 = Math.min(w, viewR - x + 50);
        const cv = e.cv;
        if (s1 <= s0 || !['video', 'image', 'audio'].includes(clip.type)) {
          cv.width = 0;
          continue;
        }
        const ch = row.h - (clip.type === 'audio' ? 16 : 18);
        const cw = Math.ceil(s1 - s0);
        cv.style.left = `${s0}px`;
        cv.style.width = `${cw}px`;
        cv.style.height = `${ch}px`;
        cv.width = Math.ceil(cw * dpr);
        cv.height = Math.ceil(ch * dpr);
        const g = cv.getContext('2d');
        if (!g) continue;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const asset = store.project.assets[clip.assetId];
        if (!asset) continue;
        if (clip.type === 'audio') {
          drawWave(g, clip, asset, s0, cw, ch, false);
          if (clip.beats) drawBeats(g, clip, s0, cw, ch);
        }
        else {
          drawFilm(g, clip, asset, s0, cw, ch);
        }
      }
    }
  }

  function drawFilm(g, clip, asset, s0, cw, ch) {
    const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9;
    const tw = Math.max(16, ch * aspect);
    const first = Math.floor(s0 / tw);
    const speed = clip.freeze ? 0 : clip.speed || 1;
    const step = MediaService.stepFor(pps / Math.max(0.1, speed || 1), tw);
    // Source time per thumbnail follows the speed curve, if any.
    const map = sourceMapper(clip);
    for (let i = first; i * tw < s0 + cw; i++) {
      const lx = i * tw;
      const local = ((lx + tw / 2) / pps) * US;
      const sec = (clip.in + map(local)) / US;
      const bmp = media.thumb(asset, Math.max(0, Math.min(sec, asset.duration / US - 0.05)), step);
      if (!bmp) continue;
      const k = Math.max(tw / bmp.width, ch / bmp.height);
      const dw = bmp.width * k;
      const dh = bmp.height * k;
      g.save();
      g.beginPath();
      g.rect(lx - s0, 0, tw, ch);
      g.clip();
      g.drawImage(bmp, lx - s0 + (tw - dw) / 2, (ch - dh) / 2, dw, dh);
      g.restore();
    }
  }

  /** Detected beats as short ticks along the bottom of an audio clip. */
  function drawBeats(g, clip, s0, cw, ch) {
    g.fillStyle = cssVar(el, '--marker', '#f5b83d');
    for (const t of beatTimes(clip)) {
      const x = Math.round(((t - clip.start) / US) * pps - s0);
      if (x >= 0 && x <= cw) g.fillRect(x, ch - 6, 1, 6);
    }
  }

  function drawWave(g, clip, asset, s0, cw, ch) {
    const pk = media.peaksNow(asset);
    if (!pk || !pk.data.length) return;
    const color = cssVar(el, '--clip-audio-wave', '#9be0b8');
    g.fillStyle = color;
    const mid = ch / 2;
    // Scale to the file's own peak so quiet recordings stay readable.
    if (pk.max === undefined) {
      let m = 0;
      for (let i = 0; i < pk.data.length; i++) m = Math.max(m, Math.abs(pk.data[i]));
      pk.max = m || 1;
    }
    const gain = (Math.min(2, clip.volume ?? 1) * 0.95) / Math.max(0.25, pk.max);
    const n = pk.data.length / 2;
    const map = clip.freeze ? (x) => x * (clip.speed || 1) : sourceMapper(clip);
    for (let px = 0; px < cw; px++) {
      const a = ((s0 + px) / pps) * US;
      const b = ((s0 + px + 1) / pps) * US;
      const sa = (clip.in + map(a)) / US;
      const sb = (clip.in + map(b)) / US;
      let i0 = Math.floor(sa * pk.rate);
      let i1 = Math.max(i0 + 1, Math.ceil(sb * pk.rate));
      if (i0 >= n) break;
      i1 = Math.min(n, i1);
      let lo = 0;
      let hi = 0;
      for (let i = i0; i < i1; i++) {
        lo = Math.min(lo, pk.data[i * 2]);
        hi = Math.max(hi, pk.data[i * 2 + 1]);
      }
      const y0 = mid - hi * mid * gain;
      const y1 = mid - lo * mid * gain;
      g.fillRect(px, y0, 1, Math.max(1, y1 - y0));
    }
  }

  const mediaOffs = [media.on('thumb', queueCanvases), media.on('peaks', queueCanvases)];
  // Ask for peaks of every audible asset once.
  function warmPeaks() {
    for (const t of store.project.tracks) {
      if (t.kind !== 'audio') continue;
      for (const c of t.clips) {
        const a = store.project.assets[c.assetId];
        if (a) media.peaks(a);
      }
    }
  }

  // ---- Pointer interactions ---------------------------------------------
  function contentPoint(e) {
    const r = content.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function rowAt(y) {
    return rows.find((r) => y >= r.y && y < r.y + r.h) || null;
  }

  /** Where a dragged clip of kind would land at content y: an existing row or a new track index. */
  function dropTarget(kind, y) {
    const row = rowAt(y);
    if (row && row.track.kind === kind && !row.track.locked) return { trackId: row.track.id, row };
    if (row && row.track.kind === kind && row.track.locked) return null;
    // Above the first row or in the top gap: new track at the top of its group.
    if (!rows.length) return null;
    if (y < rows[0].y) {
      if (kind === 'audio') return null;
      const idx = kind === 'video' ? store.project.tracks.findIndex((t) => t.kind === 'video') : 0;
      return { newTrackAt: Math.max(0, idx), y: rows[0].y - 6 };
    }
    const last = rows[rows.length - 1];
    if (y >= last.y + last.h) {
      if (kind !== 'audio') return null;
      return { newTrackAt: store.project.tracks.length, y: last.y + last.h + 2 };
    }
    // Between rows: a new track there if the neighbors allow that kind.
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i];
      const b = rows[i + 1];
      if (y >= a.y + a.h && y < b.y) {
        const ok = a.track.kind === kind || b.track.kind === kind;
        if (ok && !(kind === 'video' && b.index > store.project.tracks.findIndex((t) => t.main))) return { newTrackAt: b.index, y: b.y - 3 };
      }
    }
    return null;
  }

  function snapThreshold() {
    return ((pref('snapPx') || SNAP_PX) / pps) * US;
  }

  function showSnap(t) {
    if (t === null || t === undefined) {
      snapLine.hidden = true;
      return;
    }
    snapLine.hidden = false;
    snapLine.style.transform = `translateX(${timeToX(t)}px)`;
  }

  tracksEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      touchDown(e);
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    const clipNode = e.target.closest('.tl-clip');
    const p = contentPoint(e);
    if (e.button === 2) return; // context menu handles it
    if (!clipNode) {
      // Empty area: seek and start a marquee.
      tracksEl.focus?.();
      startMarquee(e, p);
      return;
    }
    const id = clipNode.dataset.id;
    const found = T.findClip(store.project, id);
    if (!found) return;
    activeId = id;
    if (tool === 'split') {
      const t = snapToFrame(xToTime(p.x), store.fps);
      store.update('Split', (proj) => Boolean(T.splitClip(proj, id, t)));
      return;
    }
    const dot = e.target.closest('.kf-dot');
    if (dot && store.selection.has(id) && !found.track.locked) {
      e.preventDefault();
      tracksEl.setPointerCapture(e.pointerId);
      startKeyDrag(e, id, Number(dot.dataset.t), p);
      return;
    }
    if (tool === 'forwardTrack' || tool === 'forwardAll') {
      store.select(T.expandGroups(store.project, T.clipsFrom(store.project, id, { allTracks: tool === 'forwardAll' })));
      if (found.track.locked) return;
      e.preventDefault();
      tracksEl.setPointerCapture(e.pointerId);
      startMove(e, id, p);
      return;
    }
    const edge = e.target.closest('.clip-trim')?.dataset.edge;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    // Grouped clips are picked together; Alt picks a single member.
    const members = e.altKey ? [id] : T.groupMembers(store.project, id);
    if (additive) {
      const on = !store.selection.has(id);
      const next = new Set(store.selection);
      for (const m of members) on ? next.add(m) : next.delete(m);
      store.select([...next]);
    } else if (!store.selection.has(id)) store.select(members);
    if (found.track.locked) return;
    e.preventDefault();
    clipNode.focus({ preventScroll: true });
    tracksEl.setPointerCapture(e.pointerId);
    if (edge) startTrim(e, id, edge, p);
    else startMove(e, id, p);
  });

  /** Drag a keyframe (every property keyed at that time) along its clip. */
  function startKeyDrag(e, id, from, p0) {
    const { clip } = T.findClip(store.project, id);
    const node = clipEls.get(id)?.node;
    const dot = e.target.closest('.kf-dot');
    let moved = false;
    let to = from;
    drag = { type: 'key' };
    const move = (ev) => {
      const p = contentPoint(ev);
      if (!moved && Math.abs(p.x - p0.x) < 3) return;
      moved = true;
      player.pause();
      to = Math.round(clamp(from + ((p.x - p0.x) / pps) * US, 0, clip.duration));
      to = snapToFrame(clip.start + to, store.fps) - clip.start;
      if (dot) dot.style.left = `${(to / US) * pps}px`;
      tip.show(ev, `Keyframe ${timecode(clip.start + to, store.fps)}`);
    };
    const up = () => {
      tracksEl.removeEventListener('pointermove', move);
      tracksEl.removeEventListener('pointerup', up);
      tracksEl.removeEventListener('pointercancel', up);
      tip.hide();
      drag = null;
      if (!moved) {
        // A click on a keyframe moves the playhead to it.
        store.seek(clip.start + from);
        return;
      }
      if (to !== from) actions.moveKeyframe(id, from, to);
      else render();
      void node;
    };
    tracksEl.addEventListener('pointermove', move);
    tracksEl.addEventListener('pointerup', up);
    tracksEl.addEventListener('pointercancel', up);
  }

  function keyMenu(anchor, id, local) {
    const clip = T.findClip(store.project, id)?.clip;
    if (!clip) return;
    const cur = T.keyEaseAt(clip, local, Math.round(US / store.fps / 2));
    showMenu(anchor, [
      ...Object.entries(EASE_LABELS).map(([k, label]) => ({ label, icon: 'easing', radio: true, checked: cur === k, onSelect: () => actions.setKeyEase(k, id, local) })),
      'separator',
      { label: 'Go to keyframe', icon: 'keyframe', onSelect: () => store.seek(clip.start + local) },
      { label: 'Delete keyframe', icon: 'trash', danger: true, onSelect: () => actions.removeKeyframesAt(id, local) },
    ], { label: 'Keyframe' });
  }

  function startMarquee(e, p0) {
    const startT = xToTime(p0.x);
    let moved = false;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = additive ? new Set(store.selection) : new Set();
    tracksEl.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const p = contentPoint(ev);
      if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) < 4) return;
      moved = true;
      const x0 = Math.min(p0.x, p.x);
      const x1 = Math.max(p0.x, p.x);
      const y0 = Math.min(p0.y, p.y);
      const y1 = Math.max(p0.y, p.y);
      Object.assign(marquee.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
      marquee.hidden = false;
      const ta = xToTime(x0);
      const tbb = xToTime(x1);
      const ids = new Set(base);
      for (const row of rows) {
        if (row.y + row.h < y0 || row.y > y1) continue;
        for (const c of row.track.clips) if (T.clipEnd(c) > ta && c.start < tbb) ids.add(c.id);
      }
      store.select(T.expandGroups(store.project, [...ids]));
    };
    const up = () => {
      marquee.hidden = true;
      tracksEl.removeEventListener('pointermove', move);
      tracksEl.removeEventListener('pointerup', up);
      tracksEl.removeEventListener('pointercancel', up);
      if (!moved) {
        if (!additive) store.clearSelection();
        store.seek(snapToFrame(startT, store.fps));
      }
    };
    tracksEl.addEventListener('pointermove', move);
    tracksEl.addEventListener('pointerup', up);
    tracksEl.addEventListener('pointercancel', up);
  }

  function startMove(e, id, p0) {
    const { clip, track } = T.findClip(store.project, id);
    const kind = track.kind;
    const moving = [...store.selection].filter((x) => T.findClip(store.project, x) && !T.findClip(store.project, x).track.locked);
    if (!moving.includes(id)) moving.push(id);
    const exclude = new Set(moving);
    const points = T.snapPoints(store.project, { exclude, playhead: store.time });
    const nodes = moving.map((mid) => clipEls.get(mid)?.node).filter(Boolean);
    const origStart = clip.start;
    const startRow = rows.find((r) => r.track === track);
    const minStart = Math.min(...moving.map((mid) => T.findClip(store.project, mid).clip.start));
    let moved = false;
    let target = { start: origStart, trackId: track.id };
    drag = { type: 'move' };
    const move = (ev) => {
      const p = contentPoint(ev);
      if (!moved && Math.abs(p.x - p0.x) < 3 && Math.abs(p.y - p0.y) < 3) return;
      if (!moved) {
        moved = true;
        player.pause();
        nodes.forEach((n) => n.classList.add('dragging'));
      }
      let start = origStart + ((p.x - p0.x) / pps) * US;
      start = Math.max(origStart - minStart, start); // keep the group at or after 0
      let snapAt = null;
      if (store.toggles.snap !== ev.altKey) {
        const s = T.snapRange(start, clip.duration, points, snapThreshold());
        if (s.snapped) {
          start = s.start;
          snapAt = s.at;
        }
      }
      start = Math.max(0, Math.round(start));
      showSnap(snapAt);
      const dt = start - origStart;
      let dy = 0;
      insertLine.hidden = true;
      const dropT = moving.length === 1 ? dropTarget(kind, p.y) : null;
      if (dropT?.row) {
        dy = dropT.row.y - startRow.y;
        target = { start, trackId: dropT.row.track.id };
        if (dropT.row.track.main && store.toggles.ripple) {
          // Show where the clip will be inserted.
          const idx = T.mainInsertIndex(store.project, start, id);
          const others = dropT.row.track.clips.filter((c) => c.id !== id);
          const at = idx < others.length ? others[idx].start : others.length ? T.clipEnd(others[others.length - 1]) : 0;
          insertLine.hidden = false;
          Object.assign(insertLine.style, { transform: `translateX(${timeToX(at)}px)`, top: `${dropT.row.y - 2}px`, height: `${dropT.row.h + 4}px`, width: '' });
        }
      } else if (dropT && dropT.newTrackAt !== undefined) {
        dy = dropT.y - startRow.y - startRow.h / 2;
        target = { start, newTrackAt: dropT.newTrackAt };
        insertLine.hidden = false;
        Object.assign(insertLine.style, { transform: `translateX(${timeToX(start)}px)`, top: `${dropT.y}px`, height: '3px', width: `${(clip.duration / US) * pps}px` });
      } else {
        target = { start, trackId: track.id };
      }
      for (const n of nodes) {
        const c = T.findClip(store.project, n.dataset.id)?.clip;
        if (!c) continue;
        n.style.transform = `translate(${timeToX(c.start + dt)}px, ${n.dataset.id === id ? dy : 0}px)`;
      }
      autoScroll(ev);
    };
    const up = () => {
      tracksEl.removeEventListener('pointermove', move);
      tracksEl.removeEventListener('pointerup', up);
      tracksEl.removeEventListener('pointercancel', up);
      showSnap(null);
      insertLine.hidden = true;
      drag = null;
      stopAutoScroll();
      nodes.forEach((n) => n.classList.remove('dragging'));
      if (!moved) return;
      const ok = store.update(moving.length > 1 ? 'Move clips' : 'Move clip', (proj) => T.moveClip(proj, id, target, { ...store.opts, with: moving }));
      if (!ok) render(true);
    };
    tracksEl.addEventListener('pointermove', move);
    tracksEl.addEventListener('pointerup', up);
    tracksEl.addEventListener('pointercancel', up);
  }

  function startTrim(e, id, edge, p0) {
    const { clip } = T.findClip(store.project, id);
    const bounds = T.trimBounds(store.project, id, edge, store.opts);
    const points = T.snapPoints(store.project, { exclude: new Set([id]), playhead: store.time });
    const node = clipEls.get(id).node;
    const origEdge = edge === 'start' ? clip.start : T.clipEnd(clip);
    let at = origEdge;
    let moved = false;
    drag = { type: 'trim' };
    const move = (ev) => {
      const p = contentPoint(ev);
      if (!moved && Math.abs(p.x - p0.x) < 2) return;
      if (!moved) {
        moved = true;
        player.pause();
        node.classList.add('trimming');
      }
      let t = origEdge + ((p.x - p0.x) / pps) * US;
      let snapAt = null;
      if (store.toggles.snap !== ev.altKey) {
        const s = T.snap(t, points, snapThreshold());
        if (s.snapped) {
          t = s.time;
          snapAt = s.time;
        }
      }
      at = Math.round(clamp(t, bounds.lo, bounds.hi));
      if (snapAt !== null && at !== snapAt) snapAt = null;
      showSnap(snapAt);
      const start = edge === 'start' ? at : clip.start;
      const end = edge === 'end' ? at : T.clipEnd(clip);
      node.style.transform = `translateX(${timeToX(start)}px)`;
      node.style.width = `${Math.max(2, ((end - start) / US) * pps)}px`;
      // Preview the frame at the new edge.
      player.setPreview(edge === 'start' ? at : Math.max(start, at - Math.round(US / store.fps)));
      tip.show(ev, `${edge === 'start' ? 'Start' : 'End'} ${timecode(at, store.fps)}  Duration ${timecode(end - start, store.fps)}`);
      autoScroll(ev);
    };
    const up = () => {
      tracksEl.removeEventListener('pointermove', move);
      tracksEl.removeEventListener('pointerup', up);
      tracksEl.removeEventListener('pointercancel', up);
      node.classList.remove('trimming');
      showSnap(null);
      tip.hide();
      drag = null;
      stopAutoScroll();
      player.setPreview(null);
      if (!moved || at === origEdge) {
        render();
        return;
      }
      store.update('Trim', (proj) => T.trimClip(proj, id, edge, at, store.opts));
    };
    tracksEl.addEventListener('pointermove', move);
    tracksEl.addEventListener('pointerup', up);
    tracksEl.addEventListener('pointercancel', up);
  }

  // ---- Touch input ------------------------------------------------------
  // One finger pans natively (touch-action on .tl-content). A long press on a
  // clip lifts it for dragging, so scrolling never moves clips by accident;
  // the trim handles of the selected clip act at once; two fingers pinch to
  // zoom. While a gesture owns the touch, touchmove is cancelled so the page
  // does not scroll under it.
  let press = null;
  let touchDrag = false;
  const pinch = createPinch({
    onStart: () => {
      press?.cancel();
      press = null;
    },
    onChange: (step, total, c) => {
      if (centered) {
        setPps(pps * step);
        return;
      }
      const r = content.getBoundingClientRect();
      setPps(pps * step, { time: xToTime(c.x - r.left), px: c.x - scroller.getBoundingClientRect().left - headerWidth() });
    },
  });
  function blockTouchScroll(e) {
    if (touchDrag || pinch.active || e.touches.length > 1) e.preventDefault();
  }
  tracksEl.addEventListener('touchmove', blockTouchScroll, { passive: false });
  tracksEl.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') pinch.move(e);
  });
  const pinchUp = (e) => {
    if (e.pointerType === 'touch') pinch.up(e);
  };
  tracksEl.addEventListener('pointerup', pinchUp);
  tracksEl.addEventListener('pointercancel', pinchUp);
  // Android opens a context menu on long press; the press is a drag here.
  tracksEl.addEventListener('contextmenu', (e) => {
    if (!touchDrag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  function holdTouch(pointerId) {
    touchDrag = true;
    try {
      tracksEl.setPointerCapture(pointerId);
    } catch {
      /* the pointer already ended */
    }
    const end = (ev) => {
      if (ev.pointerId !== pointerId) return;
      touchDrag = false;
      tracksEl.removeEventListener('pointerup', end);
      tracksEl.removeEventListener('pointercancel', end);
    };
    tracksEl.addEventListener('pointerup', end);
    tracksEl.addEventListener('pointercancel', end);
  }

  function touchDown(e) {
    if (touchDrag) return;
    if (pinch.down(e)) return;
    const clipNode = e.target.closest('.tl-clip');
    const p = contentPoint(e);
    const id = clipNode?.dataset.id;
    const found = id ? T.findClip(store.project, id) : null;
    const edge = e.target.closest('.clip-trim')?.dataset.edge;
    if (found && edge && store.selection.has(id) && !found.track.locked && tool !== 'split') {
      activeId = id;
      holdTouch(e.pointerId);
      startTrim(e, id, edge, p);
      return;
    }
    press?.cancel();
    const pointerId = e.pointerId;
    const lp = longPress(e, {
      onPress: () => {
        if (!found || found.track.locked || tool === 'split' || pinch.active) return;
        activeId = id;
        if (!store.selection.has(id)) store.select(id);
        navigator.vibrate?.(8);
        holdTouch(pointerId);
        startMove(e, id, p);
      },
    });
    press = lp;
    const cleanup = () => {
      lp.cancel();
      tracksEl.removeEventListener('pointermove', move);
      tracksEl.removeEventListener('pointerup', up);
      tracksEl.removeEventListener('pointercancel', up);
      if (press === lp) press = null;
    };
    const move = (ev) => {
      if (ev.pointerId === pointerId && !lp.move(ev)) cleanup();
    };
    const up = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const tap = ev.type === 'pointerup' && !lp.fired && !pinch.active && pinch.count === 0;
      cleanup();
      if (!tap) return;
      if (!found) {
        store.clearSelection();
        if (!centered) store.seek(snapToFrame(xToTime(p.x), store.fps));
        return;
      }
      activeId = id;
      if (tool === 'split') {
        store.update('Split', (proj) => Boolean(T.splitClip(proj, id, snapToFrame(xToTime(p.x), store.fps))));
        return;
      }
      store.select(id);
      clipNode.focus({ preventScroll: true });
    };
    tracksEl.addEventListener('pointermove', move);
    tracksEl.addEventListener('pointerup', up);
    tracksEl.addEventListener('pointercancel', up);
  }

  // ---- Centered playhead (phones) ------------------------------------------
  // Time 0 and the end can both reach the middle because the lead-in padding
  // grows to half the view; scrolling by hand seeks to the middle.
  let expectScroll = -1;
  let lastLeft = 0;
  let seekingFromScroll = false;
  function updateLead() {
    const next = centered ? Math.max(BASE_PAD, Math.round((scroller.clientWidth - headerWidth()) / 2)) : BASE_PAD;
    if (next === PAD) return false;
    PAD = next;
    return true;
  }
  function centerOn(t) {
    const vw = scroller.clientWidth - headerWidth();
    const x = Math.max(0, Math.round(timeToX(t) - vw / 2));
    if (Math.abs(scroller.scrollLeft - x) < 1) return;
    expectScroll = x;
    scroller.scrollLeft = x;
  }
  function scrollSeek() {
    const x = scroller.scrollLeft;
    if (Math.abs(x - lastLeft) < 0.5) return; // vertical scroll
    lastLeft = x;
    if (expectScroll >= 0 && Math.abs(x - expectScroll) < 1.5) {
      expectScroll = -1;
      return;
    }
    expectScroll = -1;
    // Edge auto-scroll during a drag also moves the time, so the playhead stays centered.
    const t = snapToFrame(xToTime(x + (scroller.clientWidth - headerWidth()) / 2), store.fps);
    if (Math.abs(timeToX(t) - timeToX(store.time)) < 1) return;
    if (player.playing) player.pause();
    seekingFromScroll = true;
    store.seek(t);
    seekingFromScroll = false;
  }
  function setCentered(on) {
    on = Boolean(on);
    if (on === centered) return;
    centered = on;
    el.classList.toggle('centered', on);
    updateLead();
    render(true);
    if (on) centerOn(store.time);
  }

  // Floating readout during trims.
  const tipEl = h('div.tl-tip', { hidden: true, 'aria-hidden': 'true' });
  el.append(tipEl);
  const tip = {
    show(ev, text) {
      tipEl.hidden = false;
      tipEl.textContent = text;
      const r = el.getBoundingClientRect();
      tipEl.style.transform = `translate(${ev.clientX - r.left + 12}px, ${ev.clientY - r.top - 30}px)`;
    },
    hide() {
      tipEl.hidden = true;
    },
  };

  // Edge auto-scroll while dragging.
  let scrollTimer = null;
  let scrollV = 0;
  function autoScroll(ev) {
    const r = scroller.getBoundingClientRect();
    const left = r.left + headerWidth();
    scrollV = ev.clientX < left + 30 ? -12 : ev.clientX > r.right - 30 ? 12 : 0;
    if (scrollV && !scrollTimer) {
      scrollTimer = setInterval(() => {
        scroller.scrollLeft += scrollV;
      }, 16);
    } else if (!scrollV) stopAutoScroll();
  }
  function stopAutoScroll() {
    clearInterval(scrollTimer);
    scrollTimer = null;
  }

  // Ruler and playhead scrubbing.
  function scrub(e) {
    e.preventDefault();
    player.pause();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const at = (ev) => {
      const r = content.getBoundingClientRect();
      let t = xToTime(ev.clientX - r.left);
      if (store.toggles.snap && !ev.altKey) {
        const pts = T.snapPoints(store.project, {});
        const s = T.snap(t, pts, snapThreshold());
        if (s.snapped) t = s.time;
      }
      store.seek(snapToFrame(t, store.fps));
    };
    at(e);
    const move = (ev) => at(ev);
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }
  /** Marker under a ruler x (client coordinates), within a few pixels. */
  function markerAt(clientX) {
    const r = content.getBoundingClientRect();
    const x = clientX - r.left;
    let best = null;
    let bestD = 6;
    for (const m of store.project.markers) {
      const d = Math.abs(timeToX(m.time) - x);
      if (d <= bestD) {
        best = m;
        bestD = d;
      }
    }
    return best;
  }

  // Markers can be dragged along the ruler; a click on one jumps to it.
  ruler.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const m = markerAt(e.clientX);
    if (!m) {
      scrub(e);
      return;
    }
    e.preventDefault();
    player.pause();
    ruler.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const t0 = m.time;
    const points = T.snapPoints(store.project, { playhead: store.time }).filter((p) => p !== t0);
    let moved = false;
    let to = t0;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      let t = Math.max(0, t0 + ((ev.clientX - x0) / pps) * US);
      if (store.toggles.snap !== ev.altKey) {
        const sn = T.snap(t, points, snapThreshold());
        if (sn.snapped) t = sn.time;
      }
      to = snapToFrame(t, store.fps);
      m.time = to; // live preview; committed as one edit on release
      drawRulerNow();
      tip.show(ev, `Marker ${timecode(to, store.fps)}`);
    };
    const up = () => {
      ruler.removeEventListener('pointermove', move);
      ruler.removeEventListener('pointerup', up);
      ruler.removeEventListener('pointercancel', up);
      tip.hide();
      if (!moved) {
        store.seek(m.time);
        return;
      }
      m.time = t0;
      if (to !== t0) actions.moveMarker(m.id, to);
      else drawRulerNow();
    };
    ruler.addEventListener('pointermove', move);
    ruler.addEventListener('pointerup', up);
    ruler.addEventListener('pointercancel', up);
  });
  ruler.addEventListener('pointermove', (e) => {
    const m = e.buttons ? null : markerAt(e.clientX);
    ruler.classList.toggle('over-marker', Boolean(m));
    ruler.title = m ? (m.label ? `${m.label} (${timecode(m.time, store.fps)})` : `Marker at ${timecode(m.time, store.fps)}`) + (m.note ? `\n${m.note}` : '') : '';
  });
  ruler.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const m = markerAt(e.clientX);
    const r = content.getBoundingClientRect();
    const t = snapToFrame(xToTime(e.clientX - r.left), store.fps);
    const k = (id) => ctx.commands.keyFor(id);
    if (m) {
      showMenu({ x: e.clientX, y: e.clientY }, [
        { label: 'Edit marker...', icon: 'pencil', onSelect: () => actions.editMarker(m.id) },
        { label: 'Go to marker', icon: 'bookmark', onSelect: () => store.seek(m.time) },
        { label: 'Delete marker', icon: 'trash', danger: true, onSelect: () => actions.removeMarkerById(m.id) },
        'separator',
        { label: 'Delete all markers', danger: true, onSelect: () => actions.clearMarkers() },
      ], { label: 'Marker' });
      return;
    }
    showMenu({ x: e.clientX, y: e.clientY }, [
      { label: 'Add marker here', icon: 'bookmark', onSelect: () => actions.addMarkerAt(t) },
      { label: 'Set in point here', icon: 'markIn', onSelect: () => store.update('Set in point', (p) => void T.setRangeIn(p, t), { structural: false }) },
      { label: 'Set out point here', icon: 'markOut', onSelect: () => store.update('Set out point', (p) => void T.setRangeOut(p, t), { structural: false }) },
      store.project.range ? { label: 'Clear in and out', icon: 'range', shortcut: k('clearRange'), onSelect: () => actions.clearRange() } : null,
      'separator',
      { label: 'Previous marker', shortcut: k('prevMarker'), disabled: !T.adjacentMarker(store.project, store.time, -1), onSelect: () => actions.goToMarker(-1) },
      { label: 'Next marker', shortcut: k('nextMarker'), disabled: !T.adjacentMarker(store.project, store.time, 1), onSelect: () => actions.goToMarker(1) },
      store.project.markers.length ? { label: 'Delete all markers', danger: true, onSelect: () => actions.clearMarkers() } : null,
    ].filter(Boolean), { label: 'Ruler' });
  });
  playhead.querySelector('.tl-playhead-cap').addEventListener('pointerdown', scrub);
  ruler.addEventListener('keydown', (e) => {
    const f = Math.round(US / store.fps);
    const map = { ArrowLeft: -f, ArrowRight: f, PageUp: -US, PageDown: US };
    if (e.key in map) {
      e.preventDefault();
      e.stopPropagation();
      store.seek(store.time + map[e.key] * (e.shiftKey ? 10 : 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      store.seek(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      store.seek(store.duration);
    }
  });
  ruler.addEventListener('dblclick', (e) => {
    const m = markerAt(e.clientX);
    if (m) actions.editMarker(m.id);
  });

  // Hover preview follows the pointer over the tracks.
  content.addEventListener('pointermove', (e) => {
    if (!store.toggles.hoverPreview || drag || player.playing || e.pointerType === 'touch') return;
    const p = contentPoint(e);
    const t = xToTime(p.x);
    previewLine.hidden = false;
    previewLine.style.transform = `translateX(${timeToX(t)}px)`;
    player.setPreview(t);
  });
  content.addEventListener('pointerleave', () => {
    previewLine.hidden = true;
    if (!drag) player.setPreview(null);
  });

  // Ctrl/Cmd + wheel (and trackpad pinch) zooms around the pointer.
  scroller.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = content.getBoundingClientRect();
    const x = e.clientX - r.left;
    const t = xToTime(x);
    const factor = Math.exp(-e.deltaY * 0.0025);
    setPps(pps * factor, { time: t, px: e.clientX - scroller.getBoundingClientRect().left - headerWidth() });
  }, { passive: false });

  scroller.addEventListener('scroll', () => {
    drawRulerNow();
    queueRender();
    notifyView();
    if (centered) scrollSeek();
  }, { passive: true });

  // Context menu on clips and empty space.
  tracksEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const clipNode = e.target.closest('.tl-clip');
    const dot = e.target.closest('.kf-dot');
    if (dot && clipNode) {
      keyMenu({ x: e.clientX, y: e.clientY }, clipNode.dataset.id, Number(dot.dataset.t));
      return;
    }
    if (clipNode) {
      const id = clipNode.dataset.id;
      if (!store.selection.has(id)) store.select(T.groupMembers(store.project, id));
      clipMenu({ x: e.clientX, y: e.clientY }, id);
    } else {
      const k = (id) => ctx.commands.keyFor(id);
      const range = store.project.range;
      showMenu({ x: e.clientX, y: e.clientY }, [
        { label: 'Paste', icon: 'paste', shortcut: k('paste'), disabled: !actions.hasClipboard(), onSelect: () => actions.paste() },
        { label: 'Select all', shortcut: k('selectAll'), onSelect: () => actions.selectAll() },
        { label: 'Select clips left of playhead', shortcut: k('selectLeft'), onSelect: () => actions.selectSide('left') },
        { label: 'Select clips right of playhead', shortcut: k('selectRight'), onSelect: () => actions.selectSide('right') },
        'separator',
        { label: 'Add marker', icon: 'bookmark', shortcut: k('marker'), onSelect: () => actions.addMarker() },
        { label: 'Set in point', icon: 'markIn', shortcut: k('markIn'), onSelect: () => actions.markIn() },
        { label: 'Set out point', icon: 'markOut', shortcut: k('markOut'), onSelect: () => actions.markOut() },
        range ? { label: 'Clear in and out', icon: 'range', shortcut: k('clearRange'), onSelect: () => actions.clearRange() } : null,
        range ? { label: 'Cut in to out and close the gap', icon: 'scissors', shortcut: k('cutRange'), onSelect: () => actions.removeRangeContent(true) } : null,
        range ? { label: 'Clear in to out, leave the gap', icon: 'trash', onSelect: () => actions.removeRangeContent(false) } : null,
        'separator',
        { label: 'Split all tracks here', icon: 'split', shortcut: k('splitAll'), onSelect: () => actions.splitAll() },
      ].filter(Boolean), { label: 'Timeline' });
    }
  });

  function clipMenu(anchor, id) {
    const f = T.findClip(store.project, id);
    if (!f) return;
    const c = f.clip;
    const k = (cmd) => ctx.commands.keyFor(cmd);
    const media = c.type === 'video' || c.type === 'image' || c.type === 'audio';
    const visual = 'transform' in c;
    const multi = store.selection.size > 1;
    const sel = store.selectedIds.map((x) => T.findClip(store.project, x)?.clip).filter(Boolean);
    const allOff = sel.length > 0 && sel.every((x) => x.disabled);
    const grouped = sel.some((x) => x.group);
    const oneGroup = sel.length > 1 && sel.every((x) => x.group && x.group === sel[0].group);
    const hasAudio = c.type === 'video' && store.project.assets[c.assetId]?.hasAudio && !c.audioDetached;
    const editItems = [
      c.type === 'video' ? { label: 'Freeze frame', icon: 'freeze', shortcut: k('freeze'), onSelect: () => actions.freeze() } : null,
      c.type === 'video' && !c.freeze ? { label: c.reversed ? 'Play forward' : 'Reverse', icon: 'reverse', onSelect: () => actions.reverseClip(id) } : null,
      visual ? { label: 'Mirror', icon: 'flipH', onSelect: () => actions.mirror() } : null,
      visual ? { label: 'Rotate 90 degrees', icon: 'rotate', onSelect: () => actions.rotate() } : null,
      c.type === 'video' || c.type === 'image' ? { label: 'Crop...', icon: 'crop', shortcut: k('crop'), onSelect: () => ctx.openCrop?.(id) } : null,
      hasAudio ? { label: 'Detach audio', icon: 'detachAudio', shortcut: k('detachAudio'), onSelect: () => actions.detachAudio() } : null,
      c.type === 'video' && store.project.assets[c.assetId]?.hasAudio ? { label: 'Extract audio', icon: 'fileAudio', onSelect: () => actions.extractAudio(id) } : null,
      c.type === 'video' && !c.freeze ? { label: 'Split at scene changes', icon: 'scissors', onSelect: () => actions.splitScenes(id) } : null,
      c.type === 'video' || c.type === 'image' ? { label: c.cutout ? 'Keep background' : 'Remove background', icon: 'cutout', onSelect: () => actions.removeBackground(id) } : null,
      c.type === 'video' || c.type === 'image' ? { label: 'Remove object...', icon: 'eraser', onSelect: () => ctx.inspector?.showVideoSub?.('remove') } : null,
      c.type === 'video' && !c.freeze ? { label: 'Stabilize...', icon: 'focus', onSelect: () => actions.stabilize(id) } : null,
      c.type === 'video' && !c.freeze ? { label: 'Remove flicker...', icon: 'brightness', onSelect: () => actions.removeFlicker(id) } : null,
      visual && !f.track.main ? { label: 'Track motion...', icon: 'crosshair', onSelect: () => ctx.openTracking?.(id) } : null,
      store.selection.size === 2 ? { label: 'Sync the two clips by sound', icon: 'waveform', onSelect: () => actions.syncBySound() } : null,
    ].filter(Boolean);
    showMenu(anchor, [
      { label: 'Copy', icon: 'copy', shortcut: k('copy'), onSelect: () => actions.copy() },
      { label: 'Cut', icon: 'scissors', shortcut: k('cut'), onSelect: () => actions.cut() },
      { label: 'Paste', icon: 'paste', shortcut: k('paste'), disabled: !actions.hasClipboard(), onSelect: () => actions.paste() },
      { label: 'Duplicate', icon: 'copy', shortcut: k('duplicate'), onSelect: () => actions.duplicate() },
      { label: 'Delete', icon: 'trash', shortcut: k('delete'), danger: true, onSelect: () => actions.deleteSelected() },
      'separator',
      { label: 'Copy attributes', icon: 'clipboard', shortcut: k('copyAttributes'), onSelect: () => actions.copyAttributes(id) },
      { label: 'Paste attributes...', icon: 'paste', shortcut: k('pasteAttributes'), disabled: !actions.hasAttributes(), onSelect: () => actions.pasteAttributes() },
      { label: 'Save as preset...', icon: 'bookmark', onSelect: () => saveClipPreset(ctx, id) },
      { label: 'Apply preset', icon: 'bookmark', submenu: () => presetMenu(ctx, c) },
      'separator',
      { label: 'Split', icon: 'split', shortcut: k('split'), onSelect: () => actions.split() },
      editItems.length ? { label: 'Edit', icon: 'wand', submenu: () => editItems } : null,
      media && c.type !== 'image' ? { label: c.muted ? 'Unmute clip' : 'Mute clip', icon: c.muted ? 'volume' : 'mute', onSelect: () => actions.toggleClipMute(id) } : null,
      media ? { label: 'Replace clip', icon: 'replace', submenu: () => {
        const list = Object.values(store.project.assets).filter((a) => a.id !== c.assetId && (c.type === 'audio' ? a.kind !== 'image' : a.kind !== 'audio'));
        return list.length ? list.map((a) => ({ label: a.name, icon: a.kind === 'image' ? 'image' : a.kind === 'audio' ? 'music' : 'film', onSelect: () => actions.replaceClip(id, a) })) : [{ label: 'Import media first', disabled: true }];
      } } : null,
      'separator',
      { label: 'Create compound clip', icon: 'layers', shortcut: k('compound'), onSelect: () => actions.createCompound() },
      c.type === 'compound' ? { label: 'Open compound clip', icon: 'layers', onSelect: () => actions.openCompound(id) } : null,
      c.type === 'compound' ? { label: 'Break apart', icon: 'ungroup', shortcut: k('breakApart'), onSelect: () => actions.breakApartCompound(id) } : null,
      multi && sel.filter((x) => x.type === 'video').length >= 2 ? { label: 'Create multi-camera clip...', icon: 'multicam', onSelect: () => actions.createMulticam() } : null,
      c.multicam ? { label: 'Flatten multi-camera clip', icon: 'rows', onSelect: () => actions.flattenMulticam(id) } : null,
      multi && !oneGroup ? { label: 'Group', icon: 'group', shortcut: k('group'), onSelect: () => actions.group() } : null,
      grouped ? { label: 'Ungroup', icon: 'ungroup', shortcut: k('ungroup'), onSelect: () => actions.ungroup() } : null,
      { label: allOff ? 'Enable clip' : 'Disable clip', icon: allOff ? 'power' : 'powerOff', shortcut: k('toggleDisabled'), onSelect: () => actions.toggleDisabled() },
      { label: 'Label', icon: 'tag', submenu: () => [
        { label: 'None', radio: true, checked: !c.label, onSelect: () => actions.setLabel(null) },
        ...CLIP_LABELS.map((l) => ({ label: LABEL_NAMES[l], radio: true, checked: c.label === l, swatch: LABEL_COLORS[l], onSelect: () => actions.setLabel(l) })),
      ] },
      { label: 'Mark as in and out', icon: 'range', shortcut: k('markClip'), onSelect: () => actions.rangeFromSelection() },
      c.transition ? { label: 'Remove transition', icon: 'transition', onSelect: () => actions.applyTransition(null, { clipId: id }) } : null,
    ].filter(Boolean), { label: T.clipLabel(store.project, c) });
  }

  tracksEl.addEventListener('dblclick', (e) => {
    const node = e.target.closest('.tl-clip');
    const c = node && T.findClip(store.project, node.dataset.id)?.clip;
    if (c?.type === 'compound') actions.openCompound(c.id);
  });

  // Keyboard navigation inside the tracks (roving focus over clips).
  tracksEl.addEventListener('keydown', (e) => {
    const node = e.target.closest?.('.tl-clip');
    if (!node) return;
    const id = node.dataset.id;
    const f = T.findClip(store.project, id);
    if (!f) return;
    const rowIdx = rows.findIndex((r) => r.track === f.track);
    const fr = Math.round(US / store.fps);
    const go = (clip) => {
      if (!clip) return;
      activeId = clip.id;
      store.select(clip.id);
      render();
      const n = clipEls.get(clip.id)?.node;
      n?.focus();
      ensureVisible(clip);
      announce(n?.getAttribute('aria-label') || '');
    };
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      const d = (e.key === 'ArrowRight' ? 1 : -1) * fr * (e.shiftKey ? 10 : 1);
      store.update('Nudge clip', (p) => T.moveClip(p, id, { start: Math.max(0, f.clip.start + d), trackId: f.track.id }, { ...store.opts, with: store.selectedIds }), { coalesce: `nudge:${id}` });
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      go(f.track.clips[f.index + (e.key === 'ArrowRight' ? 1 : -1)]);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const r = rows[rowIdx + (e.key === 'ArrowDown' ? 1 : -1)];
      if (!r || !r.track.clips.length) return;
      const mid = f.clip.start + f.clip.duration / 2;
      go(r.track.clips.reduce((best, c) => (Math.abs(c.start + c.duration / 2 - mid) < Math.abs(best.start + best.duration / 2 - mid) ? c : best)));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      go(e.key === 'Home' ? f.track.clips[0] : f.track.clips[f.track.clips.length - 1]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      store.seek(f.clip.start);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = node.getBoundingClientRect();
      clipMenu({ x: r.left + 12, y: r.bottom }, id);
    }
  });
  tracksEl.addEventListener('focusin', (e) => {
    const node = e.target.closest?.('.tl-clip');
    if (node) activeId = node.dataset.id;
  });

  function ensureVisible(clip) {
    const x = timeToX(clip.start);
    const vw = scroller.clientWidth - headerWidth();
    if (x < scroller.scrollLeft || x > scroller.scrollLeft + vw - 40) scroller.scrollLeft = Math.max(0, x - 60);
  }

  // Make the timeline reachable by Tab: focusing the lanes area moves focus to a clip.
  tracksEl.tabIndex = 0;
  tracksEl.setAttribute('aria-label', 'Tracks. Use arrow keys to move between clips.');
  tracksEl.setAttribute('role', 'group');
  tracksEl.addEventListener('focus', (e) => {
    if (e.target !== tracksEl) return;
    const sel = store.selectedIds[0];
    const first = sel || T.mainTrack(store.project)?.clips[0]?.id || T.allClips(store.project)[0]?.id;
    if (!first) return;
    activeId = first;
    render();
    clipEls.get(first)?.node.focus();
  });

  // ---- Drops from the assets panel and the desktop ----------------------
  function dropPayload(raw, { start, y, clipId } = {}) {
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      return;
    }
    const kindOf = { asset: null, text: 'text', sticker: 'text', effect: 'effect', filter: 'filter', transition: 'video', adjust: 'adjust' };
    let trackId;
    const t = Math.max(0, start ?? store.time);
    if (d.kind === 'asset') {
      const asset = store.project.assets[d.assetId];
      if (!asset) return;
      const a = d.audioOnly ? { ...asset, kind: 'audio' } : asset;
      const kind = a.kind === 'audio' ? 'audio' : 'video';
      const target = y !== undefined ? dropTarget(kind, y) : null;
      if (target?.row) trackId = target.row.track.id;
      const main = Boolean(target?.row?.track.main) || (!target && kind === 'video' && T.mainTrack(store.project).clips.length === 0);
      if (target?.newTrackAt !== undefined) {
        // A fresh track at that spot.
        store.update(`Add ${a.name}`, (p) => {
          const tr = T.addTrack(p, kind, target.newTrackAt);
          trackId = tr.id;
        }, { keepEmptyTracks: true });
        const last = store.history.undoStack.pop();
        void last;
      }
      actions.addAsset(a, { start: t, trackId: main ? undefined : trackId ?? (kind === 'video' ? null : undefined), main });
      return;
    }
    if (d.kind === 'transition') {
      // Nearest cut to the drop point on the row.
      const row = y !== undefined ? rowAt(y) : null;
      const track = row?.track.kind === 'video' ? row.track : T.mainTrack(store.project);
      let best = null;
      let bestD = Infinity;
      for (const c of track.clips) {
        if (!T.nextAdjacent(store.project, c.id)) continue;
        const dd = Math.abs(T.clipEnd(c) - t);
        if (dd < bestD) {
          best = c;
          bestD = dd;
        }
      }
      if (best) actions.applyTransition(d.id, { clipId: best.id });
      else toast('Drop a transition on a cut between two clips.', { kind: 'info' });
      return;
    }
    // An effect dropped on a visual clip joins that clip's own effects; a filter is applied to it.
    const onClip = clipId ? T.findClip(store.project, clipId) : null;
    if (onClip && !onClip.track.locked) {
      if (d.kind === 'effect' && canHaveEffects(onClip.clip)) {
        store.select(onClip.clip.id);
        actions.addClipEffect(onClip.clip.id, d.id);
        return;
      }
      if (d.kind === 'filter' && (onClip.clip.type === 'video' || onClip.clip.type === 'image')) {
        actions.addFilter(d.id, { toClip: onClip.clip });
        return;
      }
    }
    const target = y !== undefined ? dropTarget(kindOf[d.kind], y) : null;
    trackId = target?.row?.track.id;
    if (d.kind === 'text') actions.addText(d.id, { start: t, trackId });
    else if (d.kind === 'sticker') actions.addSticker(d.id, { start: t, trackId, color: d.color });
    else if (d.kind === 'effect' && isBodyEffect(d.id)) toast('Drop body effects on a video or image clip with people in it.', { kind: 'info' });
    else if (d.kind === 'effect') actions.addEffect(d.id, { start: t, trackId });
    else if (d.kind === 'filter') actions.addFilter(d.id, { start: t, trackId, asTrack: true });
    else if (d.kind === 'adjust') actions.addAdjustment({ start: t, trackId, name: d.name, adjust: d.adjust, grade: d.grade });
  }

  content.addEventListener('dragover', (e) => {
    const types = [...(e.dataTransfer?.types || [])];
    if (!types.includes('application/x-video-studio') && !types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const p = contentPoint(e);
    insertLine.hidden = false;
    Object.assign(insertLine.style, { transform: `translateX(${timeToX(xToTime(p.x))}px)`, top: '0px', height: '100%', width: '' });
  });
  content.addEventListener('dragleave', (e) => {
    if (!content.contains(e.relatedTarget)) insertLine.hidden = true;
  });
  content.addEventListener('drop', async (e) => {
    e.preventDefault();
    insertLine.hidden = true;
    const p = contentPoint(e);
    let t = xToTime(p.x);
    if (store.toggles.snap) {
      const s = T.snap(t, T.snapPoints(store.project, { playhead: store.time }), snapThreshold());
      if (s.snapped) t = s.time;
    }
    if (e.dataTransfer.files?.length) {
      const assets = await actions.importFiles([...e.dataTransfer.files]);
      let at = t;
      for (const a of assets) {
        const c = actions.addAsset(a, { start: at });
        if (c) at = c.start + c.duration;
      }
      return;
    }
    dropPayload(e.dataTransfer.getData('application/x-video-studio'), { start: t, y: p.y, clipId: e.target.closest?.('.tl-clip')?.dataset.id });
  });

  // ---- Store wiring --------------------------------------------------------
  const syncToggles = () => {
    rippleBtn.setAttribute('aria-pressed', String(store.toggles.ripple));
    snapBtn.setAttribute('aria-pressed', String(store.toggles.snap));
    linkBtn.setAttribute('aria-pressed', String(store.toggles.linkOverlays));
    hoverBtn.setAttribute('aria-pressed', String(store.toggles.hoverPreview));
    if (!store.toggles.hoverPreview) {
      previewLine.hidden = true;
      player.setPreview(null);
    }
  };
  const syncButtons = () => {
    undoBtn.disabled = !store.history.canUndo();
    redoBtn.disabled = !store.history.canRedo();
    undoBtn.setAttribute('data-tip', store.history.canUndo() ? `Undo ${store.history.undoLabel}` : 'Undo');
    redoBtn.setAttribute('data-tip', store.history.canRedo() ? `Redo ${store.history.redoLabel}` : 'Redo');
    const sel = store.selected;
    const hasSel = store.selection.size > 0;
    deleteBtn.disabled = !hasSel;
    freezeBtn.disabled = !(sel && sel.clip.type === 'video');
    cropBtn.disabled = !(sel && (sel.clip.type === 'video' || sel.clip.type === 'image'));
    mirrorBtn.disabled = !(sel && 'transform' in sel.clip);
    rotateBtn.disabled = !(sel && 'transform' in sel.clip);
    kfBtn.disabled = !sel;
  };
  const offs = [
    store.on('change', ({ restore }) => {
      if (restore) headerSig = '';
      warmPeaks();
      queueRender();
      syncButtons();
    }),
    store.on('select', () => {
      queueRender();
      syncButtons();
    }),
    store.on('toggles', syncToggles),
    store.on('nest', () => {
      const depth = store.nest.length;
      nestBack.hidden = !depth;
      el.classList.toggle('in-compound', depth > 0);
      nestBack.querySelector('.nest-label').textContent = depth ? `Back  ·  editing ${store.compoundName}` : '';
      nestBack.setAttribute('aria-label', depth ? `Back to the outer timeline. Editing ${store.compoundName}` : 'Back');
      headerSig = '';
      render(true);
    }),
    store.on('time', () => {
      placePlayhead();
      if (multicams.length) refreshAngleLabels();
      if (centered) {
        if (!seekingFromScroll) centerOn(store.time);
      } else if (player.playing) followPlayhead();
    }),
  ];

  function followPlayhead() {
    const mode = pref('followPlayhead');
    if (mode === 'off') return;
    const x = timeToX(store.time);
    const vw = scroller.clientWidth - headerWidth();
    if (mode === 'smooth') scroller.scrollLeft = Math.max(0, x - vw / 2);
    else if (x > scroller.scrollLeft + vw - 24) scroller.scrollLeft = x - 40;
    else if (x < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, x - 40);
  }

  const ro = new ResizeObserver(() => {
    if (centered && updateLead()) {
      render(true);
      centerOn(store.time);
    } else queueRender();
  });
  ro.observe(scroller);

  const api = {
    el,
    /** Horizontal mapping shared with the keyframe panel. */
    geometry: () => ({ pps, pad: PAD, scrollLeft: scroller.scrollLeft, headerW: headerWidth(), timeToX }),
    onView: (fn) => {
      viewListeners.add(fn);
      return () => viewListeners.delete(fn);
    },
    toggleKeyframePanel: () => {
      kfPanel.toggle();
      kfPanelBtn.setAttribute('aria-pressed', String(kfPanel.open));
    },
    zoomBy: (f) => setPps(pps * f),
    setCentered,
    get centered() {
      return centered;
    },
    zoomToFit,
    setTool,
    dropPayload,
    render,
    get pps() {
      return pps;
    },
    mounted() {
      syncZoomSlider();
      syncToggles();
      syncButtons();
      warmPeaks();
      if (!prefs().zoom) requestAnimationFrame(zoomToFit);
      render(true);
    },
    dispose() {
      kfPanel.dispose();
      offs.forEach((f) => f());
      mediaOffs.forEach((f) => f());
      ro.disconnect();
      stopAutoScroll();
      press?.cancel();
      tracksEl.removeEventListener('touchmove', blockTouchScroll);
    },
  };
  const kfPanel = createKeyframePanel(ctx, api);
  offs.push(onPrefsChange(() => render(true)));
  el.insertBefore(kfPanel.el, emptyHint);
  return api;
}
