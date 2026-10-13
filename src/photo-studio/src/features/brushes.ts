import type { Editor } from '../editor';
import { registerCommand, registerPanel, type Panel } from '../app/registry';
import { brushFor, brushPresets, type BrushSettings } from './paint';
import { escapeXML } from '../model/assets';
import type { Mask8 } from '../imaging/types';
import { formDialog } from '../ui/dialog';
import { selectionBounds, selectionGrid } from '../model/selection';
import { compositeRGBA } from './pixels';
import { readMask } from '../model/tiles';

// Brush presets: the built-in originals plus user presets (possibly sampled
// tips defined from a selection), stored locally.
type StoredPreset = { name: string; tip: Partial<BrushSettings>; sample?: { width: number; height: number; data: string } };
const storageKey = 'photo-studio-brushes';
function loadUser(): StoredPreset[] {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
let user = loadUser();
const saveUser = () => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(user));
  } catch {
    /* Quota or privacy mode; presets stay for this session. */
  }
};
const toB64 = (d: Uint8Array) => btoa(String.fromCharCode(...d));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function sampleOf(p: StoredPreset): Mask8 | undefined {
  return p.sample ? { width: p.sample.width, height: p.sample.height, data: fromB64(p.sample.data) } : undefined;
}
function allPresets(): StoredPreset[] {
  return [...brushPresets.map((p) => ({ name: p.name, tip: p.tip })), ...user];
}
export const paintingTools = new Set(['brush', 'pencil', 'eraser', 'clone-stamp', 'history-brush', 'blur-tool', 'sharpen-tool', 'smudge-tool', 'dodge', 'burn', 'sponge', 'background-eraser', 'color-replacement', 'pattern-stamp', 'mixer-brush', 'art-history', 'spot-healing', 'healing-brush']);
function activeBrush(e: Editor) {
  return brushFor(paintingTools.has(e.tool) ? e.tool : 'brush');
}
/** A small stroke preview drawn with the preset's tip shape. */
function strokePreview(p: StoredPreset, w = 120, h = 28) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const sample = sampleOf(p);
  const tip = { hardness: 0.8, roundness: 1, angle: 0, spacing: 0.1, ...p.tip };
  let stamp: HTMLCanvasElement | undefined;
  if (sample) {
    stamp = document.createElement('canvas');
    stamp.width = sample.width;
    stamp.height = sample.height;
    const sg = stamp.getContext('2d')!;
    const img = sg.createImageData(sample.width, sample.height);
    for (let i = 0; i < sample.data.length; i++) img.data.set([200, 200, 200, sample.data[i]], i * 4);
    sg.putImageData(img, 0, 0);
  }
  const size = 14;
  for (let x = 10; x < w - 10; x += Math.max(1, size * tip.spacing)) {
    const y = h / 2 + Math.sin((x / w) * Math.PI * 2) * 6;
    g.save();
    g.translate(x, y);
    g.rotate((tip.angle * Math.PI) / 180);
    g.scale(1, tip.roundness);
    if (stamp) g.drawImage(stamp, -size / 2, -size / 2, size, size);
    else {
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, size / 2);
      grad.addColorStop(0, 'rgba(210,210,210,0.35)');
      grad.addColorStop(Math.min(0.99, tip.hardness), 'rgba(210,210,210,0.35)');
      grad.addColorStop(1, 'rgba(210,210,210,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(0, 0, size / 2, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }
  return c.toDataURL();
}
const previews = new Map<string, string>();
// Preset Manager access to the user's own presets (built-ins are read-only).
export type BrushPresetData = StoredPreset;
export const userBrushPresets = (): StoredPreset[] => structuredClone(user);
export function setUserBrushPresets(list: StoredPreset[]) {
  user = structuredClone(list);
  saveUser();
  previews.clear();
}
export const builtinBrushPresets = (): StoredPreset[] => brushPresets.map((p) => ({ name: p.name, tip: p.tip }));
export const brushPresetPreview = (p: StoredPreset) => strokePreview(p, 96, 24);
/** The active painting tool's brush as a preset (Libraries). */
export function currentBrushPreset(e: Editor, name: string): StoredPreset {
  const s = activeBrush(e);
  const { sample, ...tip } = structuredClone(s) as BrushSettings & { sample?: Mask8 };
  return { name, tip: tip as Partial<BrushSettings>, ...(sample ? { sample: { width: sample.width, height: sample.height, data: toB64(sample.data) } } : {}) };
}
/** Make a preset the active painting tool's brush (Brushes panel, Libraries). */
export function applyBrushPreset(e: Editor, p: StoredPreset) {
  const s = activeBrush(e);
  Object.assign(s, { roundness: 1, angle: 0, spacing: 0.1, airbrush: false, ...p.tip, dynamics: { ...(p.tip.dynamics ?? {}) }, sample: sampleOf(p) });
  e.options();
  e.dock.update();
}

const brushesPanel: Panel = {
  id: 'brushes',
  title: 'Brushes',
  icon: 'brush-presets',
  location: 'strip',
  mount: (e, el) => {
    el.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-brush-preset]');
      if (!b) return;
      applyBrushPreset(e, allPresets()[Number(b.dataset.brushPreset)]);
    });
    el.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.id !== 'brushes-size') return;
      activeBrush(e).size = Number(t.value);
      e.options();
    });
  },
  update: (e, el) => {
    const s = activeBrush(e);
    el.innerHTML = `<label class="panel-row">Size <input id="brushes-size" type="range" min="1" max="1000" value="${s.size}"><output>${Math.round(s.size)} px</output></label><div class="brush-presets">${allPresets()
      .map((p, i) => {
        const key = `${i}:${p.name}`;
        let url = previews.get(key);
        if (!url) previews.set(key, (url = strokePreview(p)));
        return `<button data-brush-preset="${i}" title="${escapeXML(p.name)}"><img src="${url}" alt=""><span>${escapeXML(p.name)}</span></button>`;
      })
      .join('')}</div>`;
  },
  menu: () => ['edit.define-brush', 'brushes.delete-user', 'brushes.reset'],
};

const settingsPanel: Panel = {
  id: 'brush-settings',
  title: 'Brush Settings',
  icon: 'brush-settings',
  location: 'strip',
  shortcut: 'F5',
  mount: (e, el) => {
    el.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement;
      const k = t.dataset.bs;
      if (!k) return;
      const s = activeBrush(e);
      const v = t.type === 'checkbox' ? t.checked : Number(t.value);
      const pct = (n: number) => n / 100;
      switch (k) {
        case 'size': s.size = v as number; break;
        case 'angle': s.angle = v as number; break;
        case 'roundness': s.roundness = Math.max(0.01, pct(v as number)); break;
        case 'hardness': s.hardness = pct(v as number); break;
        case 'spacing': s.spacing = Math.max(0.01, pct(v as number)); break;
        case 'sizeJitter': s.dynamics.sizeJitter = pct(v as number); break;
        case 'minimumDiameter': s.dynamics.minimumDiameter = pct(v as number); break;
        case 'angleJitter': s.dynamics.angleJitter = pct(v as number); break;
        case 'roundnessJitter': s.dynamics.roundnessJitter = pct(v as number); break;
        case 'scatter': s.dynamics.scatter = pct(v as number); break;
        case 'count': s.dynamics.count = v as number; break;
        case 'opacityJitter': s.dynamics.opacityJitter = pct(v as number); break;
        case 'flowJitter': s.dynamics.flowJitter = pct(v as number); break;
        case 'pressureSize': s.dynamics.pressureSize = v as boolean; break;
        case 'pressureOpacity': s.dynamics.pressureOpacity = v as boolean; break;
        case 'pressureFlow': s.dynamics.pressureFlow = v as boolean; break;
        case 'airbrush': s.airbrush = v as boolean; break;
        case 'smoothing': s.smoothing = pct(v as number); break;
      }
      const out = t.parentElement?.querySelector('output');
      if (out && t.type !== 'checkbox') out.textContent = String(t.value) + (k === 'size' ? ' px' : k === 'angle' ? '°' : k === 'count' ? '' : '%');
    });
    el.addEventListener('change', () => e.options());
    el.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('[data-clear-sample]')) {
        delete activeBrush(e).sample;
        e.dock.update();
      }
    });
  },
  update: (e, el) => {
    if (el.contains(document.activeElement)) return;
    const s = activeBrush(e),
      d = s.dynamics;
    const range = (k: string, label: string, value: number, min: number, max: number, unit = '%') =>
      `<label class="bs-row"><span>${label}</span><input type="range" data-bs="${k}" min="${min}" max="${max}" value="${value}"><output>${Math.round(value)}${unit}</output></label>`;
    const check = (k: string, label: string, value: boolean | undefined) => `<label class="bs-check"><input type="checkbox" data-bs="${k}" ${value ? 'checked' : ''}> ${label}</label>`;
    el.innerHTML = `<div class="brush-settings"><p class="muted">Editing: ${escapeXML(paintingTools.has(e.tool) ? (e.activeTool?.label ?? 'Brush') : 'Brush Tool')}</p>
<h4>Brush Tip Shape ${s.sample ? `<button class="link-button" data-clear-sample>Use round tip</button>` : ''}</h4>
${s.sample ? '<p class="muted">Sampled tip</p>' : ''}
${range('size', 'Size', s.size, 1, 1000, ' px')}${range('angle', 'Angle', s.angle, -180, 180, '°')}${range('roundness', 'Roundness', s.roundness * 100, 1, 100)}${s.sample ? '' : range('hardness', 'Hardness', s.hardness * 100, 0, 100)}${range('spacing', 'Spacing', s.spacing * 100, 1, 1000)}
<h4>Shape Dynamics</h4>${range('sizeJitter', 'Size Jitter', (d.sizeJitter ?? 0) * 100, 0, 100)}${check('pressureSize', 'Pen pressure controls size', d.pressureSize)}${range('minimumDiameter', 'Minimum Diameter', (d.minimumDiameter ?? 0) * 100, 0, 100)}${range('angleJitter', 'Angle Jitter', (d.angleJitter ?? 0) * 100, 0, 100)}${range('roundnessJitter', 'Roundness Jitter', (d.roundnessJitter ?? 0) * 100, 0, 100)}
<h4>Scattering</h4>${range('scatter', 'Scatter', (d.scatter ?? 0) * 100, 0, 1000)}${range('count', 'Count', d.count ?? 1, 1, 16, '')}
<h4>Transfer</h4>${range('opacityJitter', 'Opacity Jitter', (d.opacityJitter ?? 0) * 100, 0, 100)}${check('pressureOpacity', 'Pen pressure controls opacity', d.pressureOpacity)}${range('flowJitter', 'Flow Jitter', (d.flowJitter ?? 0) * 100, 0, 100)}${check('pressureFlow', 'Pen pressure controls flow', d.pressureFlow)}
<h4>Other</h4>${check('airbrush', 'Build-up (airbrush)', s.airbrush)}${range('smoothing', 'Smoothing', s.smoothing * 100, 0, 100)}</div>`;
  },
};

export function installBrushes(e: Editor) {
  registerPanel(brushesPanel, settingsPanel);
  registerCommand(
    {
      id: 'edit.define-brush',
      label: 'Define Brush Preset…',
      enabled: (e) => e.hasDocument,
      run: async (e) => {
        const doc = e.doc;
        const sel = selectionGrid(doc, e.assets.tiles);
        const b = sel ? selectionBounds(doc, sel) : { x: 0, y: 0, width: doc.width, height: doc.height };
        if (!b || b.width * b.height > 2500 * 2500) {
          e.message('Select an area up to 2500 × 2500 pixels to define a brush.');
          return;
        }
        const v = await formDialog('Brush Name', [{ name: 'name', label: 'Name', value: `Sampled Brush ${user.length + 1}` }], 'OK');
        if (!v) return;
        // Dark pixels paint: coverage is inverted luminance times alpha (and the selection).
        const img = await compositeRGBA(e);
        const cover = sel ? readMask(e.assets.tiles, sel, b).data : undefined;
        const scale = Math.min(1, 256 / Math.max(b.width, b.height));
        const w = Math.max(1, Math.round(b.width * scale)),
          h = Math.max(1, Math.round(b.height * scale));
        const data = new Uint8Array(w * h);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const sx = Math.min(b.width - 1, Math.floor((x + 0.5) / scale)),
              sy = Math.min(b.height - 1, Math.floor((y + 0.5) / scale));
            const i = ((b.y + sy) * img.width + b.x + sx) * 4;
            const l = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
            data[y * w + x] = ((255 - l) * img.data[i + 3] * (cover ? cover[sy * b.width + sx] / 255 : 1)) / 255;
          }
        user.push({ name: v.name, tip: { size: Math.max(b.width, b.height), spacing: 0.25, hardness: 1 }, sample: { width: w, height: h, data: toB64(data) } });
        saveUser();
        const s = activeBrush(e);
        s.sample = { width: w, height: h, data };
        s.size = Math.max(b.width, b.height);
        s.spacing = 0.25;
        e.options();
        e.dock.update();
        e.message(`Brush “${v.name}” defined.`);
      },
    },
    {
      id: 'brushes.delete-user',
      label: 'Delete Custom Brushes',
      enabled: () => user.length > 0,
      recordable: false,
      run: (e) => {
        user = [];
        saveUser();
        previews.clear();
        e.dock.update();
      },
    },
    {
      id: 'brushes.reset',
      label: 'Reset Current Brush',
      recordable: false,
      run: (e) => {
        void e.runCommand('brush.reset');
        e.dock.update();
      },
    },
  );
  void e;

}
