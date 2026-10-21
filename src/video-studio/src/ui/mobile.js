/**
 * Phone and tablet chrome for the editor.
 *
 * Phone: the assets panel moves into a bottom sheet
 * opened from a bottom toolbar of categories; selecting a clip swaps that
 * toolbar for a clip toolbar (split, delete, speed, volume, ...); the details
 * panel opens in a bottom sheet; the timeline keeps its playhead centered.
 * Tablet: the details panel becomes a side sheet toggled from the title bar,
 * and timeline tools that do not fit go into a More menu.
 * Desktop: nothing changes.
 *
 * The layout mode is set as data-layout on the editor root; CSS in
 * responsive.css does the rest.
 */
import { h, announce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { RATIOS } from '../model/project.js';
import { ANIMATIONS } from '../model/catalog.js';
import * as T from '../model/timeline.js';
import { createSheet } from './sheet.js';
import { showMenu } from './menu.js';
import { sliderField, segmented } from './controls.js';
import { ASSET_TABS } from './panels/index.js';

export const PHONE_QUERY = '(max-width: 719.98px), (max-height: 519.98px) and (max-width: 1099.98px) and (pointer: coarse)';
export const TABLET_QUERY = '(max-width: 1099.98px), (max-width: 1279.98px) and (pointer: coarse)';

/** 'phone' | 'tablet' | 'desktop' for a matcher (query -> boolean). */
export function layoutMode(matches) {
  if (matches(PHONE_QUERY)) return 'phone';
  if (matches(TABLET_QUERY)) return 'tablet';
  return 'desktop';
}

export const CATEGORIES = [
  { id: 'edit', label: 'Edit', icon: 'scissors' },
  { id: 'media', label: 'Media', icon: 'plus' },
  { id: 'audio', label: 'Audio', icon: 'music' },
  { id: 'text', label: 'Text', icon: 'text' },
  { id: 'captions', label: 'Captions', icon: 'captions' },
  { id: 'avatars', label: 'Avatars', icon: 'avatar' },
  { id: 'stickers', label: 'Graphics', icon: 'sticker' },
  { id: 'transitions', label: 'Transitions', icon: 'transition' },
  { id: 'effects', label: 'Effects', icon: 'effects' },
  { id: 'filters', label: 'Filters', icon: 'filters' },
  { id: 'adjust', label: 'Color', icon: 'adjust' },
  { id: 'ratio', label: 'Ratio', icon: 'ratio' },
];

const isTimed = (c) => c.type === 'video' || c.type === 'audio';
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 3, 5];

/** A toolbar of large icon-over-label buttons with arrow-key navigation. */
function toolButton({ label, icon: name }, onClick) {
  const b = h('button.m-tool', { type: 'button' }, icon(name, 22), h('span.m-tool-label', label));
  b.addEventListener('click', onClick);
  return b;
}

function arrowNav(bar) {
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const btns = [...bar.querySelectorAll('button')].filter((b) => !b.hidden && !b.disabled);
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length;
    btns[j].focus();
    btns[j].scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });
}

/**
 * createMobileChrome(ctx, root, { matchMedia })
 * root is the editor element. Returns { mode, setMode(forced|null), openAssets(id), openDetails(), dispose() }.
 */
export function createMobileChrome(ctx, root, { matchMedia: mmImpl } = {}) {
  const { store, actions } = ctx;
  const mm = mmImpl || ((q) => window.matchMedia(q));
  const mqls = [mm(PHONE_QUERY), mm(TABLET_QUERY)];
  let forced = null;
  let mode = null;

  // Where the panels live on desktop, so they can go back.
  const assetsEl = ctx.assets.el;
  const inspEl = ctx.inspector.el;
  const assetsHome = document.createComment('assets panel');
  const inspHome = document.createComment('details panel');
  assetsEl.before(assetsHome);
  inspEl.before(inspHome);

  // ---- Sheets ---------------------------------------------------------------
  const assetsSheet = createSheet({ title: 'Media', host: root, className: 'assets-sheet' });
  const detailsSheet = createSheet({
    title: 'Details',
    host: root,
    className: 'details-sheet',
    onOpen: () => detailsBtn.setAttribute('aria-expanded', 'true'),
    onClose: () => detailsBtn.setAttribute('aria-expanded', 'false'),
  });
  const toolSheet = createSheet({ title: '', host: root, className: 'tool-sheet' });

  function openAssets(id, opener) {
    const def = ASSET_TABS.find((t) => t.id === id);
    if (!def) return;
    ctx.assets.show(id);
    assetsSheet.setTitle(def.label);
    if (mode !== 'phone') return;
    assetsSheet.open(opener);
  }

  function openDetails(opener) {
    detailsSheet.open(opener);
  }

  // ---- Phone: bottom toolbar ------------------------------------------------
  const mainBar = h('div.m-toolbar', { role: 'toolbar', 'aria-label': 'Editing tools' });
  for (const c of CATEGORIES) {
    const b = toolButton(c, () => {
      if (c.id === 'edit') editAtPlayhead();
      else if (c.id === 'ratio') ratioMenu(b);
      else openAssets(c.id, b);
    });
    b.dataset.cat = c.id;
    if (c.id === 'ratio') {
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-label', 'Aspect ratio');
    }
    mainBar.append(b);
  }
  arrowNav(mainBar);

  function editAtPlayhead() {
    const main = store.project.tracks.find((t) => t.main);
    const t = store.time;
    const clip = main?.clips.find((c) => t >= c.start && t < c.start + c.duration) || main?.clips[0] || T.allClips(store.project)[0];
    if (!clip) {
      announce('Add media to start editing');
      openAssets('media', mainBar.querySelector('[data-cat="media"]'));
      return;
    }
    store.select(clip.id);
    announce(`${T.clipLabel(store.project, clip)} selected`);
  }

  function ratioMenu(anchor) {
    const cur = store.project.settings.ratio;
    const set = (id) => ctx.playerView.setRatio?.(id);
    showMenu(anchor, [
      { heading: 'Aspect ratio' },
      { label: 'Original', checked: cur === 'original', radio: true, onSelect: () => set('original') },
      ...RATIOS.map((r) => ({ label: `${r.label}  ${r.hint}`, checked: cur === r.id, radio: true, onSelect: () => set(r.id) })),
      'separator',
      { label: 'Project settings...', icon: 'settings', onSelect: () => ctx.openProjectSettings?.() },
    ], { label: 'Aspect ratio', side: 'top' });
  }

  // ---- Phone: clip toolbar ---------------------------------------------------
  const clipTools = [
    { id: 'split', label: 'Split', icon: 'split', run: () => actions.split() },
    { id: 'delete', label: 'Delete', icon: 'trash', run: () => actions.deleteSelected() },
    { id: 'speed', label: 'Speed', icon: 'speed', when: (c) => isTimed(c), run: (b) => openSpeed(b) },
    { id: 'volume', label: 'Volume', icon: 'volume', when: (c) => isTimed(c), run: (b) => openVolume(b) },
    { id: 'animation', label: 'Animation', icon: 'magic', when: (c) => 'animIn' in c, run: (b) => openAnimation(b) },
    { id: 'duplicate', label: 'Duplicate', icon: 'copy', run: () => actions.duplicate() },
    { id: 'freeze', label: 'Freeze', icon: 'freeze', when: (c) => c.type === 'video', run: () => actions.freeze() },
    { id: 'mirror', label: 'Mirror', icon: 'flipH', when: (c) => 'transform' in c, run: () => actions.mirror() },
    { id: 'cutout', label: 'Remove BG', icon: 'cutout', when: (c) => c.type === 'video' || c.type === 'image', run: (b) => {
      if (!store.selected?.clip.cutout) actions.removeBackground();
      openDetails(b);
      ctx.inspector?.showVideoSub?.('cutout');
    } },
    { id: 'remove', label: 'Remove', icon: 'eraser', when: (c) => c.type === 'video' || c.type === 'image', run: (b) => {
      openDetails(b);
      ctx.inspector?.showVideoSub?.('remove');
    } },
    { id: 'retouch', label: 'Retouch', icon: 'retouch', when: (c) => c.type === 'video' || c.type === 'image', run: (b) => {
      openDetails(b);
      ctx.inspector?.showVideoSub?.('retouch');
    } },
    { id: 'extract', label: 'Detach audio', icon: 'detachAudio', when: (c) => c.type === 'video' && store.project.assets[c.assetId]?.hasAudio && !c.audioDetached, run: () => actions.detachAudio() },
    { id: 'details', label: 'Edit details', icon: 'pencil', run: (b) => openDetails(b) },
  ];
  const backBtn = h('button.m-tool.m-back', { type: 'button', 'aria-label': 'Done, back to all tools' }, icon('chevronLeft', 22), h('span.m-tool-label', 'Done'));
  backBtn.addEventListener('click', () => store.clearSelection());
  const clipBar = h('div.m-toolbar.m-clipbar', { role: 'toolbar', 'aria-label': 'Clip tools', hidden: true }, backBtn);
  for (const t of clipTools) {
    t.btn = toolButton(t, () => t.run(t.btn));
    t.btn.dataset.tool = t.id;
    clipBar.append(t.btn);
  }
  arrowNav(clipBar);
  const dock = h('div.m-dock', { hidden: true }, mainBar, clipBar);

  function syncBars() {
    const sel = mode === 'phone' ? store.selected : null;
    const had = dock.contains(document.activeElement) ? document.activeElement : null;
    const showClip = Boolean(sel);
    const changed = clipBar.hidden === showClip;
    mainBar.hidden = showClip;
    clipBar.hidden = !showClip;
    if (sel) for (const t of clipTools) t.btn.hidden = t.when ? !t.when(sel.clip) : false;
    // Keep keyboard focus in the dock when its bar swaps under it.
    if (had && changed) (showClip ? backBtn : mainBar.querySelector('[data-cat="edit"]'))?.focus({ preventScroll: true });
    if (!sel && toolSheet.isOpen) toolSheet.close();
  }

  // ---- Clip quick panels (speed, volume, animation) ------------------------
  function openTool(title, content, opener) {
    toolSheet.setTitle(title);
    toolSheet.setContent(content);
    toolSheet.open(opener);
  }

  function openSpeed(opener) {
    const c = store.selected?.clip;
    if (!c) return;
    const id = c.id;
    const slider = sliderField({ label: 'Speed', min: 0.1, max: 10, step: 0.05, value: c.speed || 1, onInput: (v) => {
      actions.setSpeed(id, v);
      seg.set(v);
    } });
    // The box takes any speed the clip allows, past the slider's 10x.
    slider.setLimits(0.1, 100);
    const seg = segmented({ label: 'Speed presets', className: 'm-speed-presets', options: SPEEDS.map((v) => ({ value: v, label: `${v}x` })), value: c.speed || 1, onChange: (v) => {
      actions.setSpeed(id, v);
      slider.set(v);
      announce(`Speed ${v}x`);
    } });
    openTool('Speed', h('div.m-panel', seg.el, slider.el), opener);
  }

  function openVolume(opener) {
    const c = store.selected?.clip;
    if (!c) return;
    const id = c.id;
    const slider = sliderField({ label: 'Volume', min: 0, max: 200, step: 1, value: Math.round((c.volume ?? 1) * 100), unit: '%', onInput: (v) => {
      actions.setAnimatable(id, 'volume', v / 100, { label: 'Volume', coalesce: `vol:${id}` });
    } });
    slider.setLimits(0, 1000);
    const mute = h('button.btn.m-mute', { type: 'button', 'aria-pressed': String(Boolean(c.muted)) }, icon(c.muted ? 'mute' : 'volume', 16), h('span', c.muted ? 'Unmute clip' : 'Mute clip'));
    mute.addEventListener('click', () => {
      actions.toggleClipMute(id);
      const m = Boolean(T.findClip(store.project, id)?.clip.muted);
      mute.setAttribute('aria-pressed', String(m));
      mute.replaceChildren(icon(m ? 'mute' : 'volume', 16), h('span', m ? 'Unmute clip' : 'Mute clip'));
      announce(m ? 'Clip muted' : 'Clip unmuted');
    });
    openTool('Volume', h('div.m-panel', slider.el, mute), opener);
  }

  function openAnimation(opener) {
    const c = store.selected?.clip;
    if (!c) return;
    let kind = c.animLoop ? 'loop' : c.animOut && !c.animIn ? 'out' : 'in';
    const list = h('div.m-anim-grid', { role: 'group', 'aria-label': 'Animations' });
    const render = () => {
      const clip = T.findClip(store.project, c.id)?.clip;
      if (!clip) return;
      const key = kind === 'in' ? 'animIn' : kind === 'out' ? 'animOut' : 'animLoop';
      const cur = clip[key]?.id || null;
      const items = [{ id: null, label: 'None' }, ...ANIMATIONS[kind].filter((a) => !a.textOnly || clip.type === 'text')];
      list.replaceChildren(...items.map((a) => {
        const b = h('button.m-chip', { type: 'button', 'aria-pressed': String(a.id === cur) }, a.label);
        b.addEventListener('click', () => {
          actions.applyAnimation(kind, a.id);
          render();
          list.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
        });
        return b;
      }));
    };
    const seg = segmented({ label: 'Animation type', options: [{ value: 'in', label: 'In' }, { value: 'out', label: 'Out' }, { value: 'loop', label: 'Loop' }], value: kind, onChange: (v) => {
      kind = v;
      render();
    } });
    render();
    openTool('Animation', h('div.m-panel', seg.el, list), opener);
  }

  // ---- Injected controls -----------------------------------------------------
  const closeBtn = h('button.icon-btn.m-close', { type: 'button', 'aria-label': 'Back to projects', 'data-tip': 'Back to projects' }, icon('close', 20));
  closeBtn.addEventListener('click', () => ctx.exitToHome());
  const undoBtn = h('button.icon-btn.m-undo', { type: 'button', 'aria-label': 'Undo' }, icon('undo', 20));
  const redoBtn = h('button.icon-btn.m-redo', { type: 'button', 'aria-label': 'Redo' }, icon('redo', 20));
  undoBtn.addEventListener('click', () => ctx.commands.run('undo'));
  redoBtn.addEventListener('click', () => ctx.commands.run('redo'));
  const syncHistory = () => {
    undoBtn.disabled = !store.history?.canUndo?.();
    redoBtn.disabled = !store.history?.canRedo?.();
  };
  const detailsBtn = h('button.icon-btn.m-details-btn', { type: 'button', 'aria-label': 'Details panel', 'aria-expanded': 'false', 'aria-controls': detailsSheet.el.id, 'data-tip': 'Details' }, icon('panelRight', 18));
  detailsBtn.addEventListener('click', () => (detailsSheet.isOpen ? detailsSheet.close() : openDetails(detailsBtn)));
  const moreBtn = h('button.icon-btn.m-more', { type: 'button', 'aria-label': 'More timeline tools', 'data-tip': 'More', 'aria-haspopup': 'menu' }, icon('more', 18));
  moreBtn.addEventListener('click', () => moreMenu());

  /** Menu of the timeline toolbar buttons that the current layout hides. */
  function moreMenu() {
    const toolbar = ctx.timeline.el.querySelector('.tl-toolbar');
    const hiddenBtns = [...(toolbar?.querySelectorAll('button[data-cmd]') || [])].filter((b) => b.getClientRects().length === 0);
    const items = hiddenBtns.map((b) => {
      const cmd = ctx.commands.get(b.dataset.cmd);
      if (!cmd) return null;
      return {
        label: cmd.label,
        icon: b.dataset.icon,
        shortcut: cmd.keys[0],
        disabled: b.disabled,
        checked: cmd.checked ? cmd.checked() : undefined,
        onSelect: () => ctx.commands.run(cmd.id),
      };
    }).filter(Boolean);
    if (!items.length) items.push({ label: 'All tools are visible', disabled: true });
    showMenu(moreBtn, items, { align: 'end', label: 'More timeline tools' });
  }

  function place(node, parent, where = 'append') {
    if (!parent) return;
    if (where === 'prepend') parent.prepend(node);
    else parent.append(node);
  }

  function setTabTips(on) {
    for (const tab of assetsEl.querySelectorAll('.tab')) {
      if (on) tab.setAttribute('data-tip', tab.textContent.trim());
      else tab.removeAttribute('data-tip');
    }
  }

  // ---- Mode switching ---------------------------------------------------------
  function apply(next) {
    if (next === mode) return;
    mode = next;
    root.dataset.layout = next;
    assetsSheet.close();
    detailsSheet.close();
    toolSheet.close();

    if (next === 'phone') assetsSheet.body.append(assetsEl);
    else if (assetsEl.parentNode !== assetsHome.parentNode || assetsEl.previousSibling !== assetsHome) assetsHome.after(assetsEl);
    if (next === 'desktop') inspHome.after(inspEl);
    else detailsSheet.body.append(inspEl);
    detailsSheet.setSide(next === 'tablet' ? 'end' : 'bottom');

    const topLeft = root.querySelector('.topbar-left');
    const topRight = root.querySelector('.topbar-right');
    const barRight = ctx.playerView.el.querySelector('.player-bar-right');
    const tlTools = ctx.timeline.el.querySelector('.tl-tools.right');
    for (const n of [closeBtn, undoBtn, redoBtn, detailsBtn, moreBtn]) n.remove();
    if (next === 'phone') {
      place(closeBtn, topLeft, 'prepend');
      place(redoBtn, barRight, 'prepend');
      place(undoBtn, barRight, 'prepend');
    } else if (next === 'tablet') {
      place(detailsBtn, topRight, 'prepend');
      place(moreBtn, tlTools);
    }
    if (dock.parentNode !== root) root.append(dock);
    dock.hidden = next !== 'phone';
    setTabTips(next === 'tablet');
    ctx.timeline.setCentered?.(next === 'phone');
    syncBars();
    syncHistory();
    ctx.assistant?.relayout?.();
    requestAnimationFrame(() => ctx.playerView.relayout?.());
  }

  function update() {
    apply(forced || layoutMode((q) => (q === PHONE_QUERY ? mqls[0] : mqls[1]).matches));
  }
  for (const q of mqls) q.addEventListener?.('change', update);

  const offs = [
    store.on('select', syncBars),
    store.on('change', () => {
      syncBars();
      syncHistory();
    }),
  ];
  update();

  return {
    get mode() {
      return mode;
    },
    /** Force a layout ('phone' | 'tablet' | 'desktop'), or null to follow the screen. */
    setMode(m) {
      forced = m || null;
      update();
    },
    openAssets,
    openDetails,
    sheets: { assets: assetsSheet, details: detailsSheet, tool: toolSheet },
    dispose() {
      for (const q of mqls) q.removeEventListener?.('change', update);
      offs.forEach((f) => f?.());
      assetsSheet.dispose();
      detailsSheet.dispose();
      toolSheet.dispose();
      dock.remove();
    },
  };
}
