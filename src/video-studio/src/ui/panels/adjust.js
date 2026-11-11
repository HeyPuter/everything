/**
 * Color tab: color layers (grade every clip below them), imported LUTs and
 * saved color presets. With a video, image or color layer clip selected,
 * clicking a LUT or preset applies it to that clip; otherwise (or when
 * dragged onto the timeline) it adds a color layer carrying it.
 */
import '../../styles/color.css';
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { getLut, loadLut, dropLut } from '../../engine/luts.js';
import { tabLayout, tileGrid, tile, emptyState } from './common.js';
import { gradePreview } from './previews.js';
import { isGradable, chooseLutFiles, applyLut, colorPresets, onPresetsChanged, applyPreset, removePreset } from '../color-tools.js';
import { confirmDialog, toast } from '../dialog.js';

const CATEGORIES = [
  { id: 'layer', label: 'Color layer' },
  { id: 'luts', label: 'LUTs' },
  { id: 'presets', label: 'Your presets' },
];

/**
 * Preview that fills in once the LUTs it uses are loaded. Drawn once per
 * look (cache: look -> canvas): the grid is redrawn on every selection, and
 * rendering each tile again took tens of milliseconds per tile.
 */
function setupPreview(ctx, setup, cache) {
  const key = JSON.stringify([setup.adjust || null, setup.grade || null]);
  const hit = cache?.get(key);
  if (hit) {
    const copy = h('canvas.tile-canvas', { width: hit.width, height: hit.height, 'aria-hidden': 'true' });
    copy.getContext('2d')?.drawImage(hit, 0, 0);
    return copy;
  }
  const canvas = gradePreview(setup);
  const id = setup.grade?.lut?.id;
  // A LUT still loading: kept once it has been drawn with it.
  if (id && !getLut(id)) {
    loadLut(id, ctx.library).then((got) => {
      if (!got) return;
      gradePreview(setup, canvas);
      cache?.set(key, canvas);
    });
  } else cache?.set(key, canvas);
  return canvas;
}

/** A tile with a small remove button beside it (a button cannot hold another). */
function removable(tileEl, label, onRemove) {
  const del = h('button.icon-btn.small.tile-remove', { type: 'button', 'aria-label': `Remove ${label}`, 'data-tip': 'Remove' }, icon('trash', 13));
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    onRemove();
  });
  return h('div.tile-wrap', tileEl, del);
}

export function adjustTab(ctx) {
  const { store, actions, library } = ctx;
  const target = () => {
    const s = store.selected;
    return s && isGradable(s.clip) ? s.clip : null;
  };
  let luts = [];
  const previews = new Map();
  const hint = h('p.asset-hint', { role: 'status' });
  const importBtn = () => {
    const b = h('button.btn.small', { type: 'button' }, icon('import', 14), 'Import .cube');
    b.addEventListener('click', async () => {
      const made = await chooseLutFiles(ctx);
      const clip = target();
      if (made[0] && clip) applyLut(ctx, clip.id, made[0]);
      layout.refresh();
    });
    return b;
  };

  /** Redraw the tiles, keeping keyboard focus on the same tile. */
  const redraw = () => {
    const had = layout.el.contains(document.activeElement) ? document.activeElement : null;
    layout.refresh();
    if (had && !had.isConnected) (layout.el.querySelector(`.tile[aria-label="${CSS.escape(had.getAttribute('aria-label') || '')}"]`) || layout.el.querySelector('.tile'))?.focus();
  };

  /** Apply to the selected clip, or add a color layer at the playhead. */
  const use = (name, setup, applyToClip) => {
    const clip = target();
    if (clip) applyToClip(clip);
    else actions.addAdjustment({ name, adjust: setup.adjust, grade: setup.grade });
    redraw();
  };
  let shownLut = null; // the selected clip's LUT the tiles show

  function renderLayer() {
    const t = tile({
      label: 'Custom color layer',
      preview: setupPreview(ctx, {}, previews),
      onAdd: () => actions.addAdjustment(),
      drag: { kind: 'adjust' },
      addLabel: 'Add color layer',
    });
    return h('div',
      h('p.asset-hint', 'A color layer grades every clip below it. Fine-tune it in Details. To grade a single clip, select it and open Color in Details.'),
      tileGrid([t], { label: 'Color layers' }),
    );
  }

  function renderLuts(q) {
    const clip = target();
    shownLut = clip?.grade?.lut?.id ?? null;
    const list = luts.filter((e) => !q || e.name.toLowerCase().includes(q));
    if (!luts.length) {
      return emptyState('palette', 'No LUTs yet', 'Import .cube look-up tables (1D or 3D) from your grading tools or camera maker. They are kept in your library for every project.', importBtn());
    }
    hint.textContent = clip ? 'Click a LUT to apply it to the selected clip.' : 'Click a LUT to add it as a color layer, or select a clip first to apply it to that clip.';
    const tiles = list.map((e) => {
      const setup = { grade: { lut: { id: e.id, name: e.name, intensity: 100 } } };
      return removable(tile({
        label: e.name,
        sub: `${e.kind.toUpperCase()} ${e.size}`,
        preview: setupPreview(ctx, setup, previews),
        active: clip?.grade?.lut?.id === e.id,
        onAdd: () => use(e.name, setup, (c) => applyLut(ctx, c.id, e)),
        drag: { kind: 'adjust', name: e.name, grade: setup.grade },
        addLabel: clip ? `Apply LUT ${e.name} to clip` : `Add LUT ${e.name} as a color layer`,
      }), `LUT ${e.name}`, async () => {
        const ok = await confirmDialog({ title: 'Remove LUT', message: `Remove "${e.name}" from your library? Clips that use it will no longer show it.`, confirm: 'Remove', danger: true });
        if (!ok) return;
        try {
          await library.removeLut(e.id);
        } catch (err) {
          toast(`Couldn't remove the LUT ${e.name}. ${err?.message || 'Try again.'}`, { kind: 'error' });
          return;
        }
        dropLut(e.id);
        announce('LUT removed');
      });
    });
    return h('div', h('div.asset-row', hint, importBtn()), list.length ? tileGrid(tiles, { label: 'LUTs' }) : emptyState('search', 'No LUTs found', 'Try another word.'));
  }

  function renderPresets(q) {
    const clip = target();
    const all = colorPresets();
    if (!all.length) return emptyState('bookmark', 'No presets yet', 'Grade a clip, then choose "Save as preset" in Details > Color > Basic to reuse the look here.');
    const list = all.filter((p) => !q || p.name.toLowerCase().includes(q));
    hint.textContent = clip ? 'Click a preset to apply it to the selected clip.' : 'Click a preset to add it as a color layer, or select a clip first to apply it to that clip.';
    const tiles = list.map((p) => removable(tile({
      label: p.name,
      preview: setupPreview(ctx, p, previews),
      onAdd: () => use(p.name, p, (c) => applyPreset(ctx, c.id, p)),
      drag: { kind: 'adjust', name: p.name, adjust: p.adjust, grade: p.grade },
      addLabel: clip ? `Apply preset ${p.name} to clip` : `Add preset ${p.name} as a color layer`,
    }), `preset ${p.name}`, async () => {
      const ok = await confirmDialog({ title: 'Delete preset', message: `Delete the preset "${p.name}"?`, confirm: 'Delete', danger: true });
      if (ok) removePreset(p.id);
    }));
    return h('div', hint, list.length ? tileGrid(tiles, { label: 'Color presets' }) : emptyState('search', 'No presets found', 'Try another word.'));
  }

  const layout = tabLayout({
    title: 'Color',
    categories: CATEGORIES,
    searchLabel: 'Search LUTs and presets',
    render(cat, q) {
      if (cat === 'luts') return renderLuts(q);
      if (cat === 'presets') return renderPresets(q);
      return renderLayer();
    },
  });
  library?.listLuts?.().then((list) => {
    luts = list;
    layout.refresh();
  }).catch(() => {});
  const offs = [
    // Hidden, the tab redraws when it is shown again.
    store.on('select', () => layout.el.isConnected && layout.category !== 'layer' && redraw()),
    // A LUT applied, removed or undone elsewhere shows on the tiles.
    store.on('change', () => {
      if (layout.el.isConnected && layout.category === 'luts' && (target()?.grade?.lut?.id ?? null) !== shownLut) redraw();
    }),
    onPresetsChanged(() => layout.category === 'presets' && layout.refresh()),
    library?.on?.('luts', (list) => {
      luts = list;
      if (layout.category === 'luts') layout.refresh();
    }),
  ].filter(Boolean);
  return { el: layout.el, shown: () => layout.refresh(), dispose: () => offs.forEach((f) => f()) };
}
