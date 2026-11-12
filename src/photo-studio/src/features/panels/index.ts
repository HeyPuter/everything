import type { Editor } from '../../editor';
import { registerPanel, registerCommand, commands, type Panel } from '../../app/registry';
import { layersPanel } from './layers';
import { propertiesPanel } from './properties';
import { ColorControls } from '../../ui/color';
import { escapeXML } from '../../model/assets';
import { svg } from '../../app/icons';
import { findLayer } from '../../model/document';
import { readRGBA } from '../../model/tiles';
import { canvasRect } from '../../model/selection';
import { commitSelectionMask, selectionOp } from '../selection';
import { compositeRGBA, hexRgb, rgbHex } from '../pixels';
import type { RGBA8 } from '../../imaging/types';
import { sessionSnapshots } from '../history-tools';
import { infoPanel } from '../measure/info';
import { centerPoint, panToCenter } from '../../app/view-transform';

const historyPanel: Panel = {
  id: 'history',
  title: 'History',
  icon: 'history',
  location: 'strip',
  mount: (e, el) => {
    el.id = 'history';
    el.addEventListener('click', (ev) => {
      const src = (ev.target as HTMLElement).closest<HTMLElement>('[data-history-source]');
      if (src) {
        void e.runCommand('history.set-source', src.dataset.historySource);
        return;
      }
      const snap = (ev.target as HTMLElement).closest<HTMLElement>('[data-snapshot]');
      if (snap) {
        void e.runCommand('history.restore-snapshot', snap.dataset.snapshot);
        return;
      }
      const row = (ev.target as HTMLElement).closest<HTMLElement>('[data-history]');
      if (!row) return;
      e.transform.apply();
      e.history.goto(Number(row.dataset.history));
      e.restoreSelection();
    });
  },
  update: (e, el) => {
    const done = e.history.labels,
      undone = e.history.redoLabels;
    const rows = [
      `<button class="history-row ${done.length === 0 ? 'current' : ''}" data-history="0">${svg('image', 14)}<span>${escapeXML(e.doc.name)}</span></button>`,
      ...done.map((l, i) => `<button class="history-row ${i === done.length - 1 ? 'current' : ''}" data-history="${i + 1}">${svg('history', 14)}<span>${escapeXML(l)}</span></button>`),
      ...undone.map((l, i) => `<button class="history-row undone" data-history="${done.length + i + 1}">${svg('history', 14)}<span>${escapeXML(l)}</span></button>`),
    ];
    const snaps = sessionSnapshots(e);
    const source = (e.settings.historySource as string | undefined) ?? '';
    const snapRows = snaps.map((sn) => `<div class="history-snapshot"><button class="history-source" data-history-source="${sn.id}" aria-pressed="${source === sn.id}" title="Set the source for the History Brush" aria-label="Use ${escapeXML(sn.name)} as History Brush source">${svg('history', 13)}</button><button class="history-row" data-snapshot="${sn.id}">${svg('camera', 14)}<span>${escapeXML(sn.name)}</span></button></div>`).join('');
    el.innerHTML = `${snapRows ? `<div class="history-snapshots">${snapRows}</div>` : ''}<div class="history-entries">${rows.join('')}</div><div class="history-controls"><button data-command="history.snapshot" aria-label="Create new snapshot" title="Create new snapshot">${svg('camera', 15)}</button><button data-command="edit.undo" aria-label="Undo" title="Undo" ${e.history.canUndo ? '' : 'disabled'}>${svg('undo-2', 15)}</button><button data-command="edit.redo" aria-label="Redo" title="Redo" ${e.history.canRedo ? '' : 'disabled'}>${svg('redo-2', 15)}</button></div>`;
    const list = el.querySelector('.history-entries')!;
    list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  },
  menu: () => ['edit.undo', 'edit.redo', '-', 'history.snapshot', '-', 'edit.purge-history'],
};

const colorPanel: Panel = {
  id: 'color',
  title: 'Color',
  icon: 'palette',
  location: 'dock-top',
  shortcut: 'F6',
  mount: (e, el) => {
    el.innerHTML = `<div class="color-body"><div class="color-chip-pair"><button class="chip fg-big" data-command="color.pick-foreground" aria-label="Foreground color"></button><button class="chip bg-big" data-command="color.pick-background" aria-label="Background color"></button></div><div class="color-picker-row"><div id="color-plane" tabindex="0" role="slider" aria-label="Color saturation and brightness" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="color-marker"></span></div><input id="color-hue" type="range" min="0" max="359" value="0" aria-label="Color hue" orient="vertical"></div><div class="color-value-row"><span id="color-preview"></span><label for="color-value">Hex</label><input id="color-value" value="#000000" maxlength="7" spellcheck="false" aria-label="Hex color"><span class="rgb-readout"></span></div></div>`;
    e.colorControls = new ColorControls(el, (color) => e.setForeground(color));
    e.colorControls.sync(e.color);
  },
  update: (e, el) => {
    (el.querySelector('.fg-big') as HTMLElement).style.background = e.color;
    (el.querySelector('.bg-big') as HTMLElement).style.background = e.background;
    const [r, g, b] = hexRgb(e.color);
    el.querySelector('.rgb-readout')!.textContent = `R ${r} G ${g} B ${b}`;
  },
};

// An original default palette: neutral ramp plus evenly spaced hues.
const defaultSwatches = [
  '#000000', '#262626', '#4d4d4d', '#737373', '#999999', '#bfbfbf', '#e6e6e6', '#ffffff',
  ...[0, 20, 40, 60, 90, 140, 180, 200, 220, 250, 280, 320].flatMap((h) => [hsl(h, 0.85, 0.35), hsl(h, 0.8, 0.5), hsl(h, 0.75, 0.7)]),
];
function hsl(h: number, s: number, l: number) {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return rgbHex(f(0) * 255, f(8) * 255, f(4) * 255);
}
function loadSwatches(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem('photo-studio-swatches') ?? 'null');
    if (Array.isArray(v) && v.every((c) => /^#[0-9a-f]{6}$/i.test(c))) return v;
  } catch {
    /* Optional. */
  }
  return [...defaultSwatches];
}
let swatches = loadSwatches();
const saveSwatches = () => {
  try {
    localStorage.setItem('photo-studio-swatches', JSON.stringify(swatches));
  } catch {
    /* Optional. */
  }
};
/** Append colors to the Swatches panel (color picker, swatch libraries). */
export function addSwatch(e: Editor, ...colors: string[]) {
  swatches.push(...colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).map((c) => c.toLowerCase()));
  saveSwatches();
  e.dock.update();
}
export const currentSwatches = () => [...swatches];
export function replaceSwatches(e: Editor, colors: string[]) {
  swatches = colors.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).map((c) => c.toLowerCase());
  saveSwatches();
  e.dock.update();
}
const swatchMarkup = new WeakMap<HTMLElement, string>();
const swatchesPanel: Panel = {
  id: 'swatches',
  title: 'Swatches',
  icon: 'swatch-book',
  location: 'dock-top',
  mount: (e, el) => {
    const remove = (b: HTMLElement) => {
      const i = Number(b.dataset.index);
      const focused = b === document.activeElement;
      swatches.splice(i, 1);
      saveSwatches();
      e.dock.update();
      // The grid is rebuilt: keep the keyboard on the swatch that took its place.
      if (focused) el.querySelector<HTMLElement>(`[data-index="${Math.min(i, swatches.length - 1)}"]`)?.focus();
    };
    el.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-swatch]');
      if (b) {
        if (ev.altKey) remove(b);
        else if (ev.metaKey || ev.ctrlKey) e.setBackground(b.dataset.swatch!);
        else e.setForeground(b.dataset.swatch!);
        return;
      }
      if ((ev.target as HTMLElement).closest('[data-add-swatch]')) {
        swatches.push(e.color);
        saveSwatches();
        e.dock.update();
      }
    });
    // Keyboard equivalents of the modified clicks: Delete removes a swatch,
    // Mod+Enter makes it the background color.
    el.addEventListener('keydown', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-swatch]');
      if (!b) return;
      if (ev.key === 'Delete' || ev.key === 'Backspace' || (ev.key === 'Enter' && ev.altKey)) remove(b);
      else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) e.setBackground(b.dataset.swatch!);
      else return;
      ev.preventDefault();
      ev.stopPropagation();
    });
  },
  update: (e, el) => {
    const html = `<div class="swatch-grid" role="group" aria-label="Swatches">${swatches.map((c, i) => `<button data-swatch="${c}" data-index="${i}" style="--swatch:${c}" title="${c} — click: foreground, ${'⌘'}-click: background, Alt-click or Delete: remove" aria-label="Swatch ${c}" aria-keyshortcuts="Delete"></button>`).join('')}<button data-add-swatch title="Add foreground color" aria-label="Add swatch from foreground color">${svg('plus', 13)}</button></div>`;
    // Updates run after every edit; rebuilding unchanged buttons would cost
    // time and take the keyboard focus off the swatch just chosen.
    if (swatchMarkup.get(el) === html) return;
    swatchMarkup.set(el, html);
    el.innerHTML = html;
    void e;
  },
  // Library and harmony commands come from the color feature (features/color/swatches.ts).
  menu: () => [
    'swatches.reset', '-',
    'swatches.library-hue-ramps', 'swatches.library-grays', 'swatches.library-web-safe', 'swatches.library-pastels', 'swatches.library-earth', '-',
    'swatches.harmony-complementary', 'swatches.harmony-analogous', 'swatches.harmony-triadic', 'swatches.harmony-split-complementary', 'swatches.harmony-tetradic', 'swatches.harmony-monochromatic',
  ],
};

// Snapshot of the visible composite for panels that need pixel data.
let snapshot: { doc: unknown; image: Promise<RGBA8> } | undefined;
let snapshotTimer = 0;
function compositeSnapshot(e: Editor) {
  if (!snapshot || snapshot.doc !== e.doc) snapshot = { doc: e.doc, image: compositeRGBA(e) };
  return snapshot.image;
}
function later(e: Editor, f: () => void) {
  clearTimeout(snapshotTimer);
  snapshotTimer = window.setTimeout(() => {
    if (!e.toolBusy && e.renderer) f();
  }, 350);
}
const navigatorPanel: Panel = {
  id: 'navigator',
  title: 'Navigator',
  icon: 'compass',
  location: 'strip',
  mount: (e, el) => {
    el.innerHTML = `<div class="navigator-view"><canvas width="220" height="160"></canvas><div class="navigator-box"></div></div><div class="navigator-zoom"><button data-command="view.zoom-out" class="icon-button" aria-label="Zoom out">${svg('minus', 13)}</button><input type="range" min="0" max="100" step="0.1" aria-label="Zoom"><button data-command="view.zoom-in" class="icon-button" aria-label="Zoom in">${svg('plus', 13)}</button><output></output></div>`;
    const view = el.querySelector<HTMLElement>('.navigator-view')!;
    const pan = (ev: PointerEvent) => {
      const c = el.querySelector('canvas')!.getBoundingClientRect();
      const s = Math.min(c.width / e.doc.width, c.height / e.doc.height);
      const ox = (c.width - e.doc.width * s) / 2,
        oy = (c.height - e.doc.height * s) / 2;
      const dx = (ev.clientX - c.left - ox) / s,
        dy = (ev.clientY - c.top - oy) / s;
      e.pan = panToCenter(e.activeView.state(e.viewAspect()), e.doc, dx, dy);
      e.view();
      e.overlay();
      navigatorPanel.update!(e, el);
    };
    view.addEventListener('pointerdown', (ev) => {
      view.setPointerCapture(ev.pointerId);
      pan(ev);
    });
    view.addEventListener('pointermove', (ev) => {
      if (view.hasPointerCapture(ev.pointerId)) pan(ev);
    });
    el.querySelector<HTMLInputElement>('input[type=range]')!.addEventListener('input', (ev) => {
      const t = Number((ev.target as HTMLInputElement).value) / 100;
      e.zoomAt(Math.exp(Math.log(0.01) + t * (Math.log(64) - Math.log(0.01))));
    });
    e.onUpdate(() => {
      if (e.dock.isVisible('navigator')) navigatorPanel.update!(e, el);
    });
  },
  update: (e, el) => {
    const canvas = el.querySelector('canvas')!;
    const s = Math.min(canvas.width / e.doc.width, canvas.height / e.doc.height);
    const ox = (canvas.width - e.doc.width * s) / 2,
      oy = (canvas.height - e.doc.height * s) / 2;
    const v = e.el('#viewport');
    // The window's visible area, centered on the document point at its middle
    // and turned with the view rotation.
    const aspect = e.viewAspect();
    const [cx, cy] = centerPoint(e.activeView.state(aspect), e.doc);
    const w = v.clientWidth / (e.zoom * aspect),
      h = v.clientHeight / e.zoom;
    const box = el.querySelector<HTMLElement>('.navigator-box')!;
    Object.assign(box.style, { left: `${ox + (cx - w / 2) * s}px`, top: `${oy + (cy - h / 2) * s}px`, width: `${w * s}px`, height: `${h * s}px`, transform: e.rotation ? `rotate(${-e.rotation}deg)` : '' });
    const range = el.querySelector<HTMLInputElement>('input[type=range]')!;
    range.value = String(((Math.log(e.zoom) - Math.log(0.01)) / (Math.log(64) - Math.log(0.01))) * 100);
    el.querySelector('output')!.textContent = `${Math.round(e.zoom * 100)}%`;
    if (!e.hasDocument) return;
    later(e, async () => {
      const img = await compositeSnapshot(e);
      const tmp = new OffscreenCanvas(img.width, img.height);
      tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
      const c = canvas.getContext('2d')!;
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.drawImage(tmp, ox, oy, img.width * s, img.height * s);
    });
  },
};
const histogramPanel: Panel = {
  id: 'histogram',
  title: 'Histogram',
  icon: 'chart-column',
  location: 'strip',
  mount: (e, el) => {
    el.innerHTML = `<label>Channel <select class="histogram-channel"><option value="rgb">RGB</option><option value="lum">Luminosity</option><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select></label><svg class="histogram" viewBox="0 0 256 100" preserveAspectRatio="none" role="img" aria-label="Histogram"></svg><div class="histogram-stats muted"></div>`;
    el.querySelector('select')!.addEventListener('change', () => histogramPanel.update!(e, el));
  },
  update: (e, el) => {
    if (!e.hasDocument) return;
    later(e, async () => {
      const img = await compositeSnapshot(e);
      const channel = el.querySelector<HTMLSelectElement>('select')!.value;
      const bins = [new Float64Array(256), new Float64Array(256), new Float64Array(256), new Float64Array(256)];
      let count = 0,
        sum = 0;
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue;
        bins[0][d[i]]++;
        bins[1][d[i + 1]]++;
        bins[2][d[i + 2]]++;
        const l = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
        bins[3][l]++;
        count++;
        sum += l;
      }
      const path = (b: Float64Array, max: number) => `M0 100${Array.from(b, (v, i) => `L${i} ${100 - (v / max) * 100}`).join('')}L255 100Z`;
      const max = (arr: Float64Array[]) => Math.max(1, ...arr.map((b) => Math.max(...b)));
      let html = '';
      if (channel === 'rgb') {
        const m = max(bins.slice(0, 3));
        html = `<path d="${path(bins[0], m)}" fill="rgba(255,60,60,.55)"/><path d="${path(bins[1], m)}" fill="rgba(60,220,60,.55)"/><path d="${path(bins[2], m)}" fill="rgba(70,110,255,.55)"/>`;
      } else {
        const b = bins[{ lum: 3, r: 0, g: 1, b: 2 }[channel as 'lum' | 'r' | 'g' | 'b']];
        html = `<path d="${path(b, max([b]))}" fill="currentColor" opacity=".8"/>`;
      }
      el.querySelector('svg')!.innerHTML = html;
      const mean = count ? sum / count : 0;
      let acc = 0,
        median = 0;
      for (let i = 0; i < 256; i++) {
        acc += bins[3][i];
        if (acc >= count / 2) {
          median = i;
          break;
        }
      }
      el.querySelector('.histogram-stats')!.textContent = `Mean ${mean.toFixed(2)} · Median ${median} · Pixels ${count.toLocaleString()}`;
    });
  },
};

export function installPanels(e: Editor) {
  registerPanel(colorPanel, swatchesPanel, propertiesPanel, layersPanel, historyPanel, navigatorPanel, infoPanel, histogramPanel);
  registerCommand(
    {
      id: 'swatches.reset',
      label: 'Reset Swatches',
      run: (e) => {
        swatches = [...defaultSwatches];
        saveSwatches();
        e.dock.update();
      },
      recordable: false,
    },
    {
      id: 'layer.add-mask',
      label: 'Add Layer Mask',
      hidden: true,
      enabled: (e) => !!e.layer,
      run: async (e) => {
        if (e.layer && (e.layer.maskGrid || e.layer.pixelMask || e.layer.mask || e.layer.maskAsset)) {
          e.maskTarget = e.layer.id;
          e.update();
          return;
        }
        // Called from inside a running command, so invoke the target directly:
        // runCommand would see the editor busy and do nothing.
        await commands.get(e.doc.selection ? 'layer.mask-reveal-selection' : 'layer.mask-reveal-all')!.run(e);
      },
    },
    {
      id: 'select.load-transparency',
      label: 'Load Layer Transparency',
      hidden: true,
      run: (e, arg) => {
        const l = findLayer(e.doc.layers, String(arg ?? e.selected));
        if (!l?.pixels) {
          e.message('Only pixel layers can load their transparency as a selection.');
          return;
        }
        const area = canvasRect(e.doc);
        const img = readRGBA(e.assets.tiles, l.pixels, area);
        const m = new Uint8Array(area.width * area.height);
        for (let i = 0; i < m.length; i++) m[i] = img.data[i * 4 + 3];
        const p = e.pointerInfo;
        commitSelectionMask(e, { width: area.width, height: area.height, data: m }, p ? selectionOp(e, p) : 'replace', 'Load Selection');
      },
    },
    {
      id: 'color.pick-layer-color',
      label: 'Change Fill Color',
      hidden: true,
      run: (e) => {
        const l = e.layer;
        if (l?.kind !== 'solid') return;
        void import('../color/picker').then(({ pickColor }) => pickColor(e, l.color, 'Fill Color')).then((c) => {
          if (c) e.editLayer('Change Fill Color', (x) => (x.color = c));
        });
      },
    },
  );
  void e;
}
