// File → New: a window with preset categories (recently used settings,
// saved presets and common sizes), a details pane for every document
// setting, and saving the current settings as a preset.
import './new-document.css';
import type { Editor } from '../../editor';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';
import { newDocument, type PhotoDocument } from '../../model/document';
import { newPixelLayer } from '../../model/pixel-layer';
import { gridFromImage } from '../../model/tiles';
import { makeBackground } from '../../model/housekeeping';
import { createArtboard } from '../../model/artboard';
import {
  CATEGORIES,
  defaultSpec,
  documentBytes,
  fromPixels,
  PRESETS,
  presetPpi,
  specFromPreset,
  specPixels,
  UNITS,
  validSpec,
  type DocPreset,
  type DocSpec,
  type NewCategory,
  type NewUnit,
} from '../../model/document-presets';
import { builtinAspects } from '../view-modes';
import { hexRgb } from '../pixels';
import { formDialog } from '../../ui/dialog';
import { emitAppEvent } from '../../app/app-events';
import { loadError } from '../../app/lazy';

const RECENT_KEY = 'photo-studio-new-recent';
const SAVED_KEY = 'photo-studio-new-presets';
type Saved = DocSpec & { id: string; title: string };

function readList<T>(key: string, valid: (v: unknown) => T | undefined): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(v) ? v.map(valid).filter((x): x is T => !!x) : [];
  } catch {
    return [];
  }
}
function writeList(key: string, list: unknown[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* Optional. */
  }
}
const validSaved = (v: unknown): Saved | undefined => {
  const s = validSpec(v);
  const r = v as Partial<Saved>;
  return s && typeof r.id === 'string' && typeof r.title === 'string' ? { ...s, id: r.id, title: r.title.slice(0, 80) } : undefined;
};
export const recentSpecs = () => readList(RECENT_KEY, validSpec);
const savedPresets = () => readList(SAVED_KEY, validSaved);
function rememberSpec(spec: DocSpec) {
  const key = (s: DocSpec) => `${s.width}|${s.height}|${s.unit}|${s.ppi}|${s.ppiUnit}|${s.mode}|${s.background}|${s.artboards}`;
  const list = [spec, ...recentSpecs().filter((s) => key(s) !== key(spec))].slice(0, 12);
  writeList(RECENT_KEY, list);
}

const unitShort: Record<NewUnit, string> = { px: 'px', in: 'in', cm: 'cm', mm: 'mm', pt: 'pt', pica: 'pc', col: 'col' };
const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
const sizeLabel = (w: number, h: number, unit: NewUnit) => `${fmt(w)} × ${fmt(h)} ${unitShort[unit]}`;
const bytesLabel = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Create a document from a spec in a new tab (or the empty workspace). */
export async function createDocument(e: Editor, spec: DocSpec) {
  const cols = e.preferences;
  const size = specPixels(spec, cols);
  if (size.error) throw new Error(size.error);
  const { width, height } = size;
  const doc: PhotoDocument = newDocument(width, height, spec.name.trim() || 'Untitled');
  const ppi = spec.ppiUnit === 'ppcm' ? spec.ppi * 2.54 : spec.ppi;
  if (Math.abs(ppi - 72) > 1e-6 || spec.ppiUnit === 'ppcm') {
    const unit = spec.ppiUnit === 'ppcm' ? 'PPCM' : 'PPI';
    const len = spec.ppiUnit === 'ppcm' ? 'Centimeters' : 'Inches';
    doc.resolution = { horizontalResolution: spec.ppi, horizontalResolutionUnit: unit, widthUnit: len, verticalResolution: spec.ppi, verticalResolutionUnit: unit, heightUnit: len };
  }
  if (Math.abs(spec.pixelAspect - 1) > 1e-6) doc.pixelAspect = spec.pixelAspect;
  const s = e.sessionForOpen();
  await e.renderer?.settle();
  s.history.reset(doc);
  const fill =
    spec.background === 'transparent' ? null : hexRgb(spec.background === 'white' ? '#ffffff' : spec.background === 'black' ? '#000000' : spec.background === 'background' ? e.background : spec.color);
  if (spec.artboards) {
    // One artboard covering the canvas; its background is the chosen contents.
    const content = newPixelLayer('Layer 1', doc);
    const a = createArtboard(doc, { x: 0, y: 0, width, height }, fill ? { background: 'custom', color: `#${fill.map((v) => v.toString(16).padStart(2, '0')).join('')}` } : { background: 'transparent' }, 'Artboard 1');
    a.children = [content];
    s.history.reset({ ...doc, layers: [a] });
    e.selected = content.id;
  } else if (fill) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set([fill[0], fill[1], fill[2], 255], i);
    const bg = newPixelLayer('Background', doc, gridFromImage(s.assets.tiles, { width, height, data }));
    makeBackground(bg);
    s.history.reset({ ...doc, layers: [bg] });
    e.selected = bg.id;
  } else {
    const l = newPixelLayer('Layer 1', doc);
    s.history.reset({ ...doc, layers: [l] });
    e.selected = l.id;
  }
  s.hasDocument = true;
  s.saved = undefined;
  // Color profile and mode are applied to the new state, which then becomes
  // the start of the document's history.
  if (spec.profile !== 'working' || spec.mode !== 'rgb') {
    const settled = s.doc;
    if (spec.profile !== 'working') {
      const { profileBase64 } = await import('../color/profiles');
      const d = structuredClone(settled);
      if (spec.profile === 'untagged') d.iccUntaggedProfile = true;
      else d.iccProfile = profileBase64(spec.profile);
      s.history.reset(d);
    }
    if (spec.mode !== 'rgb') {
      e.fit();
      e.update();
      const { convertToMode } = await import('../color/lazy');
      await convertToMode(e, spec.mode);
      s.history.reset(e.doc);
    }
  }
  rememberSpec(spec);
  e.fit();
  e.update();
  void emitAppEvent('new-document', s);
}

/** The New Document window. Resolves after a document is created or the window closes. */
export function newDocumentWindow(e: Editor): Promise<boolean> {
  e.root.querySelector('dialog.newdoc-window')?.remove();
  const prefs = e.preferences;
  let spec: DocSpec = { ...(recentSpecs()[0] ?? defaultSpec()), name: 'Untitled' };
  let category: NewCategory = recentSpecs().length ? 'recent' : 'photo';
  let selected = '';
  const d = document.createElement('dialog');
  d.className = 'newdoc-window';
  d.setAttribute('aria-label', 'New Document');
  d.innerHTML = `<div class="newdoc-head"><h2>New Document</h2><div class="newdoc-tabs" role="tablist" aria-label="Preset categories">${CATEGORIES.map(([id, l]) => `<button type="button" role="tab" data-cat="${id}">${escapeXML(l)}</button>`).join('')}</div></div>
<div class="newdoc-body"><div class="newdoc-presets" role="tabpanel"></div>
<form class="newdoc-details" novalidate>
<div class="newdoc-title"><label class="newdoc-name"><span>Preset details</span><input name="name" aria-label="Name" autocomplete="off" spellcheck="false"></label><button type="button" class="icon-button" data-save-preset title="Save these settings as a preset" aria-label="Save preset">${svg('bookmark', 16)}</button></div>
<div class="newdoc-pair"><label><span>Width</span><input name="width" type="number" min="0.001" step="any"></label><label><span>Units</span><select name="unit" aria-label="Units">${UNITS.map(([u, l]) => `<option value="${u}">${l}</option>`).join('')}</select></label></div>
<div class="newdoc-pair"><label><span>Height</span><input name="height" type="number" min="0.001" step="any"></label><div class="newdoc-orient"><span>Orientation</span><div class="segmented" role="group" aria-label="Orientation"><button type="button" data-orient="portrait" title="Portrait" aria-label="Portrait">${svg('smartphone', 15)}</button><button type="button" data-orient="landscape" title="Landscape" aria-label="Landscape"><span class="rot">${svg('smartphone', 15)}</span></button></div></div></div>
<label class="newdoc-check"><input type="checkbox" name="artboards"><span>Artboards</span></label>
<div class="newdoc-pair"><label><span>Resolution</span><input name="ppi" type="number" min="1" max="10000" step="any" aria-label="Resolution"></label><label><span>&nbsp;</span><select name="ppiUnit" aria-label="Resolution units"><option value="ppi">Pixels/Inch</option><option value="ppcm">Pixels/Centimeter</option></select></label></div>
<div class="newdoc-pair"><label><span>Color mode</span><select name="mode" aria-label="Color mode"><option value="rgb">RGB Color</option><option value="cmyk">CMYK Color</option><option value="grayscale">Grayscale</option><option value="lab">Lab Color</option></select></label><label><span>Depth</span><select name="depth" aria-label="Bit depth" title="New documents are 8 bits per channel; open a 16 or 32-bit file to edit at high depth"><option value="8">8 bit</option></select></label></div>
<div class="newdoc-pair"><label><span>Background contents</span><select name="background" aria-label="Background contents"><option value="white">White</option><option value="black">Black</option><option value="background">Background Color</option><option value="transparent">Transparent</option><option value="custom">Custom…</option></select></label><label class="newdoc-color"><span>Color</span><input type="color" name="color" aria-label="Custom background color"></label></div>
<details class="newdoc-advanced"><summary>Advanced options</summary>
<label><span>Color profile</span><select name="profile" aria-label="Color profile"><option value="working">Working space</option></select></label>
<label><span>Pixel aspect ratio</span><select name="pixelAspect" aria-label="Pixel aspect ratio">${builtinAspects.map((a) => `<option value="${a.ratio}">${escapeXML(a.label)}</option>`).join('')}</select></label>
</details>
<p class="newdoc-summary" aria-live="polite"></p>
</form></div>
<div class="newdoc-foot"><span class="newdoc-error" role="alert"></span><button type="button" data-cancel>Cancel</button><button type="button" class="primary" data-create>Create</button></div>`;
  e.root.append(d);
  const form = d.querySelector<HTMLFormElement>('form')!;
  const field = <T extends HTMLInputElement | HTMLSelectElement>(name: string) => form.elements.namedItem(name) as T;
  const grid = d.querySelector<HTMLElement>('.newdoc-presets')!;

  // Profile choices load with the color engine.
  void import('../color/profiles').then(({ colorSettings, profileChoices, profileName }) => {
    const sel = field<HTMLSelectElement>('profile');
    const fill = () => {
      const s = colorSettings();
      const opts: [string, string][] =
        spec.mode === 'rgb'
          ? [['working', `Working RGB: ${profileName(s.rgb)}`], ['untagged', 'Don’t color manage'], ...profileChoices('RGB')]
          : [['working', `Working ${spec.mode === 'cmyk' ? `CMYK: ${profileName(s.cmyk)}` : spec.mode === 'grayscale' ? `Gray: ${profileName(s.gray)}` : 'Lab'}`]];
      sel.innerHTML = opts.map(([v, l]) => `<option value="${escapeXML(v)}">${escapeXML(l)}</option>`).join('');
      sel.value = opts.some(([v]) => v === spec.profile) ? spec.profile : 'working';
      sel.disabled = opts.length < 2;
    };
    fill();
    form.addEventListener('change', (ev) => {
      if ((ev.target as HTMLElement).getAttribute('name') === 'mode') fill();
    });
  }).catch((error) => {
    // Offline: the document is created in the working space; say why the
    // other profiles are missing instead of failing silently.
    const shown = loadError(error);
    e.message(shown instanceof Error ? shown.message : String(shown));
  });

  function presetCard(id: string, name: string, w: number, h: number, unit: NewUnit, ppi: number, extra = '', removable = false, bg = 'white') {
    const ratio = w / h;
    const bw = ratio >= 1 ? 44 : Math.max(10, 44 * ratio),
      bh = ratio >= 1 ? Math.max(10, 44 / ratio) : 44;
    return `<div class="newdoc-card ${selected === id ? 'selected' : ''}" role="button" tabindex="0" data-preset="${escapeXML(id)}" aria-pressed="${selected === id}"><span class="newdoc-shape"><span class="bg-${bg === 'black' ? 'black' : bg === 'transparent' ? 'transparent' : 'white'}" style="width:${bw}px;height:${bh}px"></span></span><strong>${escapeXML(name)}</strong><small>${escapeXML(sizeLabel(w, h, unit))} @ ${fmt(ppi)} ppi${extra}</small>${removable ? `<button type="button" class="icon-button newdoc-remove" data-remove="${escapeXML(id)}" title="Delete preset" aria-label="Delete preset ${escapeXML(name)}">${svg('trash-2', 13)}</button>` : ''}</div>`;
  }
  function renderPresets() {
    d.querySelectorAll<HTMLElement>('[data-cat]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.cat === category)));
    let html = '';
    if (category === 'recent') {
      const list = recentSpecs();
      html = list.length ? list.map((s, i) => presetCard(`recent-${i}`, s.artboards ? 'Artboard' : 'Recently used', s.width, s.height, s.unit, s.ppi, '', false, s.background)).join('') : '<p class="newdoc-empty">Settings you create documents with appear here.</p>';
    } else if (category === 'saved') {
      const list = savedPresets();
      html = list.length ? list.map((s) => presetCard(s.id, s.title, s.width, s.height, s.unit, s.ppi, '', true, s.background)).join('') : `<p class="newdoc-empty">Save the settings on the right as a preset with ${svg('bookmark', 13)}.</p>`;
    } else html = PRESETS.filter((p) => p.category === category).map((p) => presetCard(p.id, p.name, p.width, p.height, p.unit, presetPpi(p, prefs), p.pixelAspect ? ` · ${fmt(p.pixelAspect)} aspect` : '', false, p.background)).join('');
    grid.innerHTML = `<div class="newdoc-grid">${html}</div>`;
  }
  function writeForm() {
    field<HTMLInputElement>('name').value = spec.name;
    field<HTMLInputElement>('width').value = fmt(spec.width);
    field<HTMLInputElement>('height').value = fmt(spec.height);
    field<HTMLSelectElement>('unit').value = spec.unit;
    field<HTMLInputElement>('ppi').value = fmt(spec.ppi);
    field<HTMLSelectElement>('ppiUnit').value = spec.ppiUnit;
    field<HTMLSelectElement>('mode').value = spec.mode;
    field<HTMLSelectElement>('background').value = spec.background;
    field<HTMLInputElement>('color').value = spec.color;
    field<HTMLInputElement>('artboards').checked = spec.artboards;
    const aspect = field<HTMLSelectElement>('pixelAspect');
    const match = builtinAspects.find((a) => Math.abs(a.ratio - spec.pixelAspect) < 1e-4);
    aspect.value = String(match?.ratio ?? 1);
    labels();
  }
  // Width and height fields name their unit (also their accessible names).
  function labels() {
    const u = unitShort[spec.unit];
    field<HTMLInputElement>('width').setAttribute('aria-label', `Width (${u})`);
    field<HTMLInputElement>('height').setAttribute('aria-label', `Height (${u})`);
    d.querySelector<HTMLElement>('.newdoc-color')!.hidden = spec.background !== 'custom';
    d.querySelectorAll<HTMLElement>('[data-orient]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.orient === 'landscape') === spec.width >= spec.height)));
    const size = specPixels(spec, prefs);
    d.querySelector('.newdoc-summary')!.textContent = size.error ? '' : `${size.width} × ${size.height} pixels · ${bytesLabel(documentBytes(size.width, size.height, spec.mode))}`;
    d.querySelector('.newdoc-error')!.textContent = size.error ?? '';
    d.querySelector<HTMLButtonElement>('[data-create]')!.disabled = !!size.error;
  }
  function readForm() {
    const num = (n: string) => Number(field<HTMLInputElement>(n).value);
    spec = {
      ...spec,
      name: field<HTMLInputElement>('name').value,
      width: num('width'),
      height: num('height'),
      ppi: num('ppi'),
      ppiUnit: field<HTMLSelectElement>('ppiUnit').value === 'ppcm' ? 'ppcm' : 'ppi',
      mode: field<HTMLSelectElement>('mode').value as DocSpec['mode'],
      background: field<HTMLSelectElement>('background').value as DocSpec['background'],
      color: field<HTMLInputElement>('color').value,
      artboards: field<HTMLInputElement>('artboards').checked,
      profile: field<HTMLSelectElement>('profile').value || 'working',
      pixelAspect: Number(field<HTMLSelectElement>('pixelAspect').value) || 1,
    };
  }
  function choose(id: string) {
    selected = id;
    let next: DocSpec | undefined;
    if (id.startsWith('recent-')) next = recentSpecs()[Number(id.slice(7))];
    else next = savedPresets().find((s) => s.id === id) ?? (PRESETS.find((p) => p.id === id) ? specFromPreset(PRESETS.find((p) => p.id === id) as DocPreset, prefs, spec) : undefined);
    if (next) spec = { ...spec, ...next, name: spec.name, profile: next.profile ?? spec.profile, mode: next.mode ?? spec.mode };
    writeForm();
    renderPresets();
  }

  return new Promise((resolve) => {
    const close = (created: boolean) => {
      d.close();
      d.remove();
      resolve(created);
    };
    d.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const cat = t.closest<HTMLElement>('[data-cat]')?.dataset.cat as NewCategory | undefined;
      if (cat) {
        category = cat;
        renderPresets();
        return;
      }
      const remove = t.closest<HTMLElement>('[data-remove]')?.dataset.remove;
      if (remove) {
        writeList(SAVED_KEY, savedPresets().filter((s) => s.id !== remove));
        renderPresets();
        return;
      }
      const card = t.closest<HTMLElement>('[data-preset]')?.dataset.preset;
      if (card) return choose(card);
      const orient = t.closest<HTMLElement>('[data-orient]')?.dataset.orient;
      if (orient) {
        readForm();
        if ((orient === 'landscape') !== spec.width >= spec.height) spec = { ...spec, width: spec.height, height: spec.width };
        writeForm();
        return;
      }
      if (t.closest('[data-save-preset]')) {
        readForm();
        void formDialog('Save Document Preset', [{ name: 'title', label: 'Preset name', value: sizeLabel(spec.width, spec.height, spec.unit) }], 'Save Preset').then((v) => {
          if (!v?.title.trim()) return;
          const id = `saved-${crypto.randomUUID()}`;
          writeList(SAVED_KEY, [...savedPresets(), { ...spec, id, title: v.title.trim() }]);
          category = 'saved';
          selected = id;
          renderPresets();
        });
        return;
      }
      if (t.closest('[data-cancel]')) return close(false);
      if (t.closest('[data-create]')) {
        readForm();
        if (specPixels(spec, prefs).error) return labels();
        close(true);
        void e.run(() => createDocument(e, spec));
      }
    });
    d.addEventListener('keydown', (ev) => {
      const card = (ev.target as HTMLElement).closest<HTMLElement>('[data-preset]');
      if (card && (ev.key === 'Enter' || ev.key === ' ')) {
        ev.preventDefault();
        choose(card.dataset.preset!);
      } else if (ev.key === 'Enter' && (ev.target as HTMLElement).matches('input')) {
        ev.preventDefault();
        d.querySelector<HTMLButtonElement>('[data-create]')!.click();
      }
    });
    d.addEventListener('dblclick', (ev) => {
      if ((ev.target as HTMLElement).closest('[data-preset]')) d.querySelector<HTMLButtonElement>('[data-create]')!.click();
    });
    form.addEventListener('input', (ev) => {
      const name = (ev.target as HTMLElement).getAttribute('name');
      if (name === 'unit') return;
      readForm();
      if (name !== 'name') selected = '';
      labels();
    });
    form.addEventListener('change', (ev) => {
      const t = ev.target as HTMLSelectElement;
      if (t.name === 'unit') {
        // Changing units keeps the physical size.
        const ppi = spec.ppiUnit === 'ppcm' ? spec.ppi * 2.54 : spec.ppi;
        const px = specPixels(spec, prefs);
        const unit = t.value as NewUnit;
        spec = { ...spec, unit, width: fromPixels(px.width, unit, ppi, prefs), height: fromPixels(px.height, unit, ppi, prefs) };
        writeForm();
        return;
      }
      readForm();
      labels();
    });
    d.addEventListener('cancel', (ev) => {
      ev.preventDefault();
      close(false);
    });
    writeForm();
    renderPresets();
    d.showModal();
    field<HTMLInputElement>('name').select();
  });
}
