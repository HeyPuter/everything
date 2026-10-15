// Preferences ▸ Lights: the user's studio lights (edited here), installed MatCaps and HDRIs.
// Studio lights are stored as JSON, MatCap images and HDRI pixels in IndexedDB.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators } from '../app/app';
import { panel, checkbox, colorSwatch, numberField } from '../ui/widgets';
import { splitRow } from '../ui/props';
import { promptText } from '../ui/menu';
import { pickFile } from '../io/native';
import { renderContext } from '../render/context';
import { library, libraryChanged, onLibraryChange, matcapPreview, hdriPreview, dropMatcapTexture, dropHdriTextures, type StudioLightDef, type SolidLight, type Vec3, type HdriDef } from '../render/studiolights';
import { dropStudioPreview } from '../editors/view3d/studiochooser';
import { registerPrefSection } from './editor';
import { assetGet, assetPut, assetDelete, assetKeys } from './assetstore';

const STUDIO_KEY = 'p3d.studiolights.v1';
const uid = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------------------
// persistence

function saveStudioLights() {
  try {
    localStorage.setItem(STUDIO_KEY, JSON.stringify(library.studio.filter((s) => !s.builtin)));
  } catch {
    // storage unavailable
  }
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Validate a stored / imported studio light. */
export function cleanStudioLight(raw: unknown): StudioLightDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || !isVec3(r.ambient) || !Array.isArray(r.lights)) return null;
  const lights: SolidLight[] = [];
  for (let i = 0; i < 4; i++) {
    const l = (r.lights[i] ?? {}) as Record<string, unknown>;
    lights.push({
      use: l.use === true,
      direction: isVec3(l.direction) ? l.direction : [0, 0, 1],
      diffuse: isVec3(l.diffuse) ? l.diffuse : [0.8, 0.8, 0.8],
      specular: isVec3(l.specular) ? l.specular : [0.2, 0.2, 0.2],
      smooth: typeof l.smooth === 'number' ? Math.max(0, Math.min(1, l.smooth)) : 0,
    });
  }
  return { id: typeof r.id === 'string' ? r.id : uid(), name: r.name, ambient: r.ambient, lights };
}

let loaded = false;
async function loadLibrary() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(STUDIO_KEY) ?? '[]') as unknown[];
    for (const s of raw) {
      const c = cleanStudioLight(s);
      if (c && !library.studio.some((x) => x.id === c.id)) library.studio.push(c);
    }
  } catch {
    // ignore broken storage
  }
  const keys = ((await assetKeys()) ?? []).map(String);
  for (const k of keys.filter((x) => x.startsWith('matcap:'))) {
    const v = await assetGet<{ name: string; dataUrl: string }>(k);
    if (v && typeof v.dataUrl === 'string') library.matcaps.push({ id: k.slice(7), name: v.name, dataUrl: v.dataUrl });
  }
  for (const k of keys.filter((x) => x.startsWith('hdri:'))) {
    const v = await assetGet<{ name: string; width: number; height: number; data: Float32Array }>(k);
    if (v && v.data instanceof Float32Array) library.hdris.push({ id: k.slice(5), name: v.name, kind: 'image', pixels: { width: v.width, height: v.height, data: v.data } });
  }
  libraryChanged();
}

if (typeof window !== 'undefined') void loadLibrary();

function redrawViews() {
  renderContext?.forceSync();
  renderContext?.engine.requestDraw();
  app.changed('ui', 'view');
}
onLibraryChange(redrawViews);

// ---------------------------------------------------------------------------
// installing files

async function readImage(file: File, max: number): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

export async function installMatcap(file: File) {
  const c = await readImage(file, 512);
  // a matcap is square: crop the center
  const s = Math.min(c.width, c.height);
  const sq = document.createElement('canvas');
  sq.width = sq.height = Math.min(256, s);
  sq.getContext('2d')!.drawImage(c, (c.width - s) / 2, (c.height - s) / 2, s, s, 0, 0, sq.width, sq.height);
  const id = uid();
  const name = file.name.replace(/\.[^.]+$/, '');
  const dataUrl = sq.toDataURL('image/png');
  library.matcaps.push({ id, name, dataUrl });
  await assetPut(`matcap:${id}`, { name, dataUrl });
  libraryChanged();
  return id;
}

const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Decode an HDR (.hdr), OpenEXR (.exr) or ordinary image into linear float RGBA. */
async function decodeEnvironment(file: File): Promise<{ width: number; height: number; data: Float32Array }> {
  const name = file.name.toLowerCase();
  const toRGBA = (w: number, hgt: number, src: ArrayLike<number>, channels: number) => {
    const out = new Float32Array(w * hgt * 4);
    for (let i = 0; i < w * hgt; i++) {
      out[i * 4] = src[i * channels];
      out[i * 4 + 1] = src[i * channels + 1];
      out[i * 4 + 2] = src[i * channels + 2];
      out[i * 4 + 3] = 1;
    }
    return out;
  };
  if (name.endsWith('.hdr') || name.endsWith('.pic')) {
    const { HDRLoader } = await import('three/examples/jsm/loaders/HDRLoader.js');
    const { FloatType } = await import('three');
    const l = new HDRLoader();
    l.setDataType(FloatType);
    const t = l.parse(await file.arrayBuffer()) as { width: number; height: number; data: Float32Array };
    return { width: t.width, height: t.height, data: toRGBA(t.width, t.height, t.data, t.data.length / (t.width * t.height)) };
  }
  if (name.endsWith('.exr')) {
    const { EXRLoader } = await import('three/examples/jsm/loaders/EXRLoader.js');
    const { FloatType } = await import('three');
    const l = new EXRLoader();
    l.setDataType(FloatType);
    const t = l.parse(await file.arrayBuffer()) as unknown as { width: number; height: number; data: Float32Array };
    // EXR rows are stored bottom-up
    const ch = t.data.length / (t.width * t.height);
    const flipped = new Float32Array(t.data.length);
    for (let y = 0; y < t.height; y++) flipped.set(t.data.subarray((t.height - 1 - y) * t.width * ch, (t.height - y) * t.width * ch), y * t.width * ch);
    return { width: t.width, height: t.height, data: toRGBA(t.width, t.height, flipped, ch) };
  }
  const c = await readImage(file, 2048);
  const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const data = new Float32Array(c.width * c.height * 4);
  for (let i = 0; i < c.width * c.height; i++) {
    data[i * 4] = srgbToLin(px[i * 4] / 255);
    data[i * 4 + 1] = srgbToLin(px[i * 4 + 1] / 255);
    data[i * 4 + 2] = srgbToLin(px[i * 4 + 2] / 255);
    data[i * 4 + 3] = 1;
  }
  return { width: c.width, height: c.height, data };
}

/** Box-downsample to at most `maxW` wide (keeps storage and texture sizes sensible). */
function shrink(p: { width: number; height: number; data: Float32Array }, maxW: number) {
  if (p.width <= maxW) return p;
  const f = Math.ceil(p.width / maxW);
  const w = Math.floor(p.width / f),
    hgt = Math.floor(p.height / f);
  const out = new Float32Array(w * hgt * 4);
  for (let y = 0; y < hgt; y++)
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0];
      for (let j = 0; j < f; j++)
        for (let i = 0; i < f; i++) {
          const k = ((y * f + j) * p.width + (x * f + i)) * 4;
          acc[0] += p.data[k];
          acc[1] += p.data[k + 1];
          acc[2] += p.data[k + 2];
        }
      const o = (y * w + x) * 4;
      out[o] = acc[0] / (f * f);
      out[o + 1] = acc[1] / (f * f);
      out[o + 2] = acc[2] / (f * f);
      out[o + 3] = 1;
    }
  return { width: w, height: hgt, data: out };
}

export async function installHdri(file: File) {
  const px = shrink(await decodeEnvironment(file), 1024);
  const id = uid();
  const name = file.name.replace(/\.[^.]+$/, '');
  const def: HdriDef = { id, name, kind: 'image', pixels: px };
  library.hdris.push(def);
  await assetPut(`hdri:${id}`, { name, ...px });
  libraryChanged();
  return id;
}

async function removeEntry(kind: 'matcap' | 'hdri', id: string) {
  if (kind === 'matcap') {
    library.matcaps = library.matcaps.filter((m) => m.id !== id);
    dropMatcapTexture(id);
  } else {
    library.hdris = library.hdris.filter((m) => m.id !== id);
    dropHdriTextures(id);
  }
  dropStudioPreview(id);
  await assetDelete(`${kind}:${id}`);
  libraryChanged();
}

// ---------------------------------------------------------------------------
// studio light editing

let selectedStudio = 'default';
let activeLight = 0;
let selectedMatcap = '';
let selectedHdri = '';

function newStudioLight(from: StudioLightDef, name: string): StudioLightDef {
  const c = JSON.parse(JSON.stringify({ ...from, id: uid(), name, builtin: undefined, standard: undefined })) as StudioLightDef;
  delete c.builtin;
  delete c.standard;
  library.studio.push(c);
  saveStudioLights();
  libraryChanged();
  return c;
}

function changed(s: StudioLightDef) {
  saveStudioLights();
  dropStudioPreview(s.id);
  libraryChanged();
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** CPU preview of a studio light on a grey sphere (same formula as the shaders). */
function drawPreview(c: HTMLCanvasElement, s: StudioLightDef) {
  const S = c.width;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  const base = 0.8;
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const x = ((i + 0.5) / S) * 2 - 1,
        y = 1 - ((j + 0.5) / S) * 2;
      const r2 = x * x + y * y;
      const k = (j * S + i) * 4;
      if (r2 > 1) {
        img.data[k + 3] = 0;
        continue;
      }
      const n: Vec3 = [x, y, Math.sqrt(1 - r2)];
      const col = [base * s.ambient[0], base * s.ambient[1], base * s.ambient[2]];
      for (const l of s.lights) {
        if (!l.use) continue;
        const d = norm(l.direction);
        const ndl = Math.max((n[0] * d[0] + n[1] * d[1] + n[2] * d[2] + l.smooth) / (1 + l.smooth), 0);
        const hv = norm([d[0], d[1], d[2] + 1]);
        const sp = Math.pow(Math.max(0, n[0] * hv[0] + n[1] * hv[1] + n[2] * hv[2]), 50 + (6 - 50) * l.smooth);
        for (let q = 0; q < 3; q++) col[q] += base * l.diffuse[q] * ndl + l.specular[q] * sp;
      }
      for (let q = 0; q < 3; q++) img.data[k + q] = Math.round(Math.pow(Math.min(1, col[q]), 1 / 2.2) * 255);
      img.data[k + 3] = Math.round(Math.min(1, (1 - Math.sqrt(r2)) * S) * 255);
    }
  g.putImageData(img, 0, 0);
  // light direction markers
  s.lights.forEach((l, i) => {
    if (!l.use) return;
    const d = norm(l.direction);
    g.beginPath();
    g.arc(((d[0] + 1) / 2) * S, ((1 - d[1]) / 2) * S, i === activeLight ? 5 : 3.5, 0, Math.PI * 2);
    g.fillStyle = d[2] >= 0 ? '#ffd24a' : 'rgba(255,210,74,0.4)';
    g.strokeStyle = '#000';
    g.fill();
    g.stroke();
  });
}

function studioEditor(s: StudioLightDef, redraw: () => void): Child {
  const ro = !!s.builtin;
  const setL = (i: number, patch: Partial<SolidLight>) => {
    Object.assign(s.lights[i], patch);
    changed(s);
    redraw();
  };
  return h(
    'div',
    { class: 'sl-editor' },
    h(
      'div',
      { class: 'sl-preview-col' },
      h('canvas', {
        key: `sl-prev-${s.id}`,
        class: 'sl-preview',
        width: 160,
        height: 160,
        'data-tip': ro ? 'Preview' : 'Preview\nDrag to aim the selected light (Shift: from behind)',
        ref: (c: HTMLCanvasElement) => drawPreview(c, s),
        onpointerdown: (e: PointerEvent) => {
          if (ro) return;
          const c = e.currentTarget as HTMLCanvasElement;
          const aim = (ev: PointerEvent) => {
            const r = c.getBoundingClientRect();
            let x = ((ev.clientX - r.left) / r.width) * 2 - 1,
              y = 1 - ((ev.clientY - r.top) / r.height) * 2;
            const l = Math.hypot(x, y);
            if (l > 1) (x /= l), (y /= l);
            const z = Math.sqrt(Math.max(0, 1 - x * x - y * y)) * (ev.shiftKey ? -1 : 1);
            s.lights[activeLight].direction = [x, y, z];
            s.lights[activeLight].use = true;
            drawPreview(c, s);
          };
          aim(e);
          const up = () => {
            removeEventListener('pointermove', aim);
            removeEventListener('pointerup', up);
            changed(s);
            redraw();
          };
          addEventListener('pointermove', aim);
          addEventListener('pointerup', up);
        },
      }),
      ro ? h('div', { class: 'prefs-note' }, 'Built-in lights are read-only: use Copy to edit one.') : null,
    ),
    h(
      'div',
      { class: 'sl-fields' },
      splitRow('Ambient', colorSwatch(`sl-amb-${s.id}`, s.ambient, (v, f) => {
        if (ro) return;
        s.ambient = [v[0], v[1], v[2]];
        if (f) changed(s);
        redraw();
      }, { linear: true })),
      s.lights.map((l, i) =>
        h(
          'div',
          { key: i, class: { 'sl-light': true, active: i === activeLight } },
          h(
            'div',
            { class: 'sl-light-head' },
            h('button', { class: { 'sl-pick': true, on: i === activeLight }, 'aria-label': `Select light ${i + 1}`, 'data-tip': 'Aim this light with the preview', onclick: () => ((activeLight = i), redraw()) }, `Light ${i + 1}`),
            checkbox(`sl-use-${s.id}-${i}`, 'Use', l.use, (v) => !ro && setL(i, { use: v }), { disabled: ro }),
          ),
          l.use
            ? [
                splitRow('Diffuse', colorSwatch(`sl-d-${s.id}-${i}`, l.diffuse, (v, f) => !ro && (f ? setL(i, { diffuse: [v[0], v[1], v[2]] }) : (l.diffuse = [v[0], v[1], v[2]])), { linear: true })),
                splitRow('Specular', colorSwatch(`sl-s-${s.id}-${i}`, l.specular, (v, f) => !ro && (f ? setL(i, { specular: [v[0], v[1], v[2]] }) : (l.specular = [v[0], v[1], v[2]])), { linear: true })),
                splitRow('Smooth', numberField({ id: `sl-sm-${s.id}-${i}`, value: l.smooth, min: 0, max: 1, slider: true, disabled: ro, set: (v, f) => f && setL(i, { smooth: v }) })),
                splitRow('Direction', h('div', { class: 'sl-dir' }, [0, 1, 2].map((a) => numberField({ id: `sl-dir-${s.id}-${i}-${a}`, label: 'XYZ'[a], value: l.direction[a], min: -1, max: 1, disabled: ro, set: (v, f) => {
                  if (!f) return;
                  const d = [...l.direction] as Vec3;
                  d[a] = v;
                  setL(i, { direction: norm(d) });
                } })))),
              ]
            : null,
        ),
      ),
    ),
  );
}

function studioPanel(redraw: () => void): Child {
  const sel = library.studio.find((s) => s.id === selectedStudio) ?? library.studio[0];
  selectedStudio = sel.id;
  return [
    h(
      'div',
      { class: 'sl-list' },
      library.studio.map((s) =>
        h('button', { key: s.id, class: { 'sl-item': true, on: s.id === sel.id }, onclick: () => ((selectedStudio = s.id), redraw()) }, s.builtin ? icon('light_sun') : icon('light_area'), h('span', null, s.name)),
      ),
    ),
    h(
      'div',
      { class: 'prefs-btn-row left' },
      h('button', { class: 'btn', 'data-tip': 'Copy\nMake an editable copy of the selected studio light', onclick: (e: MouseEvent) => promptText('Studio Light Name', `${sel.name} Copy`, (n) => {
        if (!n.trim()) return;
        selectedStudio = newStudioLight(sel, n.trim()).id;
        redraw();
      }, { x: e.clientX, y: e.clientY }) }, icon('duplicate'), 'Copy'),
      h('button', { class: 'btn', disabled: !!sel.builtin, 'data-tip': 'Rename\nRename the selected studio light', onclick: (e: MouseEvent) => promptText('Studio Light Name', sel.name, (n) => {
        if (!n.trim()) return;
        sel.name = n.trim();
        changed(sel);
        redraw();
      }, { x: e.clientX, y: e.clientY }) }, 'Rename'),
      h('button', { class: 'btn', disabled: !!sel.builtin, 'data-tip': 'Remove\nDelete the selected studio light', onclick: () => {
        library.studio = library.studio.filter((s) => s.id !== sel.id);
        selectedStudio = 'default';
        saveStudioLights();
        libraryChanged();
        redraw();
      } }, icon('remove'), 'Remove'),
    ),
    studioEditor(sel, redraw),
  ];
}

function assetGrid(kind: 'matcap' | 'hdri', redraw: () => void): Child {
  const items = kind === 'matcap' ? library.matcaps : library.hdris;
  const sel = kind === 'matcap' ? selectedMatcap : selectedHdri;
  const selDef = items.find((x) => x.id === sel);
  return [
    h(
      'div',
      { class: `studio-grid prefs-grid-lg ${kind === 'matcap' ? 'matcaps' : 'hdris'}` },
      items.map((it) =>
        h(
          'button',
          {
            key: it.id,
            class: { 'studio-cell': true, on: it.id === sel },
            'data-tip': `${it.name}${'builtin' in it && it.builtin ? '\nBuilt in' : ''}`,
            onclick: () => {
              if (kind === 'matcap') selectedMatcap = it.id;
              else selectedHdri = it.id;
              redraw();
            },
          },
          h('img', { src: kind === 'matcap' ? matcapPreview(it as never) : hdriPreview(it as HdriDef), alt: it.name, draggable: 'false' }),
          h('span', { class: 'studio-name' }, it.name),
        ),
      ),
    ),
    h(
      'div',
      { class: 'prefs-btn-row left' },
      h('button', { class: 'btn', onclick: () => app.run(kind === 'matcap' ? 'preferences.studiolight_install_matcap' : 'preferences.studiolight_install_hdri') }, icon('import'), 'Install…'),
      h('button', { class: 'btn', disabled: !selDef || !!(selDef as { builtin?: boolean }).builtin, onclick: () => selDef && void removeEntry(kind, selDef.id).then(redraw) }, icon('remove'), 'Remove'),
    ),
    h('div', { class: 'prefs-note' }, kind === 'matcap' ? 'MatCaps are sphere images: the 3D Viewport’s Solid shading with MatCap lighting looks them up by surface direction. Pick one in the viewport’s Shading popover.' : 'HDRIs light Material Preview when Scene World is off (.hdr, .exr or ordinary images in equirectangular layout). Pick one in the viewport’s Shading popover.'),
  ];
}

registerPrefSection({
  id: 'LIGHTS',
  label: 'Lights',
  group: 0,
  draw: (c) => [
    panel('pf-studio', 'Studio Lights', () => studioPanel(c.redraw)),
    panel('pf-matcaps', 'MatCaps', () => assetGrid('matcap', c.redraw)),
    panel('pf-hdris', 'HDRIs', () => assetGrid('hdri', c.redraw)),
  ],
});

registerOperators([
  {
    idname: 'preferences.studiolight_install_matcap',
    label: 'Install MatCap…',
    description: 'Add a sphere image to the MatCaps of Solid shading',
    undo: false,
    exec: () => {
      void pickFile('image/*').then(async (f) => {
        if (!f) return;
        try {
          await installMatcap(f);
          app.report('INFO', `MatCap "${f.name}" installed`);
        } catch (e) {
          app.report('ERROR', `Could not install ${f.name}: ${(e as Error).message}`);
        }
      });
    },
  },
  {
    idname: 'preferences.studiolight_install_hdri',
    label: 'Install HDRI…',
    description: 'Add an environment image (.hdr, .exr, .png, .jpg) for Material Preview lighting',
    undo: false,
    exec: () => {
      void pickFile('.hdr,.exr,image/*').then(async (f) => {
        if (!f) return;
        try {
          await installHdri(f);
          app.report('INFO', `HDRI "${f.name}" installed`);
        } catch (e) {
          app.report('ERROR', `Could not install ${f.name}: ${(e as Error).message}`);
        }
      });
    },
  },
]);

