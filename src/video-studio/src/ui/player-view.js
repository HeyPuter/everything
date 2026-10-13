/**
 * Player panel: the preview canvas, an on-canvas transform box for the
 * selected clip (move, scale, rotate with snapping to the frame, guides and
 * other clips), zoom and pan, rulers with draggable guides, safe zones, and
 * the playback bar (timecode, play, ratio, zoom, full screen).
 */
import { h, announce, clamp } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { timecode, US } from '../lib/time.js';
import { RATIOS } from '../model/project.js';
import { evaluate } from '../engine/scene.js';
import { rootClip } from '../engine/compound.js';
import { menuButton } from './menu.js';
import { prefs, setPref } from './prefs.js';
import { createPinch } from '../lib/gestures.js';
import { snapAxis, SAFE_ZONES, rulerStep } from './player-guides.js';
import { createMaskOverlay } from './mask-overlay.js';
import { maskEdit } from './mask-edit-state.js';
import { proxyMode, canProxy } from '../model/proxy.js';
import { createRemovalOverlay } from './removal-overlay.js';
import { removeEdit } from './remove-edit-state.js';
import '../styles/player-tools.css';
import '../styles/proxy.css';

const SNAP_PX = 6;
const RULER = 18;
const ZOOM_STEPS = [25, 50, 75, 100, 150, 200, 300, 400];

export function createPlayerView(ctx) {
  const { store, player, actions } = ctx;
  const canvas = player.canvas;
  const frame = h('div.player-frame', canvas);
  const decor = h('div.player-decor');
  const overlay = h('div.player-overlay');
  const snapLayer = h('div.snap-lines', { 'aria-hidden': 'true' });
  const guidesLayer = h('div.user-guides', { 'aria-hidden': 'true' });
  const rulerTop = h('canvas.player-ruler.top', { 'aria-hidden': 'true', hidden: true });
  const rulerLeft = h('canvas.player-ruler.left', { 'aria-hidden': 'true', hidden: true });
  const rulerCorner = h('div.player-ruler-corner', { hidden: true });
  const zoomBadge = h('span.player-zoom-badge', { hidden: true });
  // Guides sit above the transform overlay so they can be grabbed.
  const guidesHost = h('div.player-guides-host', guidesLayer);
  const stage = h('div.player-stage', {
    tabindex: '0',
    role: 'group',
    'aria-label': 'Video preview. Click a clip to select it. Arrow keys move the selected clip.',
    'aria-roledescription': 'preview',
    'data-own-arrows': '',
    'data-space-plays': '',
  }, frame, decor, overlay, guidesHost, rulerTop, rulerLeft, rulerCorner, zoomBadge);
  const unsupported = player.supported ? null : h('div.player-unsupported', icon('alert', 24), h('p', 'Preview needs WebGL2, which this browser does not provide.'));
  if (unsupported) stage.append(unsupported);

  const cur = h('span.tc-current', '00:00:00:00');
  const total = h('span.tc-total', '00:00:00:00');
  const playBtn = h('button.icon-btn.play-btn', { type: 'button', 'aria-label': 'Play', 'data-tip': 'Play', 'data-tip-key': 'Space', 'data-space-plays': '' }, icon('play', 20));
  playBtn.addEventListener('click', () => player.toggle());
  const ratioBtn = h('button.btn.small.ghost.ratio-btn', { type: 'button', 'data-tip': 'Aspect ratio' }, icon('ratio', 14), h('span.ratio-label', 'Ratio'));
  menuButton(ratioBtn, () => [
    { label: 'Original', checked: store.project.settings.ratio === 'original', radio: true, onSelect: () => setRatio('original') },
    ...RATIOS.map((r) => ({ label: `${r.label}  ${r.hint}`, checked: store.project.settings.ratio === r.id, radio: true, onSelect: () => setRatio(r.id) })),
  ], { side: 'top', align: 'end', label: 'Aspect ratio' });
  const fitBtn = h('button.btn.small.ghost.zoom-btn', { type: 'button', 'aria-label': 'Preview zoom', 'data-tip': 'Preview zoom' }, h('span.zoom-label', 'Fit'), icon('chevronDown', 12));
  menuButton(fitBtn, () => [
    { label: 'Zoom to fit', icon: 'scan', shortcut: ctx.commands?.keyFor('playerZoomFit'), checked: zoom === 1, radio: true, onSelect: () => zoomFit() },
    ...ZOOM_STEPS.map((pct) => ({ label: `${pct}%`, radio: true, checked: zoom !== 1 && Math.round(zoomPercent()) === pct, onSelect: () => setZoomPercent(pct) })),
    'separator',
    { label: 'Zoom in', icon: 'zoomIn', shortcut: ctx.commands?.keyFor('playerZoomIn'), onSelect: () => zoomBy(1.25) },
    { label: 'Zoom out', icon: 'zoomOut', shortcut: ctx.commands?.keyFor('playerZoomOut'), onSelect: () => zoomBy(1 / 1.25) },
  ], { side: 'top', align: 'end', label: 'Preview zoom' });
  const fsBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Full screen', 'data-tip': 'Full screen' }, icon('fullscreen', 18));
  fsBtn.addEventListener('click', () => toggleFullscreen());

  const bar = h('div.player-bar',
    h('div.player-bar-left', h('span.timecode', { 'aria-label': 'Current time and duration' }, cur, h('span.tc-sep', ' / '), total)),
    h('div.player-bar-center', playBtn),
    h('div.player-bar-right', ratioBtn, fitBtn, fsBtn),
  );
  const menuBtn = h('button.icon-btn.small.player-menu-btn', { type: 'button', 'aria-label': 'Player options', 'data-tip': 'Player options' }, icon('more', 16));
  const safePref = prefs().previewSafe;
  const opts = {
    quality: prefs().previewQuality || 'auto',
    grid: Boolean(prefs().previewGrid),
    // Older saves stored the safe area as a boolean.
    safe: safePref === true ? 'broadcast' : SAFE_ZONES.some((z) => z.id === safePref) ? safePref : 'none',
    rulers: Boolean(prefs().previewRulers),
    guides: prefs().previewGuides !== false,
    snap: prefs().previewSnap !== false,
  };
  menuButton(menuBtn, () => [
    { heading: 'Preview quality' },
    ...[['auto', 'Auto'], ['full', 'Full'], ['half', 'Half (smoother playback)']].map(([v, label]) => ({ label, checked: opts.quality === v, radio: true, onSelect: () => setOpt('quality', v) })),
    'separator',
    { label: 'Grid lines', icon: 'gridLines', checked: opts.grid, onSelect: () => setOpt('grid', !opts.grid) },
    { label: 'Safe zones', icon: 'focus', submenu: () => SAFE_ZONES.map((z) => ({ label: z.label, radio: true, checked: opts.safe === z.id, onSelect: () => setOpt('safe', z.id) })) },
    { label: 'Rulers', icon: 'ruler', shortcut: ctx.commands?.keyFor('toggleRulers'), checked: opts.rulers, onSelect: () => setOpt('rulers', !opts.rulers) },
    { label: 'Guides', icon: 'crosshair', shortcut: ctx.commands?.keyFor('toggleGuides'), checked: opts.guides, onSelect: () => setOpt('guides', !opts.guides) },
    { label: 'Snap to edges and guides', icon: 'magnet', checked: opts.snap, onSelect: () => setOpt('snap', !opts.snap) },
    guides().v.length || guides().h.length ? { label: 'Clear guides', icon: 'trash', onSelect: () => clearGuides() } : null,
    'separator',
    { label: 'Save frame to media', icon: 'imagePlus', onSelect: () => ctx.snapshotToMedia?.() },
    { label: 'Export frame as image', icon: 'download', onSelect: () => ctx.exportStill?.() },
  ].filter(Boolean), { align: 'end', label: 'Player options' });
  // Which of the project's timelines is playing; the menu switches or adds timelines.
  const tlName = h('span.player-timeline-name');
  const tlBtn = h('button.player-timeline-btn', { type: 'button', 'aria-label': 'Timelines', 'data-tip': 'Switch or add timelines' }, icon('timelines', 14), tlName, icon('chevronDown', 12));
  menuButton(tlBtn, () => ctx.timelines?.menuItems() || [], { label: 'Timelines' });
  const renderTimelineName = () => {
    const name = ctx.timelines?.active().name || 'Timeline 1';
    if (tlName.textContent !== name) tlName.textContent = name;
    tlBtn.setAttribute('aria-label', `Timeline: ${name}. Switch or add timelines`);
  };
  renderTimelineName();
    // Compare proxies with the original files (shown while any media here has a ready proxy).
  const proxyBtn = h('button.btn.small.ghost.proxy-toggle', { type: 'button', hidden: true, 'aria-pressed': 'true' }, icon('zap', 14), h('span.proxy-toggle-label', 'Proxy'));
  proxyBtn.addEventListener('click', () => {
    player.setShowOriginal?.(!player.showOriginal);
    announce(player.showOriginal ? 'Showing the original media' : 'Showing proxy media');
  });
  const syncProxyBtn = () => {
    const proxies = ctx.proxies;
    const p = store.project;
    const any = Boolean(proxies) && proxyMode(p) !== 'off' && Object.values(p.assets).some((a) => canProxy(a) && proxies.isReady(a));
    proxyBtn.hidden = !any;
    const original = Boolean(player.showOriginal);
    proxyBtn.setAttribute('aria-pressed', String(!original));
    proxyBtn.querySelector('.proxy-toggle-label').textContent = original ? 'Original' : 'Proxy';
    proxyBtn.dataset.tip = original ? 'Showing the original files. Click to use proxies' : 'Showing proxy media. Click to compare with the original files';
    proxyBtn.setAttribute('aria-label', 'Use proxy media in the preview');
  };
  syncProxyBtn();
  const head = h('div.panel-head', h('h2.panel-title', 'Player'), tlBtn, h('span.spacer'), proxyBtn, menuBtn);
  const grid = h('div.player-grid', { 'aria-hidden': 'true', hidden: !opts.grid },
    h('span.gv', { style: { left: '33.333%' } }), h('span.gv', { style: { left: '66.666%' } }),
    h('span.gh', { style: { top: '33.333%' } }), h('span.gh', { style: { top: '66.666%' } }));
  const safe = h('div.player-safe-zones', { 'aria-hidden': 'true' });
  function renderSafe() {
    const z = SAFE_ZONES.find((x) => x.id === opts.safe);
    safe.replaceChildren(...(z?.regions || []).map((r) => h(`div.safe-region.${r.kind}`, { style: { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` } }, r.label ? h('span', r.label) : null)));
  }
  function setOpt(key, value) {
    opts[key] = value;
    setPref({ quality: 'previewQuality', grid: 'previewGrid', safe: 'previewSafe', rulers: 'previewRulers', guides: 'previewGuides', snap: 'previewSnap' }[key], value);
    grid.hidden = !opts.grid;
    renderSafe();
    player.quality = opts.quality;
    relayout();
  }
  player.quality = opts.quality;
  renderSafe();
  decor.append(grid, safe, snapLayer);
  const el = h('section.panel.player-panel', { 'aria-label': 'Player' }, head, stage, bar);

  let cssW = 0;
  let cssH = 0;
  let zoom = 1; // multiple of the fitted size
  const pan = { x: 0, y: 0 };

  function setRatio(id) {
    const r = RATIOS.find((x) => x.id === id);
    if (!r) {
      actions.setProjectSettings({ ratio: id }, 'Change aspect ratio');
      return;
    }
    const s = store.project.settings;
    const short = Math.min(s.width, s.height);
    const k = short / Math.min(r.w, r.h);
    const even = (n) => Math.max(16, Math.round(n / 2) * 2);
    actions.setProjectSettings({ ratio: id, width: even(r.w * k), height: even(r.h * k) }, 'Change aspect ratio');
    announce(`Aspect ratio ${r.label}`);
  }

  function relayout() {
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const pad = opts.rulers ? 16 + RULER : 16;
    const size = player.layout((rect.width - pad * 2) * zoom, (rect.height - pad * 2) * zoom);
    cssW = size.cssW;
    cssH = size.cssH;
    frame.style.width = `${cssW}px`;
    frame.style.height = `${cssH}px`;
    overlay.style.width = `${cssW}px`;
    overlay.style.height = `${cssH}px`;
    decor.style.width = `${cssW}px`;
    decor.style.height = `${cssH}px`;
    guidesHost.style.width = `${cssW}px`;
    guidesHost.style.height = `${cssH}px`;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const s = store.project.settings;
    ratioBtn.querySelector('.ratio-label').textContent = s.ratio === 'original' ? 'Original' : s.ratio === 'custom' ? `${s.width}x${s.height}` : s.ratio;
    clampPan();
    applyPan();
    fitBtn.querySelector('.zoom-label').textContent = zoom === 1 ? 'Fit' : `${Math.round(zoomPercent())}%`;
    stage.classList.toggle('zoomed', zoom > 1);
    stage.classList.toggle('with-rulers', opts.rulers);
    drawOverlay();
    renderGuides();
  }

  /** Displayed size relative to the project's pixel size, in percent. */
  function zoomPercent() {
    return (cssW / (store.project.settings.width || 1)) * 100;
  }

  function setZoomPercent(pct) {
    const fitW = cssW / zoom;
    zoom = clamp((pct / 100) * store.project.settings.width / Math.max(1, fitW), 0.1, 40);
    relayout();
    flashZoom();
  }

  function zoomBy(f, anchor = null) {
    const old = zoom;
    zoom = clamp(zoom * f, 0.1, 40);
    if (Math.abs(zoom - 1) < 0.04) zoom = 1;
    if (anchor) {
      // Keep the point under the pointer in place.
      const k = zoom / old;
      pan.x = anchor.x - (anchor.x - pan.x) * k;
      pan.y = anchor.y - (anchor.y - pan.y) * k;
    }
    relayout();
    flashZoom();
  }

  function zoomFit() {
    zoom = 1;
    pan.x = 0;
    pan.y = 0;
    relayout();
    flashZoom();
  }

  let badgeTimer = 0;
  function flashZoom() {
    zoomBadge.hidden = false;
    zoomBadge.textContent = `${Math.round(zoomPercent())}%`;
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => (zoomBadge.hidden = true), 900);
  }

  function clampPan() {
    const rect = stage.getBoundingClientRect();
    const mx = Math.max(0, (cssW - rect.width) / 2 + 48);
    const my = Math.max(0, (cssH - rect.height) / 2 + 48);
    pan.x = clamp(pan.x, -mx, mx);
    pan.y = clamp(pan.y, -my, my);
  }

  function applyPan() {
    const t = `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`;
    overlay.style.transform = t;
    decor.style.transform = t;
    guidesHost.style.transform = t;
    frame.style.transform = `translate(${pan.x}px, ${pan.y}px)`;
    drawRulers();
  }

  // --- Rulers and guides -----------------------------------------------
  const guides = () => store.project.guides || { v: [], h: [] };

  function frameOrigin() {
    const r = stage.getBoundingClientRect();
    return { x: (r.width - cssW) / 2 + pan.x, y: (r.height - cssH) / 2 + pan.y, sw: r.width, sh: r.height };
  }

  function drawRulers() {
    rulerTop.hidden = rulerLeft.hidden = rulerCorner.hidden = !opts.rulers;
    if (!opts.rulers || !cssW) return;
    const o = frameOrigin();
    const s = store.project.settings;
    const k = cssW / s.width; // css px per project px
    const dpr = globalThis.devicePixelRatio || 1;
    const color = getComputedStyle(el).getPropertyValue('--ruler').trim() || '#888';
    const text = getComputedStyle(el).getPropertyValue('--text-3').trim() || '#888';
    const step = rulerStep(k);
    for (const [c, horiz] of [[rulerTop, true], [rulerLeft, false]]) {
      const len = horiz ? o.sw : o.sh;
      c.width = Math.round(len * dpr);
      c.height = Math.round(RULER * dpr);
      c.style.width = `${len}px`;
      const g = c.getContext('2d');
      if (!g) continue;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, len, RULER);
      g.strokeStyle = color;
      g.fillStyle = text;
      g.font = '500 9px Inter, system-ui, sans-serif';
      g.lineWidth = 1;
      const origin = horiz ? o.x : o.y;
      const first = Math.floor(-origin / k / step) * step;
      for (let v = first; origin + v * k < len; v += step / 5) {
        const p = Math.round(origin + v * k) + 0.5;
        const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
        g.beginPath();
        g.moveTo(p, major ? 6 : 13);
        g.lineTo(p, RULER);
        g.stroke();
        if (major) g.fillText(String(Math.round(v)), p + 2, 8);
      }
      if (!horiz) {
        // The left ruler draws along its length; CSS rotates it into place.
        c.style.transform = 'rotate(90deg) translateY(-100%)';
      }
    }
  }

  function renderGuides() {
    const gd = guides();
    guidesLayer.hidden = !opts.guides;
    guidesLayer.replaceChildren(
      ...gd.v.map((v, i) => guideEl('v', v, i)),
      ...gd.h.map((v, i) => guideEl('h', v, i)),
    );
  }

  function guideEl(axis, v, index) {
    const g = h(`div.user-guide.${axis}`, { style: axis === 'v' ? { left: `${v * 100}%` } : { top: `${v * 100}%` }, title: 'Drag to move, drag off the frame to remove' });
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragGuide(e, axis, index);
    });
    g.addEventListener('dblclick', () => setGuides((gd) => gd[axis].splice(index, 1), 'Remove guide'));
    return g;
  }

  function setGuides(fn, label) {
    store.update(label, (p) => {
      p.guides = p.guides ? { v: [...p.guides.v], h: [...p.guides.h] } : { v: [], h: [] };
      fn(p.guides);
      if (!p.guides.v.length && !p.guides.h.length) delete p.guides;
    }, { structural: false });
  }

  function clearGuides() {
    setGuides((gd) => {
      gd.v.length = 0;
      gd.h.length = 0;
    }, 'Clear guides');
  }

  /** Drag a guide (index) or a new one out of a ruler (index = -1). */
  function dragGuide(e, axis, index) {
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    const preview = h(`div.user-guide.${axis}.dragging`);
    guidesLayer.append(preview);
    const at = (ev) => {
      const r = overlay.getBoundingClientRect();
      return axis === 'v' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
    };
    let v = at(e);
    const move = (ev) => {
      v = at(ev);
      // Guides snap to the center and thirds.
      for (const t of [0, 1 / 3, 0.5, 2 / 3, 1]) if (Math.abs(v - t) * (axis === 'v' ? cssW : cssH) < SNAP_PX) v = t;
      preview.style[axis === 'v' ? 'left' : 'top'] = `${v * 100}%`;
      preview.hidden = v < 0 || v > 1;
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      preview.remove();
      const inside = v >= 0 && v <= 1;
      if (index < 0 && inside) setGuides((gd) => gd[axis].push(Math.round(v * 10000) / 10000), 'Add guide');
      else if (index >= 0) setGuides((gd) => (inside ? (gd[axis][index] = Math.round(v * 10000) / 10000) : gd[axis].splice(index, 1)), inside ? 'Move guide' : 'Remove guide');
    };
    move(e);
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  rulerTop.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!opts.guides) setOpt('guides', true);
    dragGuide(e, 'h', -1);
  });
  rulerLeft.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!opts.guides) setOpt('guides', true);
    dragGuide(e, 'v', -1);
  });

  function showSnapLines(lines) {
    snapLayer.replaceChildren(...lines.map(({ axis, at }) => h(`div.guide.${axis}`, { style: axis === 'v' ? { left: `${at}px` } : { top: `${at}px` } })));
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  }

  const onFs = () => {
    const fs = document.fullscreenElement === el;
    fsBtn.replaceChildren(icon(fs ? 'exitFullscreen' : 'fullscreen', 18));
    fsBtn.setAttribute('aria-label', fs ? 'Exit full screen' : 'Full screen');
    requestAnimationFrame(relayout);
  };
  document.addEventListener('fullscreenchange', onFs);

  const ro = new ResizeObserver(() => relayout());
  ro.observe(stage);

  // Ctrl/Cmd + wheel (or a trackpad pinch) zooms around the pointer; the wheel pans a zoomed preview.
  stage.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomBy(Math.exp(-e.deltaY * 0.004), { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 });
      return;
    }
    if (zoom <= 1) return;
    e.preventDefault();
    pan.x -= e.shiftKey ? e.deltaY : e.deltaX;
    pan.y -= e.shiftKey ? 0 : e.deltaY;
    clampPan();
    applyPan();
    drawOverlay();
  }, { passive: false });
  // Middle-button drag pans.
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    const x0 = e.clientX - pan.x;
    const y0 = e.clientY - pan.y;
    stage.classList.add('panning');
    const move = (ev) => {
      pan.x = ev.clientX - x0;
      pan.y = ev.clientY - y0;
      clampPan();
      applyPan();
    };
    const up = () => {
      stage.classList.remove('panning');
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
  });

  function updateTime() {
    const fps = store.fps;
    cur.textContent = timecode(player.time, fps);
    total.textContent = timecode(store.duration, fps);
  }

  // --- Selection overlay -------------------------------------------------
  let box = null;
  // While the Mask panel is open, the selected clip shows its mask handles instead of the transform box.
  const maskOverlay = createMaskOverlay({ store, actions, stage });
  // While the Remove panel is open, it shows the object removal regions instead.
  const removalOverlay = createRemovalOverlay({ store, actions, stage });

  function selectedLayer() {
    const s = store.selected;
    if (!s || !('transform' in s.clip)) return null;
    const t = player.time;
    if (t < s.clip.start || t >= s.clip.start + s.clip.duration) return null;
    const layers = evaluate(store.project, t, { includeHidden: false });
    for (const l of layers) {
      if (l.kind === 'transition') {
        if (l.from.clip.id === s.clip.id) return l.from;
        if (l.to.clip.id === s.clip.id) return l.to;
      } else if (l.clip?.id === s.clip.id) return l;
    }
    return null;
  }

  function toCss(b) {
    const s = store.project.settings;
    const k = cssW / s.width;
    return { cx: b.cx * k, cy: b.cy * k, w: b.w * k, h: b.h * k };
  }

  function drawOverlay() {
    const layer = selectedLayer();
    if (!layer || player.playing || store.selected?.track.locked) {
      overlay.replaceChildren();
      box = null;
      return;
    }
    const b = player.boxFor(layer);
    if (!b) return;
    if (removalOverlay.active(layer)) {
      maskOverlay.clear();
      if (!overlay.contains(removalOverlay.el)) overlay.replaceChildren(removalOverlay.el);
      removalOverlay.draw(layer, b, cssW / store.project.settings.width, cssW, cssH);
      return;
    }
    removalOverlay.clear();
    if (maskOverlay.active(layer)) {
      if (!overlay.contains(maskOverlay.el)) overlay.replaceChildren(maskOverlay.el);
      maskOverlay.draw(layer, b, cssW / store.project.settings.width, cssW, cssH);
      return;
    }
    maskOverlay.clear();
    const c = toCss(b);
    if (!box) {
      box = h('div.tf-box', { 'aria-hidden': 'true' },
        ...['nw', 'ne', 'sw', 'se'].map((p) => h(`div.tf-handle.${p}`, { 'data-handle': p })),
        // Edge handles stretch one axis when uniform scale is off.
        ...['n', 'e', 's', 'w'].map((p) => h(`div.tf-handle.edge.${p}`, { 'data-handle': p })),
        h('div.tf-rotate', { 'data-handle': 'rotate' }, icon('rotate', 12)),
      );
    }
    box.classList.toggle('stretch', layer.clip.transform?.uniform === false);
    if (!overlay.contains(box)) overlay.replaceChildren(box);
    box.style.width = `${Math.max(4, Math.abs(c.w))}px`;
    box.style.height = `${Math.max(4, Math.abs(c.h))}px`;
    box.style.transform = `translate(${c.cx - Math.abs(c.w) / 2}px, ${c.cy - Math.abs(c.h) / 2}px) rotate(${layer.rotation}deg)`;
    box.classList.toggle('text', layer.kind === 'text');
  }

  /** Positions (project px) the moving clip can snap to. */
  function snapTargets(movingId) {
    const s = store.project.settings;
    const x = [];
    const y = [];
    if (opts.snap) {
      x.push(0, s.width / 2, s.width);
      y.push(0, s.height / 2, s.height);
      if (opts.guides) {
        for (const v of guides().v) x.push(v * s.width);
        for (const v of guides().h) y.push(v * s.height);
      }
      for (const l of evaluate(store.project, player.time).flatMap((q) => (q.kind === 'transition' ? [q.from, q.to] : [q]))) {
        if (!['media', 'text', 'sticker', 'avatar'].includes(l.kind) || l.clip.id === movingId) continue;
        const b = player.boxFor(l);
        if (!b) continue;
        const a = (l.rotation * Math.PI) / 180;
        const hw = (Math.abs(b.w * Math.cos(a)) + Math.abs(b.h * Math.sin(a))) / 2;
        const hh = (Math.abs(b.w * Math.sin(a)) + Math.abs(b.h * Math.cos(a))) / 2;
        x.push(b.cx - hw, b.cx, b.cx + hw);
        y.push(b.cy - hh, b.cy, b.cy + hh);
      }
    } else {
      // Even with snapping off, the center lines still catch the clip center.
      x.push(s.width / 2);
      y.push(s.height / 2);
    }
    return { x, y };
  }

  /** Topmost visual clip under a point (CSS px in the frame). */
  function hitTest(x, y) {
    const s = store.project.settings;
    const k = s.width / cssW;
    const px = x * k;
    const py = y * k;
    const layers = evaluate(store.project, player.time).flatMap((l) => (l.kind === 'transition' ? [l.from, l.to] : [l]));
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (!['media', 'text', 'sticker', 'avatar'].includes(l.kind) || l.opacity <= 0.01) continue;
      const b = player.boxFor(l);
      if (!b) continue;
      const a = (-l.rotation * Math.PI) / 180;
      const dx = px - b.cx;
      const dy = py - b.cy;
      const rx = dx * Math.cos(a) - dy * Math.sin(a);
      const ry = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(rx) <= Math.abs(b.w) / 2 && Math.abs(ry) <= Math.abs(b.h) / 2) {
        const track = store.project.tracks[l.trackIndex];
        if (track?.locked) continue;
        return l;
      }
    }
    return null;
  }

  // Two-finger pinch scales the selected clip. It runs in the capture phase
  // so the second finger never starts a move of its own.
  let pinchEdit = null;
  const pinch = createPinch({
    onStart: () => {
      const layer = selectedLayer();
      if (!layer) return;
      player.pause();
      const base = layer.clip.transform;
      pinchEdit = { id: layer.clip.id, scale: layer.scale, scaleK: layer.scale / (base.scale || 1), coalesce: `pinch:${layer.clip.id}:${Date.now()}` };
    },
    onChange: (step, total) => {
      if (!pinchEdit) return;
      const sc = Math.max(0.02, pinchEdit.scale * total);
      actions.setTransform(pinchEdit.id, { scale: sc / pinchEdit.scaleK }, { coalesce: pinchEdit.coalesce, label: 'Scale' });
    },
    onEnd: () => {
      if (pinchEdit) store.seal();
      pinchEdit = null;
    },
  });
  overlay.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' && pinch.down(e)) e.stopImmediatePropagation();
  }, true);
  overlay.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') pinch.move(e);
  });
  const pinchUp = (e) => {
    if (e.pointerType === 'touch') pinch.up(e);
  };
  overlay.addEventListener('pointerup', pinchUp);
  overlay.addEventListener('pointercancel', pinchUp);

  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    stage.focus({ preventScroll: true });
    const r = overlay.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const handle = e.target.closest('[data-handle]')?.dataset.handle;
    let layer = selectedLayer();
    if (!handle) {
      const hit = hitTest(x, y);
      if (!hit) {
        store.clearSelection();
        return;
      }
      // Inside a compound clip: select the compound, which moves as a whole from its own controls.
      if (hit.clip.parent) {
        store.select(rootClip(hit.clip).id);
        return;
      }
      if (hit.clip.id !== store.selected?.clip.id) {
        store.select(hit.clip.id);
        layer = hit;
      }
    }
    if (!layer) return;
    player.pause();
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    const s = store.project.settings;
    const k = s.width / cssW;
    const id = layer.clip.id;
    const start = { x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation, sx: layer.sx ?? 1, sy: layer.sy ?? 1 };
    const b = player.boxFor(layer);
    const c = toCss(b);
    const center = { x: c.cx, y: c.cy };
    const startDist = Math.hypot(x - center.x, y - center.y) || 1;
    const startAngle = Math.atan2(y - center.y, x - center.x);
    // The base (keyframe-free) values that the player shows include animations; edit relative to the keyed value.
    const clip = store.selected.clip;
    const base = clip.transform;
    const off = { x: start.x - base.x, y: start.y - base.y, scaleK: start.scale / (base.scale || 1), rotation: start.rotation - base.rotation };
    const coalesce = `tf:${id}:${Date.now()}`;
    const targets = snapTargets(id);
    // Half extents of the moving box in project px, from the css box.
    const aabb = (w, hh, rot) => {
      const a = (rot * Math.PI) / 180;
      return { w: ((Math.abs(w * Math.cos(a)) + Math.abs(hh * Math.sin(a))) / 2) * k, h: ((Math.abs(w * Math.sin(a)) + Math.abs(hh * Math.cos(a))) / 2) * k };
    };
    let pinched = false; // after a pinch the remaining finger does not move the clip
    const move = (ev) => {
      if (ev.pointerId !== e.pointerId || pinched || (pinched = pinch.active)) return;
      const mx = ev.clientX - r.left;
      const my = ev.clientY - r.top;
      if (!handle) {
        let nx = start.x + ((mx - x) * k) / s.width;
        let ny = start.y + ((my - y) * k) / s.height;
        // Snap the clip's edges and center to the frame, the guides and other clips.
        const lines = [];
        if (!ev.altKey) {
          const half = aabb(c.w, c.h, start.rotation);
          const cx = s.width / 2 + nx * s.width;
          const cy = s.height / 2 + ny * s.height;
          const tol = SNAP_PX * k;
          const sx = snapAxis([cx - half.w, cx, cx + half.w], targets.x, tol);
          const sy = snapAxis([cy - half.h, cy, cy + half.h], targets.y, tol);
          if (sx) {
            nx += sx.delta / s.width;
            lines.push({ axis: 'v', at: sx.at / k });
          }
          if (sy) {
            ny += sy.delta / s.height;
            lines.push({ axis: 'h', at: sy.at / k });
          }
        }
        showSnapLines(lines);
        actions.setTransform(id, { x: nx - off.x, y: ny - off.y }, { coalesce, label: 'Move' });
      } else if (handle === 'rotate') {
        let ang = start.rotation + ((Math.atan2(my - center.y, mx - center.x) - startAngle) * 180) / Math.PI;
        if (ev.shiftKey) ang = Math.round(ang / 15) * 15;
        else {
          const near = Math.round(ang / 90) * 90;
          if (Math.abs(ang - near) < 3) ang = near;
        }
        actions.setTransform(id, { rotation: ang - off.rotation }, { coalesce, label: 'Rotate' });
      } else if (handle.length === 1) {
        // Edge handle: stretch along the box's own axis.
        const prop = handle === 'e' || handle === 'w' ? 'sx' : 'sy';
        const a = (start.rotation * Math.PI) / 180;
        const axis = prop === 'sx' ? [Math.cos(a), Math.sin(a)] : [-Math.sin(a), Math.cos(a)];
        const proj0 = (x - center.x) * axis[0] + (y - center.y) * axis[1] || 1;
        const proj = (mx - center.x) * axis[0] + (my - center.y) * axis[1];
        const v = Math.max(0.02, (start[prop] * proj) / proj0);
        actions.setTransform(id, { [prop]: Math.round(v * 10000) / 10000 }, { coalesce, label: 'Stretch' });
      } else {
        const d = Math.hypot(mx - center.x, my - center.y);
        const sc = Math.max(0.02, (start.scale * d) / startDist);
        actions.setTransform(id, { scale: sc / off.scaleK }, { coalesce, label: 'Scale' });
      }
    };
    const up = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      showSnapLines([]);
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', up);
      overlay.removeEventListener('pointercancel', up);
      store.seal();
    };
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
    overlay.addEventListener('pointercancel', up);
  });

  overlay.addEventListener('dblclick', (e) => {
    const s = store.selected;
    if (s?.clip.type === 'text') {
      e.preventDefault();
      ctx.inspector?.focusText?.();
    }
  });

  stage.addEventListener('keydown', (e) => {
    const s = store.selected;
    if (!s || !('transform' in s.clip)) return;
    const stepPx = e.shiftKey ? 10 : 1;
    const set = store.project.settings;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const t = s.clip.transform;
    actions.setTransform(s.clip.id, { x: t.x + (d[0] * stepPx) / set.width, y: t.y + (d[1] * stepPx) / set.height }, { coalesce: `nudge:${s.clip.id}`, label: 'Move' });
  });

  // Drop assets from the panel onto the preview: add at the playhead.
  stage.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].some((t) => t === 'application/x-video-studio' || t === 'Files')) e.preventDefault();
  });
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files?.length) {
      actions.importFiles([...e.dataTransfer.files], { addToTimeline: true });
      return;
    }
    ctx.timeline?.dropPayload?.(e.dataTransfer.getData('application/x-video-studio'), { start: store.time });
  });

  const onPlay = ({ playing }) => {
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 20));
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    playBtn.setAttribute('data-tip', playing ? 'Pause' : 'Play');
    drawOverlay();
  };
  let rafPending = 0;
  const onFrame = () => {
    if (rafPending) return;
    rafPending = requestAnimationFrame(() => {
      rafPending = 0;
      updateTime();
      if (!player.playing) drawOverlay();
    });
  };
  const offs = [
    player.on('proxy', syncProxyBtn),
    ...(ctx.proxies ? [ctx.proxies.on('change', syncProxyBtn)] : []),
    store.on('change', syncProxyBtn),
    player.on('play', onPlay),
    player.on('frame', onFrame),
    store.on('select', drawOverlay),
    maskEdit.on('change', drawOverlay),
    removeEdit.on('change', drawOverlay),
    store.on('change', () => {
      updateTime();
      relayout();
      renderTimelineName();
    }),
  ];
  updateTime();

  return {
    el,
    relayout,
    zoomFit,
    zoomIn: () => zoomBy(1.25),
    zoomOut: () => zoomBy(1 / 1.25),
    toggleRulers: () => setOpt('rulers', !opts.rulers),
    toggleGuides: () => setOpt('guides', !opts.guides),
    setRatio,
    toggleFullscreen,
    mounted: () => requestAnimationFrame(relayout),
    dispose() {
      offs.forEach((f) => f());
      maskOverlay.dispose();
      removalOverlay.dispose();
      ro.disconnect();
      document.removeEventListener('fullscreenchange', onFs);
    },
  };
}

export { US };
