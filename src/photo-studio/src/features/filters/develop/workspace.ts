// Develop workspace (Filter > Develop Filter…): a large preview with zoom,
// pan and before/after views, a histogram with clipping warnings, Auto and
// black and white, profiles, and collapsible panels whose eye switches a
// panel's effect off. A tool rail holds the presets list, the white balance
// eyedropper, the Color Mixer's targeted adjustment, zoom and hand.
//
// It is a layout of the filter session: the worker renders a reduced copy
// for the pane while sliders move and the full image afterwards (shown on the
// canvas and reused by OK), so it records into actions, re-opens Live
// Filters and applies like any other filter.
import type { Editor } from '../../../editor';
import { svg } from '../../../app/icons';
import { formatShortcut } from '../../../app/shortcuts';
import { escapeXML } from '../../../model/assets';
import { findLayer, type Blend } from '../../../model/document';
import type { NormPath, ParamValues, RGBA8 } from '../../../imaging/types';
import {
  BANDS,
  PANELS,
  WB_SHIFTS,
  developDefaults,
  developSpec,
  isMonoProfile,
  panelIsDefault,
  type PanelId,
} from '../../../imaging/filters/develop/params';
import { bandWeights, hueOf } from '../../../imaging/filters/develop/color';
import {
  autoTone,
  autoWhiteBalance,
  sampleLinear,
  wbGains,
  whiteBalanceFor,
} from '../../../imaging/filters/develop/auto';
import { sharpenMask } from '../../../imaging/filters/develop/detail';
import { correctLens, opticsActive } from '../../../imaging/filters/develop/optics';
import { geometryActive, transformGeometry } from '../../../imaging/filters/develop/geometry';
import { resolveDevelop } from '../../../imaging/filters/develop/profiles';
import { openWorkspace } from '../../retouch/workspace';
import {
  closeSession,
  commitSession,
  isLiveLayer,
  opLabel,
  openSession,
  sessionEntries,
  type Session,
} from '../apply';
import { commandId, normalizeFor } from '../catalog';
import { Lane, isCancel } from '../client';
import { blendOptions, lastUsed, type DialogOptions } from '../dialog';
import { FilterPreview, type ViewMode } from '../preview';
import { recordStep } from '../record';
import {
  CurveEditor,
  GradeWheel,
  checkHTML,
  clipping,
  drawHistogram,
  formatValue,
  histogramOf,
  hueCSS,
  parseField,
  selectHTML,
  sliderHTML,
  syncControls,
  type CurveChannel,
  type HistInfo,
} from './controls';
import {
  deleteDevelopPreset,
  developLast,
  developPresets,
  presetSettings,
  rememberDevelopLast,
  saveDevelopPreset,
} from './presets';
import { MasksView } from './masks-ui';
import './develop.css';

const OP = 'develop';
type Tool = 'hand' | 'zoom' | 'wb' | 'target';
type MixMode = 'hue' | 'sat' | 'lum';
type GradeRegion = 'Shadow' | 'Midtone' | 'Highlight' | 'Global';
const PANEL_STATE_KEY = 'photo-studio-develop-panels';

function readOpenPanels(): Set<PanelId> {
  try {
    const v = JSON.parse(localStorage.getItem(PANEL_STATE_KEY) ?? 'null');
    if (Array.isArray(v)) return new Set(v.filter((x) => typeof x === 'string') as PanelId[]);
  } catch {
    /* Remembering open panels is a convenience. */
  }
  return new Set<PanelId>(['light', 'color']);
}
function writeOpenPanels(open: Set<PanelId>) {
  try {
    localStorage.setItem(PANEL_STATE_KEY, JSON.stringify([...open]));
  } catch {
    /* Ignore. */
  }
}

const TEMP_TRACK = 'linear-gradient(90deg, #3f7fe0, #d8d8d8, #e8b830)';
const TINT_TRACK = 'linear-gradient(90deg, #3fae4a, #d8d8d8, #c84cc8)';
const bandHueTrack = (h: number) =>
  `linear-gradient(90deg, ${hueCSS(h - 30)}, ${hueCSS(h)}, ${hueCSS(h + 30)})`;
const bandSatTrack = (h: number) => `linear-gradient(90deg, #8a8a8a, ${hueCSS(h, 1, 0.9)})`;
const bandLumTrack = (h: number) =>
  `linear-gradient(90deg, ${hueCSS(h, 0.8, 0.25)}, ${hueCSS(h, 0.6, 1)})`;

/** Open the workspace; resolves true when the filter was applied. */
export async function developWorkspace(e: Editor, opts: DialogOptions): Promise<boolean> {
  let params: ParamValues;
  let blending: { opacity: number; blend: Blend } | undefined;
  if (opts.edit) {
    const l = findLayer(e.doc.layers, opts.edit.layerId);
    const f = isLiveLayer(l) ? l.liveFilters[opts.edit.index] : undefined;
    if (!f) return false;
    params = normalizeFor(OP, f.params);
    blending = { opacity: f.opacity, blend: f.blend };
  } else params = normalizeFor(OP, opts.initial ?? lastUsed.get(OP) ?? developDefaults());
  const s = await openSession(e, OP, params, opts.edit);
  if (!s) return false;
  if (s.live && !blending) blending = { opacity: 1, blend: 'normal' };
  return new DevelopWorkspace(e, s, params, blending, opts).run();
}

class DevelopWorkspace {
  private ws!: ReturnType<typeof openWorkspace>;
  private preview!: FilterPreview;
  private q!: <T extends HTMLElement = HTMLElement>(sel: string) => T;
  private open = readOpenPanels();
  private tool: Tool = 'hand';
  private spaceHeld = false;
  private altPreview?: string;
  private clipShadows = false;
  private clipHighlights = false;
  private hist?: HistInfo;
  private source?: RGBA8;
  private sourceLevel = 0;
  private aux = new Lane('develop-aux');
  private curve!: CurveEditor;
  private wheel!: GradeWheel;
  private mixMode: MixMode = 'hue';
  private gradeRegion: GradeRegion = 'Midtone';
  private side: 'edit' | 'presets' | 'masks' = 'edit';
  private masks!: MasksView;
  private lastColorProfile = 'natural';
  private history: ParamValues[] = [];
  private future: ParamValues[] = [];
  private committed: ParamValues;
  private frame = 0;
  private readonly initial: ParamValues;
  private readonly initialBlending?: { opacity: number; blend: Blend };
  private resolveRun!: (applied: boolean) => void;
  private closed = false;
  private resizer?: ResizeObserver;

  constructor(
    private e: Editor,
    private s: Session,
    private params: ParamValues,
    private blending: { opacity: number; blend: Blend } | undefined,
    private opts: DialogOptions,
  ) {
    this.initial = { ...params };
    this.committed = { ...params };
    this.initialBlending = blending && { ...blending };
    if (!isMonoProfile(params.profile)) this.lastColorProfile = String(params.profile);
  }

  run(): Promise<boolean> {
    const title = `Develop${this.s.live ? ' (Live Filter)' : ''}`;
    this.ws = openWorkspace(title, 'dv-workspace', this.markup());
    this.q = this.ws.q;
    const d = this.ws.dialog;
    d.setAttribute('aria-describedby', 'dv-help');
    this.preview = new FilterPreview(this.s, {
      pane: this.q<HTMLCanvasElement>('.dv-pane'),
      progress: this.q('.dv-progress'),
      zoomLabel: this.q('.dv-zoom-label'),
      proxyLimit: 1600,
      fullDelay: 600,
      adaptive: true,
      overlay: (ctx, w, h, after) => this.overlay(ctx, w, h, after),
      onImage: (img) => this.onImage(img),
      tool: (ev, phase) => this.paneTool(ev, phase),
    });
    this.masks = new MasksView(
      this.q('.dv-masks'),
      {
        params: () => this.params,
        set: (v, done) => this.set(v, done),
        preview: this.preview,
        region: () => this.s.rect,
        status: (t) => this.status(t),
      },
      this.q('.dv-view'),
    );
    this.buildPanels();
    this.bind();
    const view = this.q('.dv-view');
    const fit = () => {
      const r = view.getBoundingClientRect();
      this.preview.resize(r.width, r.height);
    };
    fit();
    this.resizer = new ResizeObserver(() => {
      const wasFit = Math.abs(this.preview.zoom - this.preview.fitZoom()) < 1e-6;
      fit();
      if (wasFit) this.preview.setZoom(this.preview.fitZoom());
    });
    this.resizer.observe(view);
    this.syncAll();
    this.update();
    this.preview.setZoom(this.preview.fitZoom());
    void this.loadSource();
    this.ws.closed.then(() => this.finish(false));
    this.q<HTMLButtonElement>('.dv-ok').focus();
    return new Promise((resolve) => (this.resolveRun = resolve));
  }

  // ---------- Markup ----------
  private markup() {
    const tool = (
      id: Tool | 'edit' | 'presets' | 'masks',
      icon: string,
      label: string,
      key?: string,
    ) =>
      `<button type="button" class="icon-button dv-tool" data-tool="${id}" aria-pressed="false" title="${escapeXML(label)}${key ? ` (${key})` : ''}" aria-label="${escapeXML(label)}"${key ? ` aria-keyshortcuts="${key}"` : ''}>${svg(icon, 18)}</button>`;
    const view = (mode: ViewMode, icon: string, label: string) =>
      `<button type="button" class="icon-button" role="radio" data-view="${mode}" aria-checked="${mode === 'after'}" title="${escapeXML(label)}" aria-label="${escapeXML(label)}">${svg(icon, 16)}</button>`;
    return `<div class="dv-body">
  <section class="dv-stage" aria-label="Preview">
    <div class="dv-view"><canvas class="dv-pane" width="300" height="200" tabindex="0" aria-label="Preview; drag to pan, double-click to switch between fit and 100%"></canvas><div class="dv-progress" hidden><progress max="1" value="0" aria-label="Rendering"></progress><button type="button" class="dv-stop">Stop</button></div></div>
    <div class="dv-stagebar" role="toolbar" aria-label="View">
      <button type="button" class="dv-fit" title="Fit in view (${formatShortcut('Mod+0')})">Fit</button>
      <button type="button" class="dv-actual" title="Actual pixels (${formatShortcut('Mod+1')})">100%</button>
      <button type="button" class="icon-button" data-zoom="-1" title="Zoom out (${formatShortcut('Mod+-')})" aria-label="Zoom out">${svg('zoom-out', 16)}</button>
      <span class="dv-zoom-label" aria-live="polite">100%</span>
      <button type="button" class="icon-button" data-zoom="1" title="Zoom in (${formatShortcut('Mod+=')})" aria-label="Zoom in">${svg('zoom-in', 16)}</button>
      <span class="dv-spacer"></span>
      <span class="dv-pixel" aria-live="off"></span>
      <div class="dv-views" role="radiogroup" aria-label="Before and after (Y cycles, \\ shows the original)">${view('after', 'image', 'Result')}${view('before', 'eye-off', 'Original')}${view('split', 'compare-split', 'Before and after, split')}${view('side', 'compare-side', 'Before and after, side by side')}</div>
    </div>
  </section>
  <aside class="dv-side" aria-label="Settings">
    <div class="dv-hist-wrap">
      <canvas class="dv-hist" width="276" height="88" aria-label="Histogram of the result"></canvas>
      <button type="button" class="dv-clip dv-clip-shadows" aria-pressed="false" title="Show shadow clipping on the preview (U)" aria-label="Shadow clipping warning" aria-keyshortcuts="U"></button>
      <button type="button" class="dv-clip dv-clip-highlights" aria-pressed="false" title="Show highlight clipping on the preview (O)" aria-label="Highlight clipping warning" aria-keyshortcuts="O"></button>
    </div>
    <div class="dv-edit-head">
      <h3>Edit</h3>
      <button type="button" class="dv-auto" title="Set Light from the image's histogram">Auto</button>
      <button type="button" class="dv-bw" aria-pressed="false" title="Convert to black and white (V)" aria-keyshortcuts="V">B&amp;W</button>
    </div>
    <div class="dv-profile">${selectHTML('profile')}<div class="dv-profile-amount">${sliderHTML('profileAmount', { label: 'Amount' })}</div></div>
    <div class="dv-scroll">
      <div class="dv-panels"></div>
      <div class="dv-presets" hidden></div>
      <div class="dv-masks" hidden></div>
      <div class="dv-blending"></div>
    </div>
  </aside>
  <nav class="dv-rail" aria-label="Develop tools">
    ${tool('edit', 'sliders-horizontal', 'Edit')}${tool('masks', 'circle-dashed', 'Masks: local adjustments', 'M')}${tool('presets', 'bookmark', 'Presets', 'Shift+P')}
    <span class="dv-rail-gap"></span>
    ${tool('wb', 'pipette', 'White balance: click a neutral area', 'I')}${tool('target', 'target', 'Targeted adjustment: drag up or down on a color', 'T')}
    <span class="dv-rail-gap"></span>
    ${tool('zoom', 'zoom-in', 'Zoom: click to zoom in, Alt-click to zoom out', 'Z')}${tool('hand', 'hand', 'Hand: drag to pan (hold Space with any tool)', 'H')}
  </nav>
</div>
<p id="dv-help" class="sr-only">Panels hold the settings; each panel's eye button turns its effect off. ${formatShortcut('Mod+Z')} undoes an edit in this window.</p>
<footer class="rw-footer">
  <label class="dv-canvas-toggle" title="Show the result on the canvas behind this window"><input type="checkbox" class="dv-canvas" checked> Preview on canvas</label>
  <button type="button" class="dv-reset-all" title="Reset every setting to its default">Reset All</button>
  <span class="rw-spacer"></span>
  <span class="dv-status" role="status" aria-live="polite"></span>
  <button type="button" class="dv-cancel" title="Alt-click to reset to the settings this window opened with">Cancel</button>
  <button type="button" class="primary dv-ok">OK</button>
</footer>`;
  }

  private panelBody(id: PanelId): string {
    switch (id) {
      case 'light':
        return ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks']
          .map((k) => sliderHTML(k))
          .join('');
      case 'color':
        return `<div class="dv-wb">${selectHTML('whiteBalance')}<button type="button" class="icon-button dv-wb-pick" data-tool="wb" aria-pressed="false" title="White balance eyedropper: click a neutral area (I)" aria-label="White balance eyedropper">${svg('pipette', 16)}</button></div>${sliderHTML('temperature', { track: TEMP_TRACK })}${sliderHTML('tint', { track: TINT_TRACK })}${sliderHTML('vibrance')}${sliderHTML('saturation')}`;
      case 'effects':
        return `${sliderHTML('texture')}${sliderHTML('clarity')}${sliderHTML('dehaze')}<h4>Vignette</h4>${sliderHTML('vignette', { label: 'Amount' })}<div class="dv-sub" data-sub="vignette">${selectHTML('vignetteStyle', 'Style')}${sliderHTML('vignetteMidpoint')}${sliderHTML('vignetteRoundness')}${sliderHTML('vignetteFeather')}</div><h4>Grain</h4>${sliderHTML('grain', { label: 'Amount' })}<div class="dv-sub" data-sub="grain">${sliderHTML('grainSize', { label: 'Size' })}${sliderHTML('grainRoughness', { label: 'Roughness' })}</div>`;
      case 'curve': {
        const ch = (c: CurveChannel | 'param', label: string, cls = '') =>
          `<button type="button" role="radio" class="dv-seg ${cls}" data-curve="${c}" aria-checked="${c === 'param'}" title="${escapeXML(label)}">${c === 'param' ? 'Parametric' : c === 'RGB' ? 'Point' : `<span class="dv-dot ${c.toLowerCase()}"></span><span class="sr-only">${c}</span>`}</button>`;
        return `<div class="dv-segs" role="radiogroup" aria-label="Curve">${ch('param', 'Parametric curve: adjust tonal regions')}${ch('RGB', 'Point curve')}${ch('Red', 'Red channel curve')}${ch('Green', 'Green channel curve')}${ch('Blue', 'Blue channel curve')}</div><canvas class="dv-curve" width="256" height="200"></canvas><div class="dv-curve-param">${sliderHTML('curveHighlights')}${sliderHTML('curveLights')}${sliderHTML('curveDarks')}${sliderHTML('curveShadows')}<h4>Region splits</h4>${sliderHTML('curveSplit1', { label: 'Shadows / darks' })}${sliderHTML('curveSplit2', { label: 'Darks / lights' })}${sliderHTML('curveSplit3', { label: 'Lights / highlights' })}</div><div class="dv-curve-point" hidden><button type="button" class="dv-curve-reset">Reset Curve</button></div>`;
      }
      case 'mixer': {
        const seg = (m: MixMode, label: string) =>
          `<button type="button" role="radio" class="dv-seg" data-mix="${m}" aria-checked="${m === 'hue'}">${label}</button>`;
        return `<div class="dv-mix-color"><div class="dv-segs" role="radiogroup" aria-label="Adjust">${seg('hue', 'Hue')}${seg('sat', 'Saturation')}${seg('lum', 'Luminance')}</div><button type="button" class="icon-button dv-target" data-tool="target" aria-pressed="false" title="Targeted adjustment: drag up or down on a color in the preview (T)" aria-label="Targeted adjustment">${svg('target', 16)}</button>
${BANDS.map((b) => `<div class="dv-mix-row" data-mix-row="hue">${sliderHTML(`hue${b.id}`, { label: b.id, track: bandHueTrack(b.hue) })}</div><div class="dv-mix-row" data-mix-row="sat" hidden>${sliderHTML(`sat${b.id}`, { label: b.id, track: bandSatTrack(b.hue) })}</div><div class="dv-mix-row" data-mix-row="lum" hidden>${sliderHTML(`lum${b.id}`, { label: b.id, track: bandLumTrack(b.hue) })}</div>`).join('')}</div>
<div class="dv-mix-gray" hidden><p class="dv-note">Black and white mix: how bright each color becomes in gray.</p><button type="button" class="icon-button dv-target" data-tool="target" aria-pressed="false" title="Targeted adjustment: drag up or down on a color in the preview (T)" aria-label="Targeted adjustment">${svg('target', 16)}</button>${BANDS.map((b) => sliderHTML(`gray${b.id}`, { label: b.id, track: bandLumTrack(b.hue) })).join('')}</div>`;
      }
      case 'grading': {
        const seg = (r: GradeRegion, label: string) =>
          `<button type="button" role="radio" class="dv-seg" data-grade="${r}" aria-checked="${r === 'Midtone'}">${label}</button>`;
        const wheelRows = (['Shadow', 'Midtone', 'Highlight', 'Global'] as GradeRegion[])
          .map(
            (r) =>
              `<div class="dv-grade-rows" data-grade-rows="${r}" ${r === 'Midtone' ? '' : 'hidden'}>${sliderHTML(`grade${r}Hue`, { label: 'Hue', track: 'linear-gradient(90deg, #e04040, #e0e040, #40e040, #40e0e0, #4040e0, #e040e0, #e04040)' })}${sliderHTML(`grade${r}Sat`, { label: 'Saturation' })}${sliderHTML(`grade${r}Lum`, { label: 'Luminance' })}</div>`,
          )
          .join('');
        return `<div class="dv-segs" role="radiogroup" aria-label="Tonal range">${seg('Shadow', 'Shadows')}${seg('Midtone', 'Midtones')}${seg('Highlight', 'Highlights')}${seg('Global', 'Global')}</div><div class="dv-wheel-wrap"><canvas class="dv-wheel" width="150" height="150" role="slider" aria-label="Color wheel: arrow keys change hue (left, right) and saturation (up, down)"></canvas></div>${wheelRows}${sliderHTML('gradeBlending')}${sliderHTML('gradeBalance')}`;
      }
      case 'detail':
        return `<h4>Sharpening</h4><p class="dv-note">Hold Alt while dragging to see the area or amount affected.</p>${sliderHTML('sharpenAmount', { label: 'Amount' })}${sliderHTML('sharpenRadius')}${sliderHTML('sharpenDetail')}${sliderHTML('sharpenMasking')}<h4>Noise reduction</h4>${sliderHTML('noiseReduction', { label: 'Luminance' })}${sliderHTML('noiseDetail')}${sliderHTML('noiseContrast')}<h4>Color noise</h4>${sliderHTML('colorNoise', { label: 'Color' })}${sliderHTML('colorNoiseDetail')}${sliderHTML('colorNoiseSmoothness')}`;
      case 'optics':
        return `${sliderHTML('lensDistortion')}${sliderHTML('lensVignetting')}${sliderHTML('lensVignettingMidpoint')}${checkHTML('removeCA')}<h4>Defringe</h4>${sliderHTML('defringePurple', { label: 'Purple amount' })}${sliderHTML('defringeGreen', { label: 'Green amount' })}`;
      case 'geometry': {
        const up = (v: string, label: string, title: string) =>
          `<button type="button" role="radio" class="dv-seg" data-upright="${v}" aria-checked="false" title="${escapeXML(title)}">${label}</button>`;
        return `<div class="dv-segs dv-upright" role="radiogroup" aria-label="Upright">${up('off', 'Off', 'No automatic correction')}${up('auto', 'Auto', 'Balanced level and perspective correction')}${up('level', 'Level', 'Level the horizon')}${up('vertical', 'Vertical', 'Level and make verticals parallel')}${up('full', 'Full', 'Level, vertical and horizontal perspective')}</div>${sliderHTML('geoVertical')}${sliderHTML('geoHorizontal')}${sliderHTML('geoRotate')}${sliderHTML('geoAspect')}${sliderHTML('geoScale')}${sliderHTML('geoOffsetX')}${sliderHTML('geoOffsetY')}${checkHTML('geoConstrain')}`;
      }
      case 'masks':
        return '';
      case 'calibration':
        return `${sliderHTML('calShadowTint', { label: 'Shadows tint', track: TINT_TRACK })}<h4>Red primary</h4>${sliderHTML('calRedHue', { label: 'Hue', track: bandHueTrack(0) })}${sliderHTML('calRedSat', { label: 'Saturation', track: bandSatTrack(0) })}<h4>Green primary</h4>${sliderHTML('calGreenHue', { label: 'Hue', track: bandHueTrack(120) })}${sliderHTML('calGreenSat', { label: 'Saturation', track: bandSatTrack(120) })}<h4>Blue primary</h4>${sliderHTML('calBlueHue', { label: 'Hue', track: bandHueTrack(240) })}${sliderHTML('calBlueSat', { label: 'Saturation', track: bandSatTrack(240) })}`;
    }
  }

  private buildPanels() {
    const host = this.q('.dv-panels');
    host.innerHTML = PANELS.filter((p) => p.id !== 'masks')
      .map((p) => {
        const open = this.open.has(p.id);
        return `<section class="dv-panel" data-panel="${p.id}"><div class="dv-panel-head"><button type="button" class="dv-disclose" aria-expanded="${open}" aria-controls="dv-body-${p.id}">${svg(open ? 'chevron-down' : 'chevron-right', 14)}<span>${escapeXML(p.label)}</span><span class="dv-changed" title="Changed from the defaults" hidden></span></button><button type="button" class="icon-button dv-panel-reset" data-panel-reset="${p.id}" title="Reset ${escapeXML(p.label)}" aria-label="Reset ${escapeXML(p.label)}">${svg('rotate-ccw', 14)}</button><button type="button" class="icon-button dv-eye" data-eye="${p.id}" aria-pressed="true" title="Show or hide the ${escapeXML(p.label)} adjustments" aria-label="${escapeXML(p.label)} effect">${svg('eye', 15)}</button></div><div class="dv-panel-body" id="dv-body-${p.id}" ${open ? '' : 'hidden'}>${this.panelBody(p.id)}</div></section>`;
      })
      .join('');
    this.curve = new CurveEditor(
      this.q<HTMLCanvasElement>('.dv-curve'),
      () => this.params,
      (key, v, done) => this.set({ [key]: v }, done),
      (key, v, done) => this.set({ [key]: v }, done),
    );
    this.wheel = new GradeWheel(
      this.q<HTMLCanvasElement>('.dv-wheel'),
      () => ({
        hue: Number(this.params[`grade${this.gradeRegion}Hue`]) || 0,
        sat: Number(this.params[`grade${this.gradeRegion}Sat`]) || 0,
      }),
      (hue, sat, done) =>
        this.set(
          { [`grade${this.gradeRegion}Hue`]: hue, [`grade${this.gradeRegion}Sat`]: sat },
          done,
        ),
    );
    if (this.s.live && this.blending) {
      const b = this.blending;
      this.q('.dv-blending').innerHTML =
        `<h3>Blending</h3><div class="dv-field"><label for="dv-mode">Mode</label><select id="dv-mode">${blendOptions(b.blend)}</select></div><div class="dv-slider"><div class="dv-slider-head"><label for="dv-opacity">Opacity</label><input type="text" inputmode="decimal" id="dv-opacity" class="dv-num" data-min="0" data-max="100" data-step="1" value="${Math.round(b.opacity * 100)}"></div><input type="range" class="dv-range" id="dv-opacity-range" min="0" max="100" value="${Math.round(b.opacity * 100)}" aria-label="Opacity"></div>`;
    }
  }

  // ---------- State ----------
  /** Change settings; `done` ends one edit (an undo step in this window). */
  private set(v: ParamValues, done = true) {
    this.params = { ...this.params, ...v };
    if (('temperature' in v || 'tint' in v) && !('whiteBalance' in v))
      this.params.whiteBalance = 'custom';
    this.syncAll();
    this.schedule();
    if (done) this.commitEdit();
  }
  private commitEdit() {
    if (JSON.stringify(this.committed) === JSON.stringify(this.params)) return;
    this.history.push(this.committed);
    if (this.history.length > 100) this.history.shift();
    this.future = [];
    this.committed = { ...this.params };
  }
  private undo(redo = false) {
    const from = redo ? this.future : this.history,
      to = redo ? this.history : this.future;
    const p = from.pop();
    if (!p) return;
    to.push(this.committed);
    this.params = { ...p };
    this.committed = { ...p };
    this.syncAll();
    this.schedule();
    if (this.side === 'masks') this.masks.render();
    this.status(redo ? 'Redone' : 'Undone');
  }
  private schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }
  private update() {
    if (this.closed) return;
    this.preview.setEntries(sessionEntries(this.s, OP, this.params, this.blending));
  }
  private syncAll() {
    const side = this.q('.dv-side');
    syncControls(side, this.params);
    const mono = isMonoProfile(this.params.profile);
    this.q('.dv-bw').setAttribute('aria-pressed', String(mono));
    this.q('.dv-profile-amount').hidden =
      this.params.profile === 'natural' || this.params.profile === 'mono';
    this.q('.dv-mix-color').hidden = mono;
    this.q('.dv-mix-gray').hidden = !mono;
    for (const p of PANELS) {
      const on = this.params[p.toggle] !== false;
      if (p.id === 'masks') {
        const eye = this.ws.dialog.querySelector<HTMLElement>('[data-eye="masks"]');
        if (eye && eye.getAttribute('aria-pressed') !== String(on)) {
          eye.setAttribute('aria-pressed', String(on));
          eye.innerHTML = svg(on ? 'eye' : 'eye-off', 15);
        }
        continue;
      }
      const sec = this.q(`[data-panel="${p.id}"]`);
      const eye = sec.querySelector<HTMLElement>('.dv-eye')!;
      // Replace the icon only when the state changes: rewriting it between a
      // press and release would lose the click.
      if (eye.getAttribute('aria-pressed') !== String(on)) {
        eye.setAttribute('aria-pressed', String(on));
        eye.innerHTML = svg(on ? 'eye' : 'eye-off', 15);
      }
      sec.classList.toggle('dv-off', !on);
      sec.querySelector<HTMLElement>('.dv-changed')!.hidden = panelIsDefault(this.params, p.id);
    }
    for (const b of this.ws.dialog.querySelectorAll<HTMLElement>('[data-upright]'))
      b.setAttribute('aria-checked', String(b.dataset.upright === this.params.upright));
    for (const [sub, key] of [
      ['vignette', 'vignette'],
      ['grain', 'grain'],
    ])
      this.q(`[data-sub="${sub}"]`).classList.toggle('dv-dim', this.params[key] === 0);
    this.curve?.draw();
    this.wheel?.draw();
  }
  private status(text: string) {
    const el = this.q('.dv-status');
    el.textContent = text;
    window.setTimeout(() => {
      if (el.textContent === text) el.textContent = '';
    }, 2500);
  }

  // ---------- Source copy (Auto, eyedropper, targeted adjustment) ----------
  private async loadSource() {
    const R = this.s.rect;
    let k = 0,
      w = R.width,
      h = R.height;
    while (Math.max(w, h) > 1024 && k < 12) {
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      k++;
    }
    try {
      const res = await this.aux.run(
        {
          type: 'run',
          job: 0,
          key: this.s.key,
          filters: [],
          ctx: { foreground: [0, 0, 0], background: [255, 255, 255] },
          useSelection: false,
          useMask: false,
          view: { level: k, x: 0, y: 0, width: w, height: h },
          output: 'image',
        },
        [this.s.key],
      );
      this.source = res.image;
      this.sourceLevel = k;
    } catch (error) {
      if (!isCancel(error) && !this.closed)
        this.e.message(error instanceof Error ? error.message : String(error));
    }
  }
  private async needSource(): Promise<RGBA8 | undefined> {
    if (!this.source) await this.loadSource();
    return this.source;
  }
  private placed?: { key: string; src: RGBA8; img: RGBA8 };
  /** The source copy where a pick lands: over the result, lens corrections
   * and geometry have moved its pixels before the color work, so the copy
   * is moved the same way (over the original it is used as it is). */
  private async pickSource(after: boolean): Promise<RGBA8 | undefined> {
    const src = await this.needSource();
    if (!src || !after) return src;
    const { params: q } = resolveDevelop(this.params);
    const lens = opticsActive(q),
      geo = geometryActive(q);
    if (!lens && !geo) return src;
    const key = JSON.stringify(
      PANELS.filter((p) => p.id === 'optics' || p.id === 'geometry').flatMap((p) =>
        p.keys.map((k) => q[k]),
      ),
    );
    if (this.placed?.key !== key || this.placed.src !== src) {
      let img = src;
      if (lens) img = correctLens(img, q, 2 ** -this.sourceLevel);
      if (geo) img = transformGeometry(img, q, 2 ** -this.sourceLevel);
      this.placed = { key, src, img };
    }
    return this.placed.img;
  }

  // ---------- Pane ----------
  private onImage(img: RGBA8) {
    this.hist = histogramOf(img);
    drawHistogram(this.q<HTMLCanvasElement>('.dv-hist'), this.hist);
    const c = clipping(this.hist);
    const color = (on: boolean[]) =>
      on.every(Boolean)
        ? '#fff'
        : on.some(Boolean)
          ? `rgb(${on.map((x) => (x ? 230 : 40)).join(' ')})`
          : '';
    this.q('.dv-clip-shadows').style.setProperty('--clip', color(c.shadows) || 'transparent');
    this.q('.dv-clip-highlights').style.setProperty('--clip', color(c.highlights) || 'transparent');
    this.curve.hist = this.hist;
    this.curve.draw();
  }
  private overlay(
    ctx: CanvasRenderingContext2D,
    _w: number,
    h: number,
    after: { x: number; width: number; origin: number },
  ) {
    this.pixelOverlay(ctx, h, after);
    if (this.side === 'masks') this.masks.overlay(ctx, h, after);
  }
  private pixelOverlay(
    ctx: CanvasRenderingContext2D,
    h: number,
    after: { x: number; width: number },
  ) {
    if (after.width <= 0) return;
    const mask = this.altPreview;
    if (!mask && !this.clipShadows && !this.clipHighlights) return;
    const img = ctx.getImageData(after.x, 0, after.width, h),
      d = img.data;
    if (mask === 'sharpenMasking') {
      // Where sharpening applies: white is sharpened fully, black not at all.
      const m = sharpenMask(
        { width: img.width, height: h, data: d },
        this.params,
        this.preview.zoom,
      );
      for (let p = 0, i = 0; p < m.data.length; p++, i += 4)
        if (d[i + 3]) d[i] = d[i + 1] = d[i + 2] = m.data[p];
      ctx.putImageData(img, after.x, 0);
      return;
    }
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      if (mask) {
        const l = (r * 54 + g * 183 + b * 19) >> 8;
        d[i] = d[i + 1] = d[i + 2] = l;
        continue;
      }
      if (this.clipHighlights && (r >= 255 || g >= 255 || b >= 255)) d.set([255, 40, 40], i);
      else if (this.clipShadows && r <= 0 && g <= 0 && b <= 0) d.set([40, 110, 255], i);
      else if (this.clipShadows && (r <= 0 || g <= 0 || b <= 0) && r + g + b < 60)
        d.set([40, 110, 255], i);
    }
    ctx.putImageData(img, after.x, 0);
  }
  private paneTool(ev: PointerEvent, phase: 'down' | 'move' | 'up' | 'hover'): boolean {
    const pane = this.q('.dv-pane');
    const tool = this.spaceHeld ? 'hand' : this.tool;
    if (this.side === 'masks' && !this.spaceHeld && this.masks.pointer(ev, phase)) return true;
    if (phase === 'hover') {
      this.showPixel(ev);
      return false;
    }
    if (tool === 'hand') return false;
    const pt = this.preview.regionPoint(ev.clientX, ev.clientY);
    if (tool === 'zoom') {
      if (phase !== 'down') return true;
      this.zoomAt(pt, ev.altKey ? -1 : 1);
      return true;
    }
    if (tool === 'wb') {
      if (phase === 'down') void this.pickWhite(pt);
      return true;
    }
    // Targeted adjustment.
    if (phase === 'down') {
      void this.startTarget(pt, ev.clientY);
      pane.classList.add('dv-dragging');
      return true;
    }
    if (phase === 'move') this.moveTarget(ev.clientY);
    else {
      pane.classList.remove('dv-dragging');
      this.target = undefined;
      this.commitEdit();
    }
    return true;
  }
  private showPixel(ev: PointerEvent) {
    const pane = this.q<HTMLCanvasElement>('.dv-pane');
    const r = pane.getBoundingClientRect();
    const x = Math.floor(((ev.clientX - r.left) * pane.width) / r.width),
      y = Math.floor(((ev.clientY - r.top) * pane.height) / r.height);
    if (x < 0 || y < 0 || x >= pane.width || y >= pane.height) return;
    const [R, G, B, A] = pane.getContext('2d')!.getImageData(x, y, 1, 1).data;
    this.q('.dv-pixel').textContent = A ? `R ${R}  G ${G}  B ${B}` : '';
  }
  private zoomAt(pt: { x: number; y: number }, dir: 1 | -1) {
    this.preview.focus = { x: pt.x, y: pt.y };
    this.preview.stepZoom(dir);
  }
  private async pickWhite(pt: { x: number; y: number; inside: boolean; after: boolean }) {
    if (!pt.inside) return;
    const src = await this.pickSource(pt.after);
    if (!src) return;
    const f = 2 ** -this.sourceLevel;
    const c = sampleLinear(src, pt.x * f, pt.y * f, 2);
    if (!c) return;
    const Y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    if (Y < 0.01 || Math.max(...c) > 0.98) {
      this.status('Pick a neutral gray area that is neither black nor clipped white.');
      return;
    }
    const wb = whiteBalanceFor(c[0], c[1], c[2]);
    this.set({ ...wb, whiteBalance: 'custom' });
    this.status(
      `White balance: temperature ${formatValue('temperature', wb.temperature)}, tint ${formatValue('tint', wb.tint)}`,
    );
  }
  private target?: { y: number; start: ParamValues; weights: Float64Array; keys: string[] };
  private async startTarget(
    pt: { x: number; y: number; inside: boolean; after: boolean },
    clientY: number,
  ) {
    if (!pt.inside) return;
    const src = await this.pickSource(pt.after);
    if (!src) return;
    const f = 2 ** -this.sourceLevel;
    const c = sampleLinear(src, pt.x * f, pt.y * f, 1);
    if (!c) return;
    const g = wbGains(Number(this.params.temperature) || 0, Number(this.params.tint) || 0);
    const hue = hueOf(c[0] * g[0], c[1] * g[1], c[2] * g[2]);
    const mono = isMonoProfile(this.params.profile);
    const prefix = mono ? 'gray' : this.mixMode;
    // The targeted adjustment works in the Color Mixer: make sure it is visible.
    this.openPanel('mixer', true);
    this.target = {
      y: clientY,
      start: { ...this.params },
      weights: bandWeights(hue),
      keys: BANDS.map((b) => `${prefix}${b.id}`),
    };
  }
  private moveTarget(clientY: number) {
    const t = this.target;
    if (!t) return;
    const delta = (t.y - clientY) * 0.6;
    const v: ParamValues = {};
    t.keys.forEach((k, i) => {
      if (t.weights[i] < 0.02) return;
      v[k] = Math.max(
        -100,
        Math.min(100, Math.round((Number(t.start[k]) || 0) + delta * t.weights[i])),
      );
    });
    this.set(v, false);
  }

  // ---------- Events ----------
  private bind() {
    const d = this.ws.dialog,
      side = this.q('.dv-side');
    // Slider and field edits.
    side.addEventListener('input', (ev) => {
      const t = ev.target as HTMLInputElement;
      const key = t.dataset.key;
      if (t.id === 'dv-opacity-range' || t.id === 'dv-opacity' || t.id === 'dv-mode')
        return this.blendInput(t);
      if (!key) return;
      if (t.type === 'range') this.set({ [key]: Number(t.value) }, false);
    });
    side.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement;
      const key = t.dataset.key;
      if (t.id === 'dv-opacity' || t.id === 'dv-mode') return this.blendInput(t);
      if (!key) return;
      if (ev.target instanceof HTMLSelectElement) this.selectChanged(key, ev.target.value);
      else if (t.type === 'range') this.set({ [key]: Number(t.value) }, true);
      else if (t.type === 'checkbox') this.set({ [key]: t.checked });
      else {
        const v = parseField(t);
        if (v !== undefined) this.set({ [key]: v });
        else syncControls(side, this.params);
      }
    });
    // Arrow keys step the text fields; Enter commits without closing.
    side.addEventListener('keydown', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (!t.classList?.contains('dv-num')) return;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        t.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
      ev.preventDefault();
      const step = (Number(t.dataset.step) || 1) * (ev.shiftKey ? 10 : 1);
      const cur = parseField(t) ?? 0;
      t.value = String(cur + (ev.key === 'ArrowUp' ? step : -step));
      const v = parseField(t);
      if (v === undefined) return;
      if (t.dataset.key) this.set({ [t.dataset.key]: v });
      else this.blendInput(t);
      t.value = t.dataset.key ? formatValue(t.dataset.key, v) : String(v);
    });
    side.addEventListener('dblclick', (ev) => {
      const key = (ev.target as HTMLElement).closest<HTMLElement>('[data-reset]')?.dataset.reset;
      if (!key) return;
      const s = developSpec(key);
      if (s && s.type === 'number') this.set({ [key]: s.default });
    });
    // Alt-dragging a Detail slider previews what it affects.
    side.addEventListener('pointerdown', (ev) => {
      const t = ev.target as HTMLInputElement;
      if (
        ev.altKey &&
        t.type === 'range' &&
        /^(sharpen|noise|colorNoise)/.test(t.dataset.key ?? '')
      ) {
        this.altPreview = t.dataset.key;
        this.preview.draw();
        const up = () => {
          this.altPreview = undefined;
          this.preview.draw();
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointerup', up);
      }
    });
    side.addEventListener('click', (ev) => this.sideClick(ev));
    // Stage.
    d.addEventListener('click', (ev) => {
      const t = ev.target as HTMLElement;
      const z = t.closest<HTMLElement>('[data-zoom]');
      if (z) this.preview.stepZoom(Number(z.dataset.zoom) as 1 | -1);
      const v = t.closest<HTMLElement>('[data-view]');
      if (v) this.setView(v.dataset.view as ViewMode);
      const tool = t.closest<HTMLElement>('[data-tool]');
      if (tool) this.setTool(tool.dataset.tool as Tool | 'edit' | 'presets' | 'masks');
    });
    this.q('.dv-fit').addEventListener('click', () => this.preview.setZoom(this.preview.fitZoom()));
    this.q('.dv-actual').addEventListener('click', () => this.preview.setZoom(1));
    this.q('.dv-pane').addEventListener('dblclick', (ev) => {
      if (this.tool !== 'hand' && !this.spaceHeld) return;
      const fit = this.preview.fitZoom();
      if (Math.abs(this.preview.zoom - fit) < 1e-6)
        (this.zoomAt(this.preview.regionPoint(ev.clientX, ev.clientY), 1), this.preview.setZoom(1));
      else this.preview.setZoom(fit);
    });
    this.q('.dv-stop').addEventListener('click', () => this.preview.cancel());
    this.q('.dv-clip-shadows').addEventListener('click', () => this.toggleClip('shadows'));
    this.q('.dv-clip-highlights').addEventListener('click', () => this.toggleClip('highlights'));
    this.q('.dv-auto').addEventListener('click', () => void this.auto());
    this.q('.dv-bw').addEventListener('click', () => this.toggleMono());
    this.q<HTMLInputElement>('.dv-canvas').addEventListener('change', (ev) =>
      this.preview.setCanvasPreview((ev.target as HTMLInputElement).checked),
    );
    this.q('.dv-reset-all').addEventListener('click', () => {
      this.set({
        ...developDefaults(),
        ...Object.fromEntries(PANELS.map((p) => [p.toggle, true])),
      });
      if (this.side === 'masks') this.masks.render();
      this.status('All settings reset');
    });
    const cancel = this.q<HTMLButtonElement>('.dv-cancel');
    cancel.addEventListener('click', (ev) => {
      if (ev.altKey) {
        this.params = { ...this.initial };
        this.blending = this.initialBlending && { ...this.initialBlending };
        this.syncBlending();
        this.set({});
        if (this.side === 'masks') this.masks.render();
        this.status('Settings restored');
        return;
      }
      this.finish(false);
    });
    this.q('.dv-ok').addEventListener('click', () => void this.ok());
    // Keys.
    d.addEventListener('keydown', (ev) => this.keydown(ev));
    d.addEventListener('keyup', (ev) => {
      if (ev.key === ' ') this.setSpace(false);
      if (ev.key === 'Alt') cancel.textContent = 'Cancel';
    });
    d.addEventListener('keydown', (ev) => {
      if (ev.key === 'Alt') cancel.textContent = 'Reset';
    });
    window.addEventListener('blur', this.onBlur);
  }
  private onBlur = () => {
    this.setSpace(false);
    this.q('.dv-cancel').textContent = 'Cancel';
  };
  private setSpace(on: boolean) {
    this.spaceHeld = on;
    this.q('.dv-pane').classList.toggle('dv-tool-hand', on || this.tool === 'hand');
  }
  private keydown(ev: KeyboardEvent) {
    const t = ev.target as HTMLElement;
    const typing =
      t.tagName === 'INPUT' &&
      (t as HTMLInputElement).type !== 'range' &&
      (t as HTMLInputElement).type !== 'checkbox';
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && !ev.altKey && (ev.key === 'z' || ev.key === 'Z')) {
      if (typing) return;
      ev.preventDefault();
      this.undo(ev.shiftKey);
      return;
    }
    if (
      mod &&
      (ev.key === '0' || ev.key === '1' || ev.key === '=' || ev.key === '+' || ev.key === '-')
    ) {
      ev.preventDefault();
      if (ev.key === '0') this.preview.setZoom(this.preview.fitZoom());
      else if (ev.key === '1') this.preview.setZoom(1);
      else this.preview.stepZoom(ev.key === '-' ? -1 : 1);
      return;
    }
    if (mod || ev.altKey || typing || t.tagName === 'SELECT') return;
    // The curve and wheel take their own keys.
    if (t.classList.contains('dv-curve') || t.classList.contains('dv-wheel')) return;
    const k = ev.key;
    if (k === ' ' && t.tagName !== 'BUTTON') {
      ev.preventDefault();
      this.setSpace(true);
      return;
    }
    const actions: Record<string, () => void> = {
      y: () =>
        this.setView(
          ({ after: 'split', split: 'side', side: 'after', before: 'after' } as const)[
            this.preview.viewMode
          ],
        ),
      '\\': () => this.setView(this.preview.viewMode === 'before' ? 'after' : 'before'),
      u: () => this.toggleClip('shadows'),
      o: () => this.toggleClip('highlights'),
      i: () => this.setTool('wb'),
      t: () => this.setTool('target'),
      z: () => this.setTool('zoom'),
      h: () => this.setTool('hand'),
      v: () => this.toggleMono(),
      P: () => this.setTool('presets'),
      m: () => this.setTool('masks'),
    };
    const fn = actions[ev.shiftKey ? k : k.toLowerCase()];
    if (!fn || (ev.shiftKey && k !== 'P')) return;
    ev.preventDefault();
    fn();
  }
  private sideClick(ev: MouseEvent) {
    const t = ev.target as HTMLElement;
    const disclose = t.closest<HTMLElement>('.dv-disclose');
    if (disclose) {
      const id = disclose.closest<HTMLElement>('[data-panel]')!.dataset.panel as PanelId;
      this.openPanel(id, disclose.getAttribute('aria-expanded') !== 'true');
      return;
    }
    const eye = t.closest<HTMLElement>('[data-eye]');
    if (eye) {
      const p = PANELS.find((x) => x.id === eye.dataset.eye)!;
      this.set({ [p.toggle]: this.params[p.toggle] === false });
      return;
    }
    const reset = t.closest<HTMLElement>('[data-panel-reset]');
    if (reset) {
      const p = PANELS.find((x) => x.id === reset.dataset.panelReset)!;
      const d = developDefaults();
      this.set(Object.fromEntries(p.keys.map((k) => [k, d[k]])));
      this.status(`${p.label} reset`);
      return;
    }
    const curve = t.closest<HTMLElement>('[data-curve]');
    if (curve) {
      const c = curve.dataset.curve!;
      for (const b of this.ws.dialog.querySelectorAll('[data-curve]'))
        b.setAttribute('aria-checked', String(b === curve));
      this.curve.setMode(
        c === 'param' ? 'parametric' : 'point',
        c === 'param' ? 'RGB' : (c as CurveChannel),
      );
      this.q('.dv-curve-param').hidden = c !== 'param';
      this.q('.dv-curve-point').hidden = c === 'param';
      return;
    }
    if (t.closest('.dv-curve-reset')) {
      this.set({ [`curve${this.curve.channel}`]: [] as NormPath[] });
      return;
    }
    const mix = t.closest<HTMLElement>('[data-mix]');
    if (mix) {
      this.mixMode = mix.dataset.mix as MixMode;
      for (const b of this.ws.dialog.querySelectorAll('[data-mix]'))
        b.setAttribute('aria-checked', String(b === mix));
      for (const r of this.ws.dialog.querySelectorAll<HTMLElement>('[data-mix-row]'))
        r.hidden = r.dataset.mixRow !== this.mixMode;
      return;
    }
    const grade = t.closest<HTMLElement>('[data-grade]');
    if (grade) {
      this.gradeRegion = grade.dataset.grade as GradeRegion;
      for (const b of this.ws.dialog.querySelectorAll('[data-grade]'))
        b.setAttribute('aria-checked', String(b === grade));
      for (const r of this.ws.dialog.querySelectorAll<HTMLElement>('[data-grade-rows]'))
        r.hidden = r.dataset.gradeRows !== this.gradeRegion;
      this.wheel.draw();
      return;
    }
    const up = t.closest<HTMLElement>('[data-upright]');
    if (up) {
      this.set({ upright: up.dataset.upright! });
      return;
    }
    // Built-in entries are told apart from saved presets of any name.
    const builtin = t.closest<HTMLElement>('[data-preset-builtin]')?.dataset.presetBuiltin;
    if (builtin === 'defaults' || builtin === 'last') return this.applyBuiltinPreset(builtin);
    const preset = t.closest<HTMLElement>('[data-preset]');
    if (preset) return this.applyPreset(preset.dataset.preset!);
    const del = t.closest<HTMLElement>('[data-preset-delete]');
    if (del) {
      deleteDevelopPreset(del.dataset.presetDelete!);
      this.renderPresets();
      return;
    }
    if (t.closest('.dv-preset-save')) this.savePreset();
  }
  private selectChanged(key: string, value: string) {
    if (key === 'whiteBalance') {
      if (value === 'auto') void this.autoWhite();
      else if (WB_SHIFTS[value]) {
        const [temperature, tint] = WB_SHIFTS[value];
        this.set({ whiteBalance: value, temperature, tint });
      } else this.set({ whiteBalance: value });
      return;
    }
    if (key === 'profile' && !isMonoProfile(value)) this.lastColorProfile = value;
    this.set({ [key]: value });
  }
  private openPanel(id: PanelId, open: boolean) {
    const sec = this.q(`[data-panel="${id}"]`);
    const btn = sec.querySelector<HTMLElement>('.dv-disclose')!;
    btn.setAttribute('aria-expanded', String(open));
    btn.querySelector('svg')!.outerHTML = svg(open ? 'chevron-down' : 'chevron-right', 14);
    sec.querySelector<HTMLElement>('.dv-panel-body')!.hidden = !open;
    if (open) this.open.add(id);
    else this.open.delete(id);
    writeOpenPanels(this.open);
    if (open && id === 'curve') this.curve.draw();
    if (open && id === 'grading') this.wheel.draw();
  }
  private setView(mode: ViewMode) {
    const wasFit = Math.abs(this.preview.zoom - this.preview.fitZoom()) < 1e-6;
    this.preview.setViewMode(mode);
    if (wasFit) this.preview.setZoom(this.preview.fitZoom());
    for (const b of this.ws.dialog.querySelectorAll<HTMLElement>('[data-view]'))
      b.setAttribute('aria-checked', String(b.dataset.view === mode));
  }
  private setTool(tool: Tool | 'edit' | 'presets' | 'masks') {
    if (tool === 'edit' || tool === 'presets' || tool === 'masks') {
      this.side = tool !== 'edit' && this.side !== tool ? tool : 'edit';
      this.q('.dv-panels').hidden = this.side !== 'edit';
      this.q('.dv-presets').hidden = this.side !== 'presets';
      this.q('.dv-masks').hidden = this.side !== 'masks';
      if (this.side === 'presets') this.renderPresets();
      if (this.side === 'masks') this.masks.render();
      else this.masks.hideCursor();
      this.preview.draw();
    } else this.tool = this.tool === tool && tool !== 'hand' ? 'hand' : tool;
    for (const b of this.ws.dialog.querySelectorAll<HTMLElement>('[data-tool]')) {
      const id = b.dataset.tool;
      // In the masks view the pane edits masks, so no pane tool shows as active.
      b.setAttribute(
        'aria-pressed',
        String((id === this.tool && this.side !== 'masks') || id === this.side),
      );
    }
    const pane = this.q('.dv-pane');
    pane.classList.toggle('dv-tool-hand', this.tool === 'hand');
    pane.classList.toggle('dv-tool-zoom', this.tool === 'zoom');
    pane.classList.toggle('dv-tool-pick', this.tool === 'wb' || this.tool === 'target');
    if (this.tool === 'wb') this.status('Click a neutral gray or white area in the preview.');
    if (this.tool === 'target') this.status('Drag up or down on a color in the preview.');
  }
  private toggleClip(which: 'shadows' | 'highlights') {
    if (which === 'shadows') this.clipShadows = !this.clipShadows;
    else this.clipHighlights = !this.clipHighlights;
    this.q(`.dv-clip-${which}`).setAttribute(
      'aria-pressed',
      String(which === 'shadows' ? this.clipShadows : this.clipHighlights),
    );
    this.preview.draw();
  }
  private toggleMono() {
    const mono = isMonoProfile(this.params.profile);
    this.set({ profile: mono ? this.lastColorProfile : 'mono' });
  }
  private async auto() {
    const src = await this.needSource();
    if (!src) return;
    const g = wbGains(Number(this.params.temperature) || 0, Number(this.params.tint) || 0);
    const tone = autoTone(src, g);
    this.set({ ...tone, lightOn: true });
    this.openPanel('light', true);
    this.status('Auto tone applied');
  }
  private async autoWhite() {
    const src = await this.needSource();
    if (!src) return;
    this.set({ ...autoWhiteBalance(src), whiteBalance: 'auto' });
  }
  private blendInput(t: HTMLInputElement | HTMLSelectElement) {
    if (!this.blending) return;
    if (t.id === 'dv-mode') this.blending = { ...this.blending, blend: t.value as Blend };
    else {
      const v = t.id === 'dv-opacity-range' ? Number(t.value) : parseField(t as HTMLInputElement);
      if (v === undefined || !Number.isFinite(v)) return;
      this.blending = { ...this.blending, opacity: Math.max(0, Math.min(100, v)) / 100 };
      this.syncBlending(t.id);
    }
    this.schedule();
  }
  private syncBlending(except?: string) {
    if (!this.blending) return;
    const pct = String(Math.round(this.blending.opacity * 100));
    for (const id of ['dv-opacity', 'dv-opacity-range']) {
      const el = this.ws.dialog.querySelector<HTMLInputElement>(`#${id}`);
      if (el && id !== except) el.value = pct;
    }
    const mode = this.ws.dialog.querySelector<HTMLSelectElement>('#dv-mode');
    if (mode) mode.value = this.blending.blend;
  }

  // ---------- Presets ----------
  private renderPresets() {
    const host = this.q('.dv-presets');
    const user = developPresets();
    const last = developLast();
    host.innerHTML = `<h3>Presets</h3><ul class="dv-preset-list"><li><button type="button" data-preset-builtin="defaults">Defaults</button></li><li><button type="button" data-preset-builtin="last" ${last ? '' : 'disabled'} title="The settings last applied with OK">Last Used</button></li></ul><h4>Saved</h4>${user.length ? `<ul class="dv-preset-list">${user.map((p) => `<li><button type="button" data-preset="${escapeXML(p.name)}">${escapeXML(p.name)}</button><button type="button" class="icon-button" data-preset-delete="${escapeXML(p.name)}" title="Delete ${escapeXML(p.name)}" aria-label="Delete preset ${escapeXML(p.name)}">${svg('trash-2', 14)}</button></li>`).join('')}</ul>` : '<p class="dv-note">No saved presets yet.</p>'}<div class="dv-preset-new"><label for="dv-preset-name">Save current settings as</label><div class="dv-preset-row"><input type="text" id="dv-preset-name" maxlength="80" placeholder="Preset name" autocomplete="off"><button type="button" class="dv-preset-save">Save</button></div></div>`;
    host.querySelector<HTMLInputElement>('#dv-preset-name')!.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      this.savePreset();
    });
  }
  private applyBuiltinPreset(which: 'defaults' | 'last') {
    const last = which === 'last' ? developLast() : undefined;
    const p = which === 'defaults' ? developDefaults() : last && presetSettings(last);
    if (!p) return;
    this.set(p);
    this.status(`Applied ${which === 'defaults' ? 'Defaults' : 'Last Used'}`);
  }
  private applyPreset(name: string) {
    const found = developPresets().find((x) => x.name === name);
    if (!found) return;
    this.set(presetSettings(found.params));
    this.status(`Applied ${name}`);
  }
  private savePreset() {
    const input = this.ws.dialog.querySelector<HTMLInputElement>('#dv-preset-name');
    const name = saveDevelopPreset(input?.value ?? '', this.params);
    if (!name) {
      input?.focus();
      this.status('Type a name for the preset.');
      return;
    }
    this.renderPresets();
    this.status(`Saved preset “${name}”`);
  }

  // ---------- Finish ----------
  private async ok() {
    const ok = this.q<HTMLButtonElement>('.dv-ok');
    if (ok.disabled) return;
    ok.disabled = true;
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.update();
    }
    try {
      const grid = await this.preview.finish();
      if (this.closed) return;
      const params = { ...this.params };
      commitSession(this.s, grid, OP, params, opLabel(OP), this.blending);
      lastUsed.set(OP, params);
      rememberDevelopLast(params);
      if (!this.opts.edit && this.opts.record !== false)
        recordStep(this.e, commandId(OP), { params });
      this.finish(true);
    } catch (error) {
      ok.disabled = false;
      if (!isCancel(error)) this.e.message(error instanceof Error ? error.message : String(error));
    }
  }
  private finish(applied: boolean) {
    if (this.closed) return;
    this.closed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    window.removeEventListener('blur', this.onBlur);
    this.resizer?.disconnect();
    this.preview.dispose(applied);
    this.aux.dispose();
    closeSession(this.s);
    this.ws.close();
    this.e.update();
    this.resolveRun(applied);
  }
}
