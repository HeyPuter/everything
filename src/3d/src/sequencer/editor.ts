// Video Sequencer editor (SEQUENCE_EDITOR): view types Sequencer / Preview / Sequencer & Preview,
// with toolbar, channel region, strip timeline (ruler, markers, playhead), sidebar and footer.
import { h, patch, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, type ChangeKind } from '../app/app';
import type { Area, Editor } from '../ui/screen';
import { openMenu, openPopover, type MenuItem } from '../ui/menu';
import { checkbox, enumMenu, enumRow, numberField } from '../ui/widgets';
import { menuButton } from '../animation/animeditor';
import { playbackFooter } from '../animation/footer';
import { frameStep } from '../animation/view2d';
import type { Strip } from './types';
import { MAX_CHANNELS } from './types';
import * as S from './strips';
import { seqEditor, seqList, seqChannels, hasEditor, activeStrip, setActive, isLocked, toolSettings, sceneFps, type SeqEditorLike, type SeqRegion, type ViewType } from './context';
import { T, stripColor, cssColor, typeColor } from './theme';
import { selectStrip, deselectAll, renameChannel } from './ops';
import { startSlide, startSlip, startRetimingKeyMove } from './transform';
import { startPreviewTransform, setCursorPoint, pivotPoint } from './pvtransform';
import { pivotItems, PIVOT_ICONS } from './previewops';
import { retimable, segmentSpeed, mapContent } from './retime';
import { addMenu, viewMenu, selectMenu, stripMenu, imageMenu, contextMenu, markerMenu } from './menus';
import { stripTab, modifiersTab, cacheTab, viewTab, previewGuidePanels } from './sidebar';
import { PreviewRegion, overlayRefFrame, type PreviewSize } from './preview';
import { soundNow, soundPeaks, PEAKS_PER_SECOND, movieThumb, imageNow } from './media';
import { addFiles } from './add';
import { restartPlayback } from './audio';
import { drawShape, type SelectShape } from './shapes';
import type { ScopeMode } from './scopes';
import { lastOpPanel } from '../ui/redo';
import { formats } from '../io/files';
import { readySource } from '../tracking/source';
import { clipFrameToSourceIndex } from '../tracking/types';
import { boxHit, rectCircle, rectLasso, sameTime, neighbor } from './selection';
import { connectedOf, isConnected } from './connect';
import { keysOf, keyValue, fadeProp } from './fades';
import { keyFrames, KEY_PATHS } from './stripanim';
import { editedText, endTextEdit, startTextEdit, hitsText, indexAt, textEdit } from './textedit';
import { prevWord, nextWord } from './textcursor';
import { navGizmo2D } from '../render/final/navgizmo2d';
import { annotatePointerDown, annotateKeyHeld, annotateModeOf, annotateToolSlot, annotationsPanel, isAnnotateTool, type AnnotateTool } from '../mask/annotate2d';

export const RULER_H = 22;
export const MARKER_H = 22;
const FONT = '11px Inter, system-ui, sans-serif';

type Tool = 'select_box' | 'select_circle' | 'select_lasso' | 'blade' | 'slip';
type PreviewTool = 'select' | 'select_circle' | 'select_lasso' | 'cursor' | 'sample' | 'move' | 'rotate' | 'scale' | 'transform' | AnnotateTool;

/** Variants of the select tool slot (box / circle / lasso). */
const SELECT_VARIANTS = [
  { id: 'box', label: 'Select Box', icon: 'select_box', tip: 'Select strips by clicking or dragging a box' },
  { id: 'circle', label: 'Select Circle', icon: 'select_circle', tip: 'Select strips by painting over them with a circle' },
  { id: 'lasso', label: 'Select Lasso', icon: 'select_lasso', tip: 'Select strips inside a drawn shape' },
] as const;
type SelectVariant = (typeof SELECT_VARIANTS)[number]['id'];
const timelineTool = (v: SelectVariant): Tool => (v === 'box' ? 'select_box' : v === 'circle' ? 'select_circle' : 'select_lasso');
const previewTool = (v: SelectVariant): PreviewTool => (v === 'box' ? 'select' : v === 'circle' ? 'select_circle' : 'select_lasso');
const variantOf = (t: string): SelectVariant | null => (t === 'select_box' || t === 'select' ? 'box' : t === 'select_circle' ? 'circle' : t === 'select_lasso' ? 'lasso' : null);

const VIEWS: { value: ViewType; label: string; icon: string }[] = [
  { value: 'SEQUENCER', label: 'Sequencer', icon: 'seq_sequencer' },
  { value: 'PREVIEW', label: 'Preview', icon: 'seq_preview' },
  { value: 'SEQUENCER_PREVIEW', label: 'Sequencer & Preview', icon: 'seq_splitview' },
];

function div(cls: string) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

export class SequencerEditor implements Editor, SeqEditorLike {
  readonly isSequencer = true as const;
  el: HTMLElement;
  view: ViewType = 'SEQUENCER';
  hover: SeqRegion | null = null;
  // timeline view
  x0 = -10;
  ppf = 6;
  /** channel value at the bottom edge of the strip area */
  cy0 = 0.6;
  chH = 56;
  chWidth = 168;
  private fitted = false;
  // regions & options
  showSidebar = false;
  sidebarTab = 'strip';
  showToolbar = true;
  tool: Tool = 'select_box';
  pvTool: PreviewTool = 'select';
  private lastAnnotate: AnnotateTool = 'annotate';
  showSeconds = true;
  showMarkers = true;
  showWaveforms = true;
  showThumbnails = true;
  showOverlays = true;
  showStripName = true;
  showStripSource = true;
  showStripDuration = true;
  showOffsets = false;
  /** timeline overlays: grid lines, colour tags, retiming keys, keyframes / fade curves */
  showGrid = true;
  showColorTags = true;
  showRetiming = true;
  showFcurves = true;
  /** timeline: the frames in the Final cache */
  showCache = false;
  /** sound strips: waveforms of all strips, of none, or as each strip says; full or half height */
  waveformType: 'ALL_WAVEFORMS' | 'NO_WAVEFORMS' | 'DEFAULT_WAVEFORMS' = 'DEFAULT_WAVEFORMS';
  waveformStyle: 'FULL_WAVEFORMS' | 'HALF_WAVEFORMS' = 'FULL_WAVEFORMS';
  splitRatio = 0.55;
  invalid = new Set<Strip>();
  snapLines: number[] = [];
  private hoverStrip: Strip | null = null;
  private hoverHandle: 'LEFT' | 'RIGHT' | null = null;
  boxRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  shape: SelectShape | null = null;
  circleRadius = 25;
  private lastSelect: SelectVariant = 'box';
  /** clip frames already asked for (timeline thumbnails of clip strips) */
  private clipThumbRequests = new Set<string>();
  private disposed = false;

  private bodyEl: HTMLElement;
  private leftEl: HTMLElement;
  private pvWrap: HTMLElement;
  private pvToolbar: HTMLElement;
  private grip: HTMLElement;
  private tlWrap: HTMLElement;
  private toolbarEl: HTMLElement;
  private chEl: HTMLElement;
  private mainEl: HTMLElement;
  private canvas: HTMLCanvasElement;
  /** Adjust Last Operation panel (bottom left of the timeline) */
  private redoEl: HTMLElement;
  private sbEl: HTMLElement;
  private footerEl: HTMLElement;
  preview: PreviewRegion;
  /** navigation buttons of the preview (Ctrl `) */
  private pvNav: HTMLElement;
  showGizmo = true;

  constructor(
    public area: Area,
    state?: unknown,
  ) {
    this.el = div('seq-ed');
    this.bodyEl = div('seq-body');
    this.leftEl = div('seq-left');
    this.pvWrap = div('seq-pvwrap');
    this.pvToolbar = div('seq-toolbar seq-pv-toolbar');
    this.preview = new PreviewRegion(() => this.drawSidebarIfCache());
    this.pvNav = div('seq-pv-nav');
    this.pvWrap.append(this.preview.el, this.pvToolbar, this.pvNav);
    this.grip = div('seq-split-grip');
    this.tlWrap = div('seq-tlwrap');
    this.toolbarEl = div('seq-toolbar');
    this.chEl = div('seq-ch');
    this.mainEl = div('seq-main');
    this.canvas = document.createElement('canvas');
    this.redoEl = div('seq-redo');
    this.mainEl.append(this.canvas, this.redoEl);
    this.tlWrap.append(this.toolbarEl, this.chEl, this.mainEl);
    this.leftEl.append(this.pvWrap, this.grip, this.tlWrap);
    this.sbEl = div('seq-sb anim-sb');
    this.bodyEl.append(this.leftEl, this.sbEl);
    this.footerEl = div('seq-footer anim-footer area-header');
    this.el.append(this.bodyEl, this.footerEl);
    this.restore(state);
    this.bind();
    new ResizeObserver(() => !this.disposed && this.redraw()).observe(this.mainEl);
    this.layout();
  }

  // ------------------------------------------------------------------ state

  serialize(): unknown {
    return {
      view: this.view,
      x0: this.x0,
      ppf: this.ppf,
      cy0: this.cy0,
      chH: this.chH,
      chWidth: this.chWidth,
      showSidebar: this.showSidebar,
      sidebarTab: this.sidebarTab,
      showToolbar: this.showToolbar,
      tool: this.tool,
      pvTool: this.pvTool,
      showSeconds: this.showSeconds,
      showMarkers: this.showMarkers,
      showWaveforms: this.showWaveforms,
      showThumbnails: this.showThumbnails,
      showOverlays: this.showOverlays,
      showStripName: this.showStripName,
      showStripSource: this.showStripSource,
      showStripDuration: this.showStripDuration,
      showOffsets: this.showOffsets,
      showGrid: this.showGrid,
      showColorTags: this.showColorTags,
      showRetiming: this.showRetiming,
      showFcurves: this.showFcurves,
      showCache: this.showCache,
      waveformType: this.waveformType,
      waveformStyle: this.waveformStyle,
      splitRatio: this.splitRatio,
      previewSize: this.preview.size,
      previewOverlays: { ...this.preview.opts },
      previewGuides: { ...this.preview.composition },
      displayChannel: this.preview.displayChannel,
      scopeMode: this.preview.scopeMode,
      fitted: this.fitted,
    };
  }

  private restore(state: unknown) {
    const s = (state ?? {}) as Record<string, unknown>;
    if (s.view === 'PREVIEW' || s.view === 'SEQUENCER_PREVIEW' || s.view === 'SEQUENCER') this.view = s.view;
    for (const k of ['x0', 'ppf', 'cy0', 'chH', 'chWidth', 'splitRatio'] as const) if (typeof s[k] === 'number') (this as Record<string, unknown>)[k] = s[k];
    for (const k of ['showSidebar', 'showToolbar', 'showSeconds', 'showMarkers', 'showWaveforms', 'showThumbnails', 'showOverlays', 'fitted', 'showStripName', 'showStripSource', 'showStripDuration', 'showOffsets', 'showGrid', 'showColorTags', 'showRetiming', 'showFcurves', 'showCache'] as const) if (typeof s[k] === 'boolean') (this as Record<string, unknown>)[k] = s[k];
    if (s.waveformType === 'ALL_WAVEFORMS' || s.waveformType === 'NO_WAVEFORMS' || s.waveformType === 'DEFAULT_WAVEFORMS') this.waveformType = s.waveformType;
    if (s.waveformStyle === 'HALF_WAVEFORMS' || s.waveformStyle === 'FULL_WAVEFORMS') this.waveformStyle = s.waveformStyle;
    if (typeof s.sidebarTab === 'string') this.sidebarTab = s.sidebarTab;
    if (['blade', 'slip', 'select_box', 'select_circle', 'select_lasso'].includes(s.tool as string)) this.tool = s.tool as Tool;
    if (['select', 'select_circle', 'select_lasso', 'cursor', 'sample', 'move', 'rotate', 'scale', 'transform'].includes(s.pvTool as string) || isAnnotateTool(String(s.pvTool))) this.pvTool = s.pvTool as PreviewTool;
    if (typeof s.previewSize === 'string') this.preview.size = s.previewSize as PreviewSize;
    if (s.previewOverlays && typeof s.previewOverlays === 'object') Object.assign(this.preview.opts, s.previewOverlays);
    if (s.previewGuides && typeof s.previewGuides === 'object') Object.assign(this.preview.composition, s.previewGuides);
    if (typeof s.displayChannel === 'number') this.preview.displayChannel = s.displayChannel;
    if (['IMAGE', 'HISTOGRAM', 'WAVEFORM', 'VECTOR_SCOPE'].includes(s.scopeMode as string)) this.preview.scopeMode = s.scopeMode as ScopeMode;
    this.preview.showOverlays = this.showOverlays;
  }

  get keymaps(): string[] {
    if (this.hover === 'preview') return ['SequencerPreview', 'SequencerCommon'];
    if (this.hover === 'channels') return ['Sequencer Channels', 'SequencerCommon'];
    return ['Sequencer', 'SequencerCommon'];
  }

  // ------------------------------------------------------------------ layout

  private hasTimeline() {
    return this.view !== 'PREVIEW';
  }
  private hasPreview() {
    return this.view !== 'SEQUENCER';
  }

  layout() {
    const tl = this.hasTimeline(),
      pv = this.hasPreview();
    this.tlWrap.hidden = !tl;
    this.pvWrap.hidden = !pv;
    this.grip.hidden = !(tl && pv);
    if (tl && pv) {
      this.pvWrap.style.flex = `${this.splitRatio} 1 0`;
      this.tlWrap.style.flex = `${1 - this.splitRatio} 1 0`;
    } else {
      this.pvWrap.style.flex = '1 1 0';
      this.tlWrap.style.flex = '1 1 0';
    }
    this.toolbarEl.hidden = !this.showToolbar;
    this.pvToolbar.hidden = !this.showToolbar || !pv;
    this.chEl.style.width = `${this.chWidth}px`;
    this.sbEl.hidden = !this.showSidebar;
    this.footerEl.hidden = !tl;
  }

  setView(v: ViewType) {
    if (this.view === v) return;
    this.view = v;
    this.layout();
    this.refresh();
    this.preview.request();
    app.changed('ui');
  }

  toggleOverlays() {
    this.showOverlays = !this.showOverlays;
    this.preview.showOverlays = this.showOverlays;
    this.redraw();
    this.preview.draw();
    app.changed('ui');
  }

  toggleSidebar() {
    this.showSidebar = !this.showSidebar;
    this.layout();
    this.refresh();
  }

  toggleToolbar() {
    this.showToolbar = !this.showToolbar;
    this.layout();
    this.refresh();
  }

  // ------------------------------------------------------------------ Editor

  update(kinds?: Set<ChangeKind>) {
    if (this.disposed) return;
    this.refresh();
    // an edit changes the composited result: cached frames are stale
    if (!kinds || kinds.has('doc') || kinds.has('geometry') || kinds.has('mode')) this.preview.clearFinalCache();
    if (!kinds || kinds.has('doc') || kinds.has('frame') || kinds.has('geometry') || kinds.has('mode')) this.preview.request();
    else this.preview.draw();
  }

  resize() {
    this.redraw();
    this.preview.draw();
  }

  dispose() {
    this.disposed = true;
    this.preview.dispose();
  }

  refresh() {
    if (this.disposed) return;
    this.layout();
    this.drawToolbars();
    this.drawChannels();
    this.redraw();
    this.drawSidebar();
    if (this.hasTimeline()) {
      patch(this.footerEl, playbackFooter());
      const last = app.lastOp;
      const ours = !!last && (last.idname.startsWith('sequencer.') || last.idname === 'transform.seq_slide' || (last.idname === 'transform.transform' && last.props.mode === 'TIME_EXTEND'));
      patch(this.redoEl, ours ? lastOpPanel(this) : null);
    }
  }

  redraw() {
    this.draw();
  }

  requestPreview() {
    this.preview.request();
  }

  // ------------------------------------------------------------------ header

  header(): Child {
    const cur = VIEWS.find((v) => v.value === this.view)!;
    const tl = this.hasTimeline();
    const ts = toolSettings();
    const snap = app.doc.scene.tool_settings.use_snap_sequencer ?? true;
    const meta = hasEditor() ? seqEditor().meta_stack : [];
    return h(
      'div',
      { class: 'hdr-row seq-hdr' },
      h(
        'button',
        {
          key: 'view',
          class: 'hdr-mode',
          'data-tip': 'View Type\nType of the Sequencer view (sequencer, preview or both)',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(VIEWS.map((v) => ({ label: v.label, icon: v.icon, active: v.value === this.view, action: () => this.setView(v.value) })), e.currentTarget as HTMLElement);
          },
        },
        icon(cur.icon),
        cur.label,
        icon('down_arrow_hlt', 'tiny'),
      ),
      menuButton('View', () => viewMenu(this as never)),
      menuButton('Select', () => selectMenu(!tl)),
      tl ? menuButton('Marker', markerMenu) : null,
      tl ? menuButton('Add', addMenu) : null,
      menuButton('Strip', () => stripMenu(!tl)),
      menuButton('Image', imageMenu),
      meta.length
        ? h(
            'button',
            { key: 'meta', class: 'hdr-menu seq-meta-crumb', 'data-tip': 'Exit Meta Strip (Tab)', onclick: () => app.run('sequencer.meta_toggle') },
            icon('seq_meta'),
            meta.join(' › '),
          )
        : null,
      h('div', { class: 'hdr-spacer' }),
      tl
        ? enumMenu(
            'seq-overlap',
            [
              { value: 'OVERWRITE', label: 'Overwrite', description: 'Trim or split strips to resolve overlap' },
              { value: 'EXPAND', label: 'Expand', description: 'Shift strips so they don’t overlap' },
              { value: 'SHUFFLE', label: 'Shuffle', description: 'Move transformed strips to nearest free space to avoid overlap' },
            ],
            ts.overlap_mode,
            (v) => ((ts.overlap_mode = v as 'SHUFFLE'), app.pushUndo('Overlap Mode'), app.changed('ui')),
            { className: 'seq-overlap', tip: 'Overlap Mode\nHow to resolve overlap after transformation' },
          )
        : null,
      h(
            'div',
            { class: 'hdr-group', key: 'snap' },
            h('button', { class: { 'hdr-toggle': true, on: snap }, 'data-tip': 'Snap\nSnap strips during transform (Shift Tab)', onclick: () => ((app.doc.scene.tool_settings.use_snap_sequencer = !snap), app.changed('ui')) }, icon(snap ? 'snap_on' : 'snap_off')),
            h(
              'button',
              {
                class: 'hdr-icondrop',
                'data-tip': 'Snapping',
                onpointerdown: (e: PointerEvent) => {
                  e.preventDefault();
                  openPopover(e.currentTarget as HTMLElement, () => this.snapPopover(), { width: 240 });
                },
              },
              icon('down_arrow_hlt', 'tiny'),
            ),
          ),
      this.hasPreview()
        ? enumMenu(
            'seq-scope',
            [
              { value: 'IMAGE', label: 'Image Preview', icon: 'image', description: 'Show the image' },
              { value: 'HISTOGRAM', label: 'Histogram', icon: 'seq_histogram', description: 'Show the distribution of red, green and blue values' },
              { value: 'WAVEFORM', label: 'Luma Waveform', icon: 'seq_luma_waveform', description: 'Show the brightness of each image column' },
              { value: 'VECTOR_SCOPE', label: 'Chroma Vectorscope', icon: 'seq_chroma_scope', description: 'Show the hue and saturation of the pixels' },
            ],
            this.preview.scopeMode,
            (v) => ((this.preview.scopeMode = v as ScopeMode), this.preview.draw(), app.changed('ui')),
            { iconOnly: true, tip: 'Display Mode\nShow the image or a scope of it' },
          )
        : null,
      this.hasPreview()
        ? h(
            'button',
            {
              key: 'pivot',
              class: 'hdr-icondrop seq-pivot',
              'data-tip': 'Pivot Point\nCenter of rotation and scaling in the preview (.)',
              onpointerdown: (e: PointerEvent) => {
                e.preventDefault();
                openMenu(pivotItems(), e.currentTarget as HTMLElement);
              },
            },
            icon(PIVOT_ICONS[pivotPoint()]),
            icon('down_arrow_hlt', 'tiny'),
          )
        : null,
      h(
        'div',
        { class: 'hdr-group', key: 'overlay' },
        h('button', { class: { 'hdr-toggle': true, on: this.showOverlays }, 'data-tip': 'Show Overlays (Shift Alt Z)', onclick: () => this.toggleOverlays() }, icon('overlay')),
        h(
          'button',
          {
            class: 'hdr-icondrop',
            'data-tip': 'Overlays',
            onpointerdown: (e: PointerEvent) => {
              e.preventDefault();
              openPopover(e.currentTarget as HTMLElement, () => this.overlayPopover(), { width: 240 });
            },
          },
          icon('down_arrow_hlt', 'tiny'),
        ),
      ),
    );
  }

  private snapPopover(): Child {
    const ts = toolSettings();
    const t = (key: 'snap_to_current_frame' | 'snap_to_markers' | 'snap_ignore_muted' | 'snap_ignore_sound', label: string) =>
      checkbox(`seq-snap-${key}`, label, ts[key], (v) => ((ts[key] = v), app.pushUndo('Snapping'), app.changed('ui')));
    const pt = (key: 'snap_to_borders' | 'snap_to_center' | 'snap_to_strips_preview', label: string) =>
      checkbox(`seq-snap-${key}`, label, ts[key] !== false, (v) => ((ts[key] = v), app.pushUndo('Snapping'), app.changed('ui')));
    return h(
      'div',
      { class: 'pop-panel' },
      this.hasPreview() ? [h('div', { class: 'pop-title' }, 'Preview Snapping'), pt('snap_to_borders', 'Borders'), pt('snap_to_center', 'Center'), pt('snap_to_strips_preview', 'Other Strips')] : null,
      this.hasTimeline() ? this.timelineSnap(t, ts) : null,
    );
  }

  private timelineSnap(t: (key: 'snap_to_current_frame' | 'snap_to_markers' | 'snap_ignore_muted' | 'snap_ignore_sound', label: string) => Child, ts: ReturnType<typeof toolSettings>): Child {
    return h(
      'div',
      null,
      h('div', { class: 'pop-title' }, 'Sequencer Snapping'),
      h('div', { class: 'pop-label' }, 'Snap to'),
      t('snap_to_current_frame', 'Current Frame'),
      t('snap_to_markers', 'Markers'),
      h('div', { class: 'pop-label' }, 'Ignore'),
      t('snap_ignore_muted', 'Muted Strips'),
      t('snap_ignore_sound', 'Sound Strips'),
      h('div', { class: 'pop-label' }, 'Current Frame'),
      checkbox('seq-snap-playhead', 'Snap to Strips', !!ts.use_snap_current_frame_to_strips, (v) => ((ts.use_snap_current_frame_to_strips = v), app.pushUndo('Snapping'), app.changed('ui'))),
      numberField({ id: 'seq-snap-dist', label: 'Snapping Distance', value: ts.snap_distance, int: true, min: 1, max: 100, unit: 'pixel', set: (v, f) => ((ts.snap_distance = v), f && app.pushUndo('Snapping Distance')) }),
    );
  }

  private overlayPopover(): Child {
    type Flag = 'showStripName' | 'showStripSource' | 'showStripDuration' | 'showWaveforms' | 'showThumbnails' | 'showOffsets' | 'showGrid' | 'showColorTags' | 'showRetiming' | 'showFcurves' | 'showCache';
    const t = (key: Flag, label: string) => checkbox(`seq-ov-${key}`, label, this[key], (v) => ((this[key] = v), this.redraw(), app.changed('ui')));
    const o = this.preview.opts;
    const pt = (key: keyof typeof o, label: string) => checkbox(`seq-pov-${key}`, label, o[key], (v) => ((o[key] = v), this.preview.draw(), app.changed('ui')));
    const two = (a: Child, b: Child) => h('div', { class: 'seq-ov-cols' }, h('div', null, a), h('div', null, b));
    const ed = hasEditor() ? seqEditor() : null;
    return h(
      'div',
      { class: 'pop-panel' },
      this.hasPreview()
        ? [
            h('div', { class: 'pop-title' }, 'Preview Overlays'),
            two(
              [
                pt('outline', 'Image Outline'),
                ed ? checkbox('seq-pov-frame', 'Frame Overlay', !!ed.show_overlay_frame, (v) => ((ed.show_overlay_frame = v), app.pushUndo('Frame Overlay'), app.changed('doc'))) : null,
                checkbox('seq-pov-ann', 'Annotations', this.preview.showAnnotations, (v) => ((this.preview.showAnnotations = v), this.preview.draw(), app.changed('ui'))),
              ],
              [pt('cursor', '2D Cursor'), pt('safeAreas', 'Safe Areas'), pt('guides', 'Guides')],
            ),
          ]
        : null,
      this.hasTimeline()
        ? [
            h('div', { class: 'pop-title' }, 'Sequencer Overlays'),
            two(t('showGrid', 'Grid'), t('showCache', 'Cache')),
            h('div', { class: 'pop-title' }, 'Strips'),
            two([t('showStripName', 'Name'), t('showStripSource', 'Source'), t('showStripDuration', 'Duration'), t('showFcurves', 'Animation Curves')], [t('showColorTags', 'Color Tags'), t('showOffsets', 'Offsets'), t('showRetiming', 'Retiming')]),
            h('div', { class: 'pop-title' }, 'Thumbnails'),
            t('showThumbnails', 'Thumbnails'),
            h('div', { class: 'pop-title' }, 'Waveforms'),
            enumRow(
              'seq-ov-wtype',
              [
                { value: 'ALL_WAVEFORMS', label: 'On', description: 'Show the waveform of every sound strip' },
                { value: 'DEFAULT_WAVEFORMS', label: 'Strip', description: 'Show waveforms as each strip says' },
                { value: 'NO_WAVEFORMS', label: 'Off', description: 'Show no waveforms' },
              ],
              this.waveformType,
              (v) => ((this.waveformType = v as 'ALL_WAVEFORMS'), this.redraw(), app.changed('ui')),
            ),
            enumRow(
              'seq-ov-wstyle',
              [
                { value: 'FULL_WAVEFORMS', label: 'Full', description: 'The waveform around the middle of the strip' },
                { value: 'HALF_WAVEFORMS', label: 'Half', description: 'The level of the sound from the bottom of the strip' },
              ],
              this.waveformStyle,
              (v) => ((this.waveformStyle = v as 'FULL_WAVEFORMS'), this.redraw(), app.changed('ui')),
            ),
          ]
        : null,
    );
  }

  // ------------------------------------------------------------------ toolbars, channels, sidebar

  /** The preview's zoom / pan buttons. */
  private drawPreviewNav() {
    const pv = this.preview;
    const host = {
      el: pv.el,
      zoomAt: (f: number, x?: number, y?: number) => {
        const r = pv.el.getBoundingClientRect();
        pv.zoomAt(f, r.left + (x ?? r.width / 2), r.top + (y ?? r.height / 2));
        pv.request();
      },
      panBy: (dx: number, dy: number) => {
        pv.panX += dx;
        pv.panY += dy;
        pv.fitted = false;
        pv.draw();
      },
    };
    patch(this.pvNav, [navGizmo2D(host, 0, this.showGizmo && pv.scopeMode === 'IMAGE')]);
  }

  private drawToolbars() {
    this.drawPreviewNav();
    if (this.preview.transformCage !== (this.pvTool === 'transform')) {
      this.preview.transformCage = this.pvTool === 'transform';
      this.preview.draw();
    }
    const tb = (key: string, ic: string, on: boolean, tip: string, set: () => void) => h('button', { key, class: { 'tb-tool': true, on }, 'data-tip': tip, onclick: () => (set(), this.drawToolbars(), app.changed('ui')) }, icon(ic));
    // the select slot shows its current variant; right click, double click or a long press picks another
    const selectSlot = (key: string, cur: string, setTool: (v: SelectVariant) => void) => {
      const v = variantOf(cur);
      const shown = SELECT_VARIANTS.find((x) => x.id === (v ?? this.lastSelect)) ?? SELECT_VARIANTS[0];
      const pick = (el: HTMLElement) =>
        openMenu(
          SELECT_VARIANTS.map((x) => ({ label: x.label, icon: x.icon, active: x.id === v, action: () => ((this.lastSelect = x.id), setTool(x.id), this.drawToolbars(), app.changed('ui')) })),
          el,
        );
      return h(
        'button',
        {
          key,
          class: { 'tb-tool': true, on: !!v, 'has-alt': true },
          'data-tool': `${key}-${shown.id}`,
          'data-tip': `${shown.label}\n${shown.tip}`,
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            const el = e.currentTarget as HTMLElement;
            if (e.button === 2 || e.detail > 1) return pick(el);
            setTool(shown.id);
            this.drawToolbars();
            app.changed('ui');
            const timer = setTimeout(() => pick(el), 350);
            const up = () => {
              clearTimeout(timer);
              removeEventListener('pointerup', up);
            };
            addEventListener('pointerup', up);
          },
        },
        icon(shown.icon),
      );
    };
    patch(this.toolbarEl, [
      selectSlot('select', this.tool, (v) => (this.tool = timelineTool(v))),
      tb('blade', 'seq_blade', this.tool === 'blade', 'Blade\nClick to split strips at a frame; drag a box to cut out a section (Shift keeps the gap)', () => (this.tool = 'blade')),
      tb('slip', 'seq_slip', this.tool === 'slip', 'Slip\nSlip the content of a strip under its handles', () => (this.tool = 'slip')),
    ]);
    patch(this.pvToolbar, [
      selectSlot('pselect', this.pvTool, (v) => (this.pvTool = previewTool(v))),
      tb('pcursor', 'cursor', this.pvTool === 'cursor', 'Cursor\nPlace the 2D cursor (pivot for transforms); drag to move it', () => (this.pvTool = 'cursor')),
      h('div', { key: 'sep', class: 'tb-sep' }),
      tb('pmove', 'transform_move', this.pvTool === 'move', 'Move\nMove the selected strips’ images', () => (this.pvTool = 'move')),
      tb('prot', 'transform_rotate', this.pvTool === 'rotate', 'Rotate\nRotate the selected strips’ images', () => (this.pvTool = 'rotate')),
      tb('pscale', 'transform_scale', this.pvTool === 'scale', 'Scale\nScale the selected strips’ images', () => (this.pvTool = 'scale')),
      tb('ptransform', 'transform', this.pvTool === 'transform', 'Transform\nDrag inside the frame around the selected images to move them, a corner to scale, outside to rotate', () => (this.pvTool = 'transform')),
      h('div', { key: 'sep2', class: 'tb-sep' }),
      tb('psample', 'eyedropper', this.pvTool === 'sample', 'Sample\nShow the colour of the pixel under the pointer while the button is held', () => (this.pvTool = 'sample')),
      h('div', { key: 'sep3', class: 'tb-sep' }),
      annotateToolSlot(this.pvTool, this.lastAnnotate, (t) => ((this.pvTool = t), (this.lastAnnotate = t), this.drawToolbars(), app.changed('ui'))),
    ]);
  }

  /** Visible channel range of the timeline. */
  private visibleChannels(): [number, number] {
    const H = this.contentBottom() - RULER_H;
    const lo = Math.max(1, Math.floor(this.cy0));
    const hi = Math.min(MAX_CHANNELS, Math.ceil(this.cy0 + H / this.chH));
    return [lo, hi];
  }

  drawChannels() {
    if (!this.hasTimeline()) return;
    const chans = hasEditor() ? seqChannels() : null;
    const [lo, hi] = this.visibleChannels();
    const rows: Child[] = [];
    const cb = this.contentBottom();
    for (let c = lo; c <= hi; c++) {
      const ch = chans?.[c];
      const name = ch?.name ?? `Channel ${c}`;
      const muted = !!ch?.mute,
        locked = !!ch?.lock;
      const top = cb - (c - this.cy0 + 1) * this.chH;
      rows.push(
        h(
          'div',
          {
            key: `ch${c}`,
            class: { 'seq-ch-row': true, alt: c % 2 === 0 },
            style: { top: `${top}px`, height: `${this.chH}px` },
            ondblclick: () => renameChannel(c),
            onpointerdown: (e: PointerEvent) => {
              if ((e.ctrlKey || e.metaKey) && e.button === 0) renameChannel(c);
            },
          },
          h('span', { class: 'seq-ch-name' }, name),
          h(
            'button',
            {
              class: { 'seq-ch-tg': true, off: muted },
              'data-tip': 'Mute channel',
              onclick: () => this.toggleChannel(c, 'mute'),
            },
            icon(muted ? 'checkbox_dehlt' : 'checkbox_hlt'),
          ),
          h(
            'button',
            {
              class: { 'seq-ch-tg': true, on: locked },
              'data-tip': 'Lock channel',
              onclick: () => this.toggleChannel(c, 'lock'),
            },
            icon(locked ? 'locked' : 'unlocked'),
          ),
        ),
      );
    }
    patch(this.chEl, h('div', { class: 'seq-ch-inner' }, h('div', { class: 'seq-ch-top', style: { height: `${RULER_H}px` } }), rows));
  }

  private toggleChannel(c: number, key: 'mute' | 'lock') {
    const chans = seqChannels();
    chans[c][key] = !chans[c][key];
    app.pushUndo(key === 'mute' ? 'Mute Channel' : 'Lock Channel');
    app.changed('doc');
    if (key === 'mute') restartPlayback();
  }

  private drawSidebarIfCache() {
    if (this.showSidebar && this.sidebarTab === 'cache') this.drawSidebar();
  }

  drawSidebar() {
    if (!this.showSidebar) return;
    const tabs = [
      { id: 'strip', label: 'Strip', draw: stripTab },
      { id: 'modifiers', label: 'Modifiers', draw: modifiersTab },
      {
        id: 'view',
        label: 'View',
        draw: () =>
          hasEditor()
            ? [
                viewTab(),
                this.hasPreview() ? previewGuidePanels(this.preview, () => (this.preview.draw(), this.drawSidebar(), app.changed('ui'))) : null,
                this.hasPreview() ? annotationsPanel('seq', this.preview) : null,
              ]
            : h('div', { class: 'sb-empty' }, 'No sequence editor'),
      },
      { id: 'cache', label: 'Proxy & Cache', draw: () => cacheTab({ previewSize: this.preview.size, renderMs: this.preview.renderMs, scale: this.preview.scale }) },
    ];
    const tab = tabs.find((t) => t.id === this.sidebarTab) ?? tabs[0];
    patch(this.sbEl, [
      h('div', { key: 'body', class: 'sb-body' }, tab.draw()),
      h(
        'div',
        { key: 'tabs', class: 'sb-tabs' },
        tabs.map((t) => h('button', { key: t.id, class: { 'sb-tab': true, on: t.id === tab.id }, onclick: () => ((this.sidebarTab = t.id), this.drawSidebar()) }, t.label)),
      ),
    ]);
  }

  // ------------------------------------------------------------------ geometry

  get W() {
    return this.mainEl.clientWidth;
  }
  get H() {
    return this.mainEl.clientHeight;
  }
  markersVisible() {
    return this.showMarkers && app.doc.scene.timeline_markers.length > 0;
  }
  contentBottom() {
    return this.H - (this.markersVisible() ? MARKER_H : 0);
  }
  fx(frame: number) {
    return (frame - this.x0) * this.ppf;
  }
  xf(x: number) {
    return x / this.ppf + this.x0;
  }
  /** y of the bottom edge of a channel row */
  chBottom(ch: number) {
    return this.contentBottom() - (ch - this.cy0) * this.chH;
  }
  local(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  pointerFrame(clientX: number) {
    return this.xf(clientX - this.canvas.getBoundingClientRect().left);
  }
  pointerChannel(clientY: number) {
    const y = clientY - this.canvas.getBoundingClientRect().top;
    return this.cy0 + (this.contentBottom() - y) / this.chH;
  }

  stripRect(s: Strip) {
    const pad = Math.max(1, Math.min(4, this.chH * 0.07));
    const bottom = this.chBottom(s.channel) - pad;
    const top = this.chBottom(s.channel) - this.chH + pad;
    return { x0: this.fx(S.finalStart(s)), x1: this.fx(S.finalEnd(s)), y0: top, y1: bottom };
  }

  private handleWidth(r: { x0: number; x1: number }) {
    return Math.max(2, Math.min(8, (r.x1 - r.x0) / 4));
  }

  hitTest(x: number, y: number): { strip: Strip; handle: 'LEFT' | 'RIGHT' | null } | null {
    if (!hasEditor()) return null;
    const list = seqList();
    for (const s of [...list].reverse()) {
      const r = this.stripRect(s);
      if (y < r.y0 || y > r.y1) continue;
      if (x < r.x0 - 2 || x > r.x1 + 2) continue;
      const hw = this.handleWidth(r);
      const handles = !S.inputCount(s.type);
      if (handles && x <= r.x0 + hw) return { strip: s, handle: 'LEFT' };
      if (handles && x >= r.x1 - hw) return { strip: s, handle: 'RIGHT' };
      return { strip: s, handle: null };
    }
    return null;
  }

  pickStrip(clientX: number, clientY: number): Strip | null {
    if (this.hover === 'preview') return this.preview.stripAt(clientX, clientY);
    const { x, y } = this.local({ clientX, clientY });
    return y > RULER_H ? (this.hitTest(x, y)?.strip ?? null) : null;
  }

  // ------------------------------------------------------------------ view ops

  viewAll() {
    if (this.view === 'PREVIEW' || this.hover === 'preview') return this.preview.fit();
    const sc = app.doc.scene;
    let a = sc.frame_start,
      b = sc.frame_end;
    let c0 = 1,
      c1 = 7;
    if (hasEditor() && seqList().length) {
      const l = seqList();
      a = Math.min(a, ...l.map(S.finalStart));
      b = Math.max(b, ...l.map(S.finalEnd));
      c0 = Math.min(...l.map((s) => s.channel));
      // fit the used channels (at least three rows, so short edits do not get huge strips)
      c1 = Math.max(Math.min(1, c0) + 2, ...l.map((s) => s.channel));
    }
    this.fitFrames(a, b);
    const avail = this.contentBottom() - RULER_H;
    this.chH = Math.max(18, Math.min(56, avail / (c1 - Math.min(1, c0) + 1.4)));
    this.cy0 = Math.min(1, c0) - 0.4;
    this.drawChannels();
    this.redraw();
  }

  private fitFrames(a: number, b: number) {
    const W = Math.max(50, this.W);
    const margin = 30;
    this.ppf = Math.max(0.01, Math.min(400, (W - margin * 2) / Math.max(1, b - a)));
    this.x0 = a - margin / this.ppf;
  }

  viewSelected() {
    if (this.view === 'PREVIEW' || this.hover === 'preview') return this.preview.frameSelected();
    const sel = hasEditor() ? seqList().filter((s) => s.select) : [];
    if (!sel.length) return;
    this.fitFrames(Math.min(...sel.map(S.finalStart)), Math.max(...sel.map(S.finalEnd)));
    const c0 = Math.min(...sel.map((s) => s.channel)),
      c1 = Math.max(...sel.map((s) => s.channel));
    const avail = this.contentBottom() - RULER_H;
    if ((c1 - c0 + 1) * this.chH > avail) this.chH = Math.max(18, avail / (c1 - c0 + 1.4));
    this.cy0 = c0 - 0.2;
    this.drawChannels();
    this.redraw();
  }

  viewFrame() {
    this.x0 = app.doc.scene.frame_current - this.W / 2 / this.ppf;
    this.redraw();
  }

  previewToFrame(clientX: number, clientY: number): [number, number] {
    return this.preview.toFrame(clientX, clientY);
  }
  previewScale() {
    return this.preview.layout().s;
  }
  previewFit() {
    this.preview.fit();
  }
  previewZoom(ratio: number) {
    this.preview.setRatio(ratio);
  }

  // ------------------------------------------------------------------ drawing

  private draw() {
    if (!this.hasTimeline()) return;
    const c = this.canvas;
    const W = this.W,
      H = this.H;
    if (!W || !H) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    if (!this.fitted) {
      this.fitted = true;
      const sc = app.doc.scene;
      this.fitFrames(sc.frame_start, sc.frame_end);
      this.drawChannels();
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sc = app.doc.scene;
    const cb = this.contentBottom();
    // rows
    g.fillStyle = T.back;
    g.fillRect(0, 0, W, H);
    const [lo, hi] = this.visibleChannels();
    g.fillStyle = T.rowAlt;
    for (let ch = lo; ch <= hi; ch++) if (ch % 2 === 0) g.fillRect(0, this.chBottom(ch) - this.chH, W, this.chH);
    // channel 0 area (below channel 1)
    if (this.chBottom(1) < cb) {
      g.fillStyle = T.rowAlt;
      g.fillRect(0, this.chBottom(1), W, cb - this.chBottom(1));
    }
    // out of range / meta range
    const meta = this.editedMeta();
    const [ra, rb] = meta ? [S.finalStart(meta), S.finalEnd(meta) - 1] : sc.use_preview_range ? [sc.frame_preview_start ?? sc.frame_start, sc.frame_preview_end ?? sc.frame_end] : [sc.frame_start, sc.frame_end];
    const xa = this.fx(ra),
      xb = this.fx(rb + 1);
    g.fillStyle = T.outOfRange;
    if (xa > 0) g.fillRect(0, RULER_H, Math.min(W, xa), cb - RULER_H);
    if (xb < W) g.fillRect(Math.max(0, xb), RULER_H, W - xb, cb - RULER_H);
    // grid
    const step = frameStep(this.ppf, sceneFps(), 64);
    const first = Math.floor(this.xf(0) / step) * step;
    g.strokeStyle = this.showGrid ? T.grid : 'rgba(0, 0, 0, 0)';
    g.lineWidth = 1;
    g.beginPath();
    for (let f = first; this.fx(f) < W + 1; f += step) {
      const x = Math.round(this.fx(f)) + 0.5;
      g.moveTo(x, RULER_H);
      g.lineTo(x, cb);
    }
    g.stroke();
    // strips
    g.save();
    g.beginPath();
    g.rect(0, RULER_H, W, cb - RULER_H);
    g.clip();
    if (hasEditor()) {
      const list = seqList();
      const act = activeStrip();
      for (const s of list) if (!s.select) this.drawStrip(g, s, act === s, W);
      for (const s of list) if (s.select) this.drawStrip(g, s, act === s, W);
    }
    g.restore();
    this.drawMarkers(g, W, H);
    // frame overlay reference
    const ref = hasEditor() ? overlayRefFrame(seqEditor(), sc.frame_current) : null;
    if (ref !== null) {
      const rx = Math.round(this.fx(ref)) + 0.5;
      g.save();
      g.setLineDash([4, 4]);
      g.strokeStyle = 'rgba(255, 255, 255,0.6)';
      g.beginPath();
      g.moveTo(rx, RULER_H);
      g.lineTo(rx, H);
      g.stroke();
      g.restore();
    }
    // Final cache: frames that show without rendering again
    if (this.showCache && this.hasPreview()) {
      g.fillStyle = 'rgba(110, 170, 255, 0.75)';
      for (const f of this.preview.cachedFrames()) {
        const a = this.fx(f),
          b = this.fx(f + 1);
        if (b < 0 || a > W) continue;
        g.fillRect(a, RULER_H + 1, Math.max(1, b - a), 3);
      }
    }
    // snap indicator: the frames a running transform snapped to
    if (this.snapLines.length && app.modal) {
      g.save();
      g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      g.lineWidth = 1;
      for (const f of this.snapLines) {
        const sx = Math.round(this.fx(f)) + 0.5;
        g.beginPath();
        g.moveTo(sx, RULER_H);
        g.lineTo(sx, H);
        g.stroke();
      }
      g.restore();
    }
    // playhead
    const px = Math.round(this.fx(sc.frame_current)) + 0.5;
    g.strokeStyle = T.playhead;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(px, RULER_H);
    g.lineTo(px, H);
    g.stroke();
    g.lineWidth = 1;
    this.drawRuler(g, W, step);
    // scene range line under the ruler
    g.fillStyle = T.frameRange;
    g.globalAlpha = 0.85;
    g.fillRect(Math.max(0, this.fx(sc.frame_start)), RULER_H, Math.max(0, Math.min(W, this.fx(sc.frame_end + 1)) - Math.max(0, this.fx(sc.frame_start))), 2);
    g.globalAlpha = 1;
    if (this.boxRect) {
      const b = this.boxRect;
      g.fillStyle = 'rgba(255, 255, 255,0.06)';
      g.strokeStyle = 'rgba(255, 255, 255,0.8)';
      g.setLineDash([4, 3]);
      g.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.strokeRect(Math.min(b.x0, b.x1) + 0.5, Math.min(b.y0, b.y1) + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      g.setLineDash([]);
    }
    drawShape(g, this.shape);
    if (!hasEditor() || !seqList().length) {
      g.fillStyle = 'rgba(255, 255, 255,0.35)';
      g.font = FONT;
      g.textAlign = 'center';
      g.fillText('Add strips with Shift A, or drop movie, sound and image files here', W / 2, (RULER_H + cb) / 2);
      g.textAlign = 'left';
    }
  }

  private editedMeta(): Strip | null {
    if (!hasEditor()) return null;
    const ed = seqEditor();
    if (!ed.meta_stack.length) return null;
    return S.findStrip(ed.strips, ed.meta_stack[ed.meta_stack.length - 1]);
  }

  private drawRuler(g: CanvasRenderingContext2D, W: number, step: number) {
    const sc = app.doc.scene;
    g.fillStyle = T.ruler;
    g.fillRect(0, 0, W, RULER_H);
    g.font = FONT;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const fps = sceneFps();
    const px = Math.round(this.fx(sc.frame_current));
    const label = S.timecode(sc.frame_current, fps, this.showSeconds);
    const tw = Math.max(26, g.measureText(label).width + 12);
    g.fillStyle = T.rulerText;
    const first = Math.floor(this.xf(0) / step) * step;
    for (let f = first; this.fx(f) < W + 60; f += step) {
      const x = Math.round(this.fx(f));
      const t = S.timecode(f, fps, this.showSeconds);
      const lw = g.measureText(t).width;
      if (Math.abs(x - px) < tw / 2 + lw / 2 + 2) continue;
      g.fillText(t, x, RULER_H / 2 + 1);
    }
    g.fillStyle = T.playhead;
    g.beginPath();
    roundRect(g, px - tw / 2, 2, tw, RULER_H - 4, 4);
    g.fill();
    g.fillStyle = '#ffffff';
    g.fillText(label, px, RULER_H / 2 + 1);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
  }

  private drawMarkers(g: CanvasRenderingContext2D, W: number, H: number) {
    if (!this.markersVisible()) return;
    const top = H - MARKER_H;
    g.fillStyle = 'rgba(0, 0, 0,0.25)';
    g.fillRect(0, top, W, MARKER_H);
    g.font = FONT;
    for (const m of app.doc.scene.timeline_markers) {
      const x = Math.round(this.fx(m.frame)) + 0.5;
      if (x < -100 || x > W + 10) continue;
      g.strokeStyle = m.select ? 'rgba(255, 255, 255,0.55)' : 'rgba(0, 0, 0,0.45)';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, RULER_H);
      g.lineTo(x, top + 4);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = m.select ? '#ffffff' : T.marker;
      g.beginPath();
      g.moveTo(x, top + 15);
      g.lineTo(x - 5, top + 8);
      g.lineTo(x - 5, top + 4);
      g.lineTo(x + 5, top + 4);
      g.lineTo(x + 5, top + 8);
      g.closePath();
      g.fill();
      g.fillStyle = m.select ? '#ffffff' : '#bbbcbe';
      g.fillText(m.name, x + 8, top + 14);
    }
  }

  private drawStrip(g: CanvasRenderingContext2D, s: Strip, active: boolean, W: number) {
    const r = this.stripRect(s);
    if (r.x1 < -2 || r.x0 > W + 2 || r.y1 < RULER_H || r.y0 > this.contentBottom()) return;
    const x0 = Math.round(r.x0),
      x1 = Math.max(x0 + 1, Math.round(r.x1)),
      y0 = Math.round(r.y0),
      y1 = Math.round(r.y1);
    const w = x1 - x0,
      hgt = y1 - y0;
    const base = this.showColorTags ? stripColor(s) : typeColor(s.type);
    const muted = s.mute || !!seqChannels()[s.channel]?.mute;
    g.save();
    if (muted) g.globalAlpha = 0.45;
    // offsets (hidden content) overlay
    if (this.showOffsets && !S.isStill(s) && !S.inputCount(s.type) && (s.frame_offset_start || s.frame_offset_end)) {
      g.fillStyle = 'rgba(255, 255, 255,0.12)';
      const ca = this.fx(s.frame_start),
        cbx = this.fx(s.frame_start + s.frame_duration);
      g.fillRect(ca, y1 + 1, cbx - ca, 3);
      g.fillRect(ca, y0 - 4, cbx - ca, 3);
    }
    const titleH = hgt >= 30 ? 17 : hgt;
    const rr = Math.min(4, w / 3, hgt / 3);
    g.beginPath();
    roundRect(g, x0, y0, w, hgt, rr);
    g.save();
    g.clip();
    // body
    g.fillStyle = base;
    g.fillRect(x0, y0, w, hgt);
    const by0 = y0 + titleH,
      bh = hgt - titleH;
    if (bh > 4) this.drawBody(g, s, x0, by0, w, bh, W);
    // locked hatching
    if (s.lock || seqChannels()[s.channel]?.lock) {
      g.strokeStyle = 'rgba(0, 0, 0,0.3)';
      g.lineWidth = 2;
      g.beginPath();
      for (let x = x0 - hgt; x < x1; x += 10) {
        g.moveTo(x, y1);
        g.lineTo(x + hgt, y0);
      }
      g.stroke();
      g.lineWidth = 1;
    }
    if (this.showFcurves) this.drawFadeCurve(g, s, x0, y0, w, hgt);
    if (this.showRetiming && s.show_retiming_keys && retimable(s)) this.drawRetiming(g, s, x0, y0 + titleH, w, hgt - titleH);
    // keyframes of animated properties (fades show as a curve)
    if (s.keys && this.showFcurves) {
      const frames = keyFrames(s, KEY_PATHS.filter((p) => p !== 'blend_alpha' && p !== 'volume'));
      const ky = y0 + titleH + 6;
      for (const f of frames) {
        const kx = this.fx(f);
        if (kx < x0 - 4 || kx > x0 + w + 4) continue;
        g.beginPath();
        g.moveTo(kx, ky - 4);
        g.lineTo(kx + 4, ky);
        g.lineTo(kx, ky + 4);
        g.lineTo(kx - 4, ky);
        g.closePath();
        g.fillStyle = '#ecc439';
        g.fill();
        g.strokeStyle = 'rgba(0, 0, 0,0.7)';
        g.stroke();
      }
    }
    // handles: shown for the hovered strip and for selected handles
    const hw = this.handleWidth(r);
    if (!S.inputCount(s.type)) {
      const hovered = this.hoverStrip === s;
      if (s.select_left_handle || hovered) {
        g.fillStyle = s.select_left_handle ? 'rgba(255, 255, 255,0.65)' : this.hoverHandle === 'LEFT' ? 'rgba(255, 255, 255,0.35)' : 'rgba(0, 0, 0,0.22)';
        g.fillRect(x0, y0, hw, hgt);
      }
      if (s.select_right_handle || hovered) {
        g.fillStyle = s.select_right_handle ? 'rgba(255, 255, 255,0.65)' : this.hoverHandle === 'RIGHT' ? 'rgba(255, 255, 255,0.35)' : 'rgba(0, 0, 0,0.22)';
        g.fillRect(x1 - hw, y0, hw, hgt);
      }
    }
    // title text
    const parts: string[] = [];
    if (this.showStripName) parts.push(s.name);
    if (this.showStripSource) {
      const src = s.type === 'TEXT' ? (s.text ?? '').split('\n')[0] : s.media?.filepath ?? (s.elements?.length ? s.elements[0].filename : s.type === 'SCENE' ? (s.scene ?? '') : '');
      if (src && src !== s.name) parts.push(src);
    }
    if (this.showStripDuration) parts.push(String(S.finalDuration(s)));
    const linked = isConnected(seqList(), s);
    if (linked && w > 24 && titleH >= 12) drawLink(g, Math.max(x0, 0) + hw + 4, y0 + titleH / 2);
    if (parts.length && w > 12) {
      g.font = FONT;
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(0, 0, 0,0.6)';
      const tx = Math.max(x0, 0) + hw + 3 + (linked ? 13 : 0);
      const ty = y0 + titleH / 2 + 0.5;
      const text = parts.join(' | ');
      g.save();
      g.beginPath();
      g.rect(x0 + hw, y0, w - hw * 2, titleH);
      g.clip();
      g.fillText(text, tx + 1, ty + 1);
      g.fillStyle = T.text;
      g.fillText(text, tx, ty);
      g.restore();
      g.textBaseline = 'alphabetic';
    }
    g.restore();
    // outline
    g.beginPath();
    roundRect(g, x0 + 0.5, y0 + 0.5, w - 1, hgt - 1, rr);
    if (this.invalid.has(s)) {
      g.strokeStyle = T.invalid;
      g.lineWidth = 2;
    } else if (active && s.select) {
      g.strokeStyle = T.active;
      g.lineWidth = 2;
    } else if (s.select) {
      g.strokeStyle = T.selected;
      g.lineWidth = 2;
    } else {
      g.strokeStyle = T.outline;
      g.lineWidth = 1;
    }
    g.stroke();
    g.lineWidth = 1;
    g.restore();
  }

  /** Retiming keys (diamonds along the bottom) and the speed of each segment. */
  private drawRetiming(g: CanvasRenderingContext2D, s: Strip, x0: number, y0: number, w: number, h: number) {
    const keys = s.retiming_keys ?? [
      { frame: 0, content: 0 },
      { frame: s.frame_duration, content: s.frame_duration },
    ];
    g.fillStyle = 'rgba(0, 0, 0,0.25)';
    g.fillRect(x0, y0 + h - 12, w, 12);
    g.font = '10px Inter, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < keys.length - 1; i++) {
      const a = this.fx(s.frame_start + keys[i].frame),
        b = this.fx(s.frame_start + keys[i + 1].frame);
      const sp = segmentSpeed(keys, i);
      const label = keys[i].transition ? 'Transition' : sp === 0 ? 'Freeze' : `${Math.round(sp * 1000) / 10}%`;
      if (keys[i].transition) {
        g.fillStyle = 'rgba(255, 255, 255,0.12)';
        g.fillRect(a, y0, b - a, h);
      } else if (sp === 0) {
        g.fillStyle = 'rgba(90, 138, 252,0.18)';
        g.fillRect(a, y0, b - a, h);
      }
      const mid = (Math.max(a, x0) + Math.min(b, x0 + w)) / 2;
      if (b - a > g.measureText(label).width + 8 && (keys.length > 2 || sp !== 1)) {
        g.fillStyle = 'rgba(255, 255, 255,0.85)';
        g.fillText(label, mid, y0 + Math.min(h / 2, h - 18));
      }
    }
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    for (const k of keys) {
      const x = this.fx(s.frame_start + k.frame);
      const y = y0 + h - 6;
      g.beginPath();
      g.moveTo(x, y - 5);
      g.lineTo(x + 5, y);
      g.lineTo(x, y + 5);
      g.lineTo(x - 5, y);
      g.closePath();
      g.fillStyle = k.select ? '#fa9404' : '#eaebec';
      g.fill();
      g.strokeStyle = 'rgba(0, 0, 0,0.7)';
      g.stroke();
    }
  }

  /** Retiming key under a timeline point (strips showing their keys). */
  private retimingKeyAt(x: number, y: number): { strip: Strip; index: number } | null {
    if (!hasEditor()) return null;
    for (const s of [...seqList()].reverse()) {
      if (!s.show_retiming_keys || !s.retiming_keys) continue;
      const r = this.stripRect(s);
      if (y < r.y1 - 14 || y > r.y1 + 1 || x < r.x0 - 6 || x > r.x1 + 6) continue;
      let best = -1,
        bd = 7;
      s.retiming_keys.forEach((k, i) => {
        const d = Math.abs(this.fx(s.frame_start + k.frame) - x);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      if (best >= 0) return { strip: s, index: best };
    }
    return null;
  }

  /** Click / drag on a retiming key: select it (Shift toggles), drag moves it. */
  private retimingKeyDown(e: PointerEvent, hit: { strip: Strip; index: number }) {
    const s = hit.strip;
    const k = s.retiming_keys![hit.index];
    if (!e.shiftKey) {
      for (const o of seqList()) for (const x of o.retiming_keys ?? []) x.select = false;
      k.select = true;
    } else k.select = !k.select;
    selectStrip(s, { extend: true, ignoreConnections: true });
    app.changed('doc');
    const x0 = e.clientX,
      y0 = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) {
        dragging = true;
        cleanup();
        if (hit.index > 0) startRetimingKeyMove(this, s, hit.index, x0);
      }
    };
    const up = () => {
      cleanup();
      if (!dragging) app.pushUndo('Select Retiming Key');
    };
    const cleanup = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  /** Opacity / volume animation as a line over the strip, with the faded part darkened. */
  private drawFadeCurve(g: CanvasRenderingContext2D, s: Strip, x0: number, y0: number, w: number, hgt: number) {
    const keys = keysOf(s, fadeProp(s));
    if (!keys) return;
    const top = Math.max(1, ...keys.map((k) => k[1]));
    const yOf = (v: number) => y0 + hgt - (Math.max(0, v) / top) * hgt;
    const xs: number[] = [x0];
    for (const [f] of keys) {
      const x = this.fx(f);
      if (x > x0 && x < x0 + w) xs.push(x);
    }
    xs.push(x0 + w);
    const pts = xs.map((x) => [x, yOf(keyValue(keys, this.xf(x)))] as const);
    g.beginPath();
    g.moveTo(x0, y0);
    for (const [x, y] of pts) g.lineTo(x, y);
    g.lineTo(x0 + w, y0);
    g.closePath();
    g.fillStyle = 'rgba(0, 0, 0,0.3)';
    g.fill();
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = 'rgba(255, 255, 255,0.75)';
    g.lineWidth = 1.5;
    g.stroke();
    g.lineWidth = 1;
  }

  private drawBody(g: CanvasRenderingContext2D, s: Strip, x0: number, y0: number, w: number, h: number, W: number) {
    const fps = sceneFps();
    switch (s.type) {
      case 'COLOR':
        g.fillStyle = cssColor(s.color);
        g.fillRect(x0, y0, w, h);
        return;
      case 'SOUND': {
        if (!this.showWaveforms || this.waveformType === 'NO_WAVEFORMS' || (this.waveformType === 'DEFAULT_WAVEFORMS' && s.show_waveform === false) || !s.media) return;
        const buf = soundNow(s.media.bytes, () => this.redraw());
        if (!buf) {
          g.fillStyle = 'rgba(0, 0, 0,0.15)';
          g.fillRect(x0, y0, w, h);
          return;
        }
        const pk = soundPeaks(buf);
        const n = pk.length / 2;
        const half = this.waveformStyle === 'HALF_WAVEFORMS';
        // half: the absolute level rises from the bottom of the strip
        const mid = half ? y0 + h - 1 : y0 + h / 2;
        const amp = (half ? h - 2 : h / 2 - 1) * Math.min(4, s.volume ?? 1);
        g.fillStyle = T.waveform;
        g.beginPath();
        const xa = Math.max(0, x0),
          xb = Math.min(W, x0 + w);
        const top: number[] = [],
          bot: number[] = [];
        for (let x = Math.floor(xa); x < xb; x++) {
          const f0 = this.xf(x),
            f1 = this.xf(x + 1);
          const t0 = (s.animation_offset_start + mapContent(s, f0 - s.frame_start)) / fps + (s.sound_offset ?? 0),
            t1 = (s.animation_offset_start + mapContent(s, f1 - s.frame_start)) / fps + (s.sound_offset ?? 0);
          const b0 = Math.max(0, Math.floor(t0 * PEAKS_PER_SECOND)),
            b1 = Math.min(n, Math.max(b0 + 1, Math.ceil(t1 * PEAKS_PER_SECOND)));
          let lo = 0,
            hi = 0;
          for (let b = b0; b < b1; b++) {
            lo = Math.min(lo, pk[b * 2]);
            hi = Math.max(hi, pk[b * 2 + 1]);
          }
          if (half) {
            top.push(mid - Math.max(hi, -lo) * amp);
            bot.push(mid);
          } else {
            top.push(mid - hi * amp);
            bot.push(mid - lo * amp);
          }
        }
        if (!top.length) return;
        g.moveTo(Math.floor(xa), top[0]);
        top.forEach((y, i) => g.lineTo(Math.floor(xa) + i, y));
        for (let i = bot.length - 1; i >= 0; i--) g.lineTo(Math.floor(xa) + i, bot[i]);
        g.closePath();
        g.fill();
        g.fillStyle = 'rgba(0, 0, 0,0.2)';
        g.fillRect(x0, mid, w, 0.5);
        return;
      }
      case 'MOVIE': {
        if (!this.showThumbnails || !s.media || !s.orig_width) return;
        const tw = Math.max(8, (h * s.orig_width) / (s.orig_height || 1));
        const xs = Math.max(x0, Math.floor((0 - x0) / tw) * tw + x0);
        for (let x = xs; x < Math.min(W, x0 + w); x += tw) {
          const frame = this.xf(x);
          const t = (S.contentFrame(s, frame) + 0.5) / fps;
          const bmp = movieThumb(s.media.bytes, s.media.mime, t, () => this.redraw());
          if (bmp) g.drawImage(bmp, x, y0, tw, h);
        }
        return;
      }
      case 'MOVIECLIP': {
        // thumbnails from the clip's decoded frames
        const clip = s.clip ? app.doc.movieclips?.[s.clip] : undefined;
        const src = clip ? readySource(clip) : null;
        if (!this.showThumbnails || !clip || !src || !clip.size[0]) return;
        const tw = Math.max(8, (h * clip.size[0]) / clip.size[1]);
        for (let x = Math.max(x0, x0 + Math.floor((0 - x0) / tw) * tw); x < Math.min(W, x0 + w); x += tw) {
          const idx = clipFrameToSourceIndex(clip, S.contentFrame(s, this.xf(x)) + 1);
          if (idx < 0) continue;
          const bmp = src.peek(idx);
          if (bmp) g.drawImage(bmp, x, y0, tw, h);
          else if (!this.clipThumbRequests.has(`${clip.id}|${idx}`)) {
            // evicted frames can be asked for again later
            if (this.clipThumbRequests.size > 500) this.clipThumbRequests.clear();
            this.clipThumbRequests.add(`${clip.id}|${idx}`);
            void src.get(idx).then(() => this.redraw());
          }
        }
        return;
      }
      case 'IMAGE': {
        if (!this.showThumbnails) return;
        const el = s.elements?.[0];
        if (!el) return;
        const bmp = imageNow(el.bytes, el.mime, () => this.redraw());
        if (!bmp) return;
        const tw = Math.max(8, (h * bmp.width) / (bmp.height || 1));
        if (s.elements!.length > 1) {
          const xs = Math.max(x0, Math.floor((0 - x0) / tw) * tw + x0);
          for (let x = xs; x < Math.min(W, x0 + w); x += tw) {
            const e = s.elements![Math.min(s.elements!.length - 1, S.contentFrame(s, this.xf(x)))];
            const b = imageNow(e.bytes, e.mime, () => this.redraw());
            if (b) g.drawImage(b, x, y0, tw, h);
          }
        } else for (let x = Math.max(x0, x0 + Math.floor((0 - x0) / tw) * tw); x < Math.min(W, x0 + w); x += tw) g.drawImage(bmp, x, y0, tw, h);
        return;
      }
      case 'CROSS':
      case 'GAMMA_CROSS':
      case 'WIPE': {
        const all = S.allStrips(seqEditor().strips);
        const [a, b] = S.effectInputs(all, s);
        const ca = a ? (a.type === 'COLOR' ? cssColor(a.color) : typeColor(a.type)) : '#303133';
        const cbc = b ? (b.type === 'COLOR' ? cssColor(b.color) : typeColor(b.type)) : '#303133';
        g.fillStyle = ca;
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x0 + w, y0 + h);
        g.lineTo(x0, y0 + h);
        g.closePath();
        g.fill();
        g.fillStyle = cbc;
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x0 + w, y0);
        g.lineTo(x0 + w, y0 + h);
        g.closePath();
        g.fill();
        return;
      }
      case 'META': {
        const kids = s.strips ?? [];
        if (!kids.length) return;
        const c0 = Math.min(...kids.map((k) => k.channel)),
          c1 = Math.max(...kids.map((k) => k.channel));
        const rows = c1 - c0 + 1;
        const rh = h / rows;
        for (const k of kids) {
          g.fillStyle = stripColor(k);
          const kx0 = this.fx(S.finalStart(k)),
            kx1 = this.fx(S.finalEnd(k));
          g.fillRect(kx0, y0 + h - (k.channel - c0 + 1) * rh + 1, kx1 - kx0, Math.max(1, rh - 2));
        }
        return;
      }
      case 'TEXT':
      case 'ADJUSTMENT':
      case 'SCENE':
        return;
    }
    // other effects: show their inputs' colour bands faintly
    g.fillStyle = 'rgba(0, 0, 0,0.12)';
    g.fillRect(x0, y0, w, h);
  }

  // ------------------------------------------------------------------ input

  private bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onTimelineDown(e));
    c.addEventListener('pointermove', (e) => this.onTimelineMove(e));
    c.addEventListener('wheel', (e) => this.onTimelineWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    this.mainEl.addEventListener('pointerenter', () => (this.hover = 'timeline'));
    this.mainEl.addEventListener('pointerleave', () => {
      if (!this.hoverStrip) return;
      this.hoverStrip = this.hoverHandle = null;
      this.redraw();
    });
    this.mainEl.addEventListener('pointermove', () => (this.hover = 'timeline'));
    this.chEl.addEventListener('pointermove', () => (this.hover = 'channels'));
    this.toolbarEl.addEventListener('pointermove', () => (this.hover = 'toolbar'));
    this.sbEl.addEventListener('pointermove', () => (this.hover = 'sidebar'));
    this.footerEl.addEventListener('pointermove', () => (this.hover = 'other'));
    this.chEl.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.scrollChannels(e.deltaY);
      },
      { passive: false },
    );
    // preview
    const pv = this.preview.el;
    pv.addEventListener('pointermove', (e) => {
      this.hover = 'preview';
      if (this.pvTool === 'transform' && !app.modal) {
        const r = pv.getBoundingClientRect();
        const part = this.preview.cagePart(e.clientX - r.left, e.clientY - r.top);
        pv.style.cursor = part === 'MOVE' ? 'move' : part === 'SCALE' ? 'nwse-resize' : part === 'ROTATE' ? 'alias' : '';
      } else if (pv.style.cursor) pv.style.cursor = '';
    });
    this.pvToolbar.addEventListener('pointermove', () => (this.hover = 'toolbar'));
    pv.addEventListener('pointerdown', (e) => this.onPreviewDown(e));
    pv.addEventListener('wheel', (e) => this.onPreviewWheel(e), { passive: false });
    pv.addEventListener('contextmenu', (e) => e.preventDefault());
    pv.addEventListener('dblclick', (e) => {
      // double click on a text strip edits its text; elsewhere fits the preview
      const hit = hasEditor() ? this.preview.stripAt(e.clientX, e.clientY) : null;
      const editing = editedText();
      if (editing && hit === editing) {
        // double click while editing selects the word
        const [fx, fy] = this.preview.toFrame(e.clientX, e.clientY);
        const i = indexAt(editing, fx, fy);
        const text = editing.text ?? '';
        textEdit.anchor = prevWord(text, Math.min(text.length, i + 1));
        textEdit.cursor = nextWord(text, Math.max(0, textEdit.anchor));
        this.preview.draw();
        return;
      }
      if (hit?.type === 'TEXT') {
        selectStrip(hit, {});
        const [fx, fy] = this.preview.toFrame(e.clientX, e.clientY);
        startTextEdit(hit, indexAt(hit, fx, fy));
        app.changed('doc');
      } else this.preview.fit();
    });
    // split grip
    this.grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = this.leftEl.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        this.splitRatio = Math.max(0.1, Math.min(0.9, (ev.clientY - r.top) / r.height));
        this.layout();
        this.refresh();
        this.preview.draw();
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        this.preview.request();
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
    // channel region resize (drag its right edge)
    this.chEl.addEventListener('pointerdown', (e) => {
      const r = this.chEl.getBoundingClientRect();
      if (e.clientX < r.right - 5 || e.button !== 0) return;
      e.preventDefault();
      const x0 = e.clientX,
        w0 = this.chWidth;
      const move = (ev: PointerEvent) => {
        this.chWidth = Math.max(80, Math.min(400, w0 + ev.clientX - x0));
        this.layout();
        this.redraw();
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
    // file drops
    for (const target of [this.mainEl, this.preview.el]) {
      target.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      });
      target.addEventListener('drop', (e) => {
        const all = e.dataTransfer?.files ? [...e.dataTransfer.files] : [];
        if (!all.length) return;
        e.preventDefault();
        // subtitle files become text strips
        const subs = all.filter((f) => /\.(srt|vtt)$/i.test(f.name));
        for (const f of subs) void formats.find((x) => x.id === 'subtitles')?.import?.(f).catch((err: unknown) => app.report('ERROR', `Cannot import subtitles: ${err instanceof Error ? err.message : String(err)}`));
        const files = all.filter((f) => !subs.includes(f));
        if (!files.length) return;
        const overTimeline = target === this.mainEl;
        const frame = overTimeline ? Math.round(this.pointerFrame(e.clientX)) : app.doc.scene.frame_current;
        const channel = overTimeline ? Math.max(1, Math.floor(this.pointerChannel(e.clientY))) : 1;
        void addFiles(files, frame, channel).then((added) => {
          if (!added.length) {
            app.report('WARNING', 'No movie, sound or image files to add');
            return;
          }
          app.pushUndo('Add Strips');
          app.changed('doc');
          restartPlayback();
        });
      });
    }
  }

  private scrollChannels(dy: number) {
    this.cy0 = Math.max(0.4, Math.min(MAX_CHANNELS - 2, this.cy0 - dy / this.chH));
    this.drawChannels();
    this.redraw();
  }

  private onTimelineMove(e: PointerEvent) {
    if (app.modal || e.buttons) return;
    const { x, y } = this.local(e);
    let cursor = '';
    const hit = y > RULER_H ? this.hitTest(x, y) : null;
    if (hit?.handle && this.tool === 'select_box') cursor = 'ew-resize';
    else if (this.tool === 'blade' && y > RULER_H) cursor = 'crosshair';
    this.canvas.style.cursor = cursor;
    const hs = hit?.strip ?? null,
      hh = hit?.handle ?? null;
    if (hs !== this.hoverStrip || hh !== this.hoverHandle) {
      this.hoverStrip = hs;
      this.hoverHandle = hh;
      this.redraw();
    }
  }

  private onTimelineWheel(e: WheelEvent) {
    e.preventDefault();
    if (app.modal) return;
    const { x } = this.local(e);
    const dx = e.deltaX,
      dy = e.deltaY;
    if (e.ctrlKey || e.metaKey) {
      this.x0 += (dy || dx) / this.ppf;
    } else if (e.shiftKey) {
      this.scrollChannels(dy || dx);
      return;
    } else if (Math.abs(dx) > Math.abs(dy)) {
      this.x0 += dx / this.ppf;
    } else {
      const f = this.xf(x);
      this.ppf = Math.max(0.01, Math.min(400, this.ppf * Math.exp(-dy * 0.0025)));
      this.x0 = f - x / this.ppf;
    }
    this.redraw();
  }

  private onTimelineDown(e: PointerEvent) {
    if (app.modal) return;
    app.activeArea = this.area;
    const { x, y } = this.local(e);
    if (e.button === 1) {
      e.preventDefault();
      return e.ctrlKey || e.metaKey ? this.dragZoom(e) : this.dragPan(e);
    }
    if (e.button === 2) {
      e.preventDefault();
      if (y > RULER_H && hasEditor()) {
        const hit = this.hitTest(x, y);
        if (hit && !hit.strip.select) {
          selectStrip(hit.strip, {});
          app.pushUndo('Select');
          app.changed('doc');
        }
      }
      openMenu(y > this.H - MARKER_H && this.markersVisible() ? markerMenu() : contextMenu(), { x: e.clientX, y: e.clientY });
      return;
    }
    if (e.button !== 0) return;
    if (y < RULER_H) return this.scrub(e);
    if (this.markersVisible() && y > this.H - MARKER_H) return this.markerDown(e, x);
    if (this.tool === 'blade') return this.bladeDown(e);
    const keyHit = this.retimingKeyAt(x, y);
    if (keyHit) return this.retimingKeyDown(e, keyHit);
    const hit = this.hitTest(x, y);
    if (this.tool === 'slip') {
      if (!hit) return;
      selectStrip(hit.strip, { ignoreConnections: e.altKey });
      app.changed('doc');
      startSlip(this, e.clientX, hit.strip);
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    const ignoreConnections = e.altKey;
    const shapeMode = e.shiftKey ? 'ADD' : ctrl ? 'SUB' : 'SET';
    if (this.tool === 'select_circle') return this.startCircle(shapeMode === 'SET' ? 'SET' : shapeMode, e);
    // select box / lasso tool
    const x0 = e.clientX,
      y0 = e.clientY;
    const dragShape = (ev: PointerEvent) => {
      if (this.tool === 'select_lasso') this.startLasso(e, shapeMode, ev);
      else this.startBoxSelect(e, shapeMode, true, { ignoreConnections });
    };
    if (!hit || this.tool === 'select_lasso') {
      let dragging = false;
      const move = (ev: PointerEvent) => {
        if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) {
          dragging = true;
          cleanup();
          dragShape(ev);
        }
      };
      const up = () => {
        cleanup();
        if (dragging || !hasEditor()) return;
        if (hit) return this.clickSelect(hit, e);
        if (ctrl) {
          // Ctrl click on empty space: everything on that side of the playhead
          app.run('sequencer.select_side_of_frame', { side: this.xf(x) < app.doc.scene.frame_current ? 'LEFT' : 'RIGHT', extend: e.shiftKey });
          return;
        }
        if (!e.shiftKey) {
          selectStrip(null, {});
          app.pushUndo('Deselect');
          app.changed('doc');
        }
      };
      const cleanup = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      return;
    }
    const s = hit.strip;
    const wasSelected = s.select;
    // press on the edit point between two touching strips: both handles (dragging rolls the cut)
    const touching = hit.handle && !ctrl && !e.shiftKey ? neighbor(seqList(), s, hit.handle) : null;
    const roll = !!touching && !isLocked(touching) && !S.inputCount(touching.type);
    // press: make sure the pressed strip is selected so it can be dragged
    if (ctrl) this.selectLinkedTime(hit, e.shiftKey, ignoreConnections);
    else if (roll) {
      selectStrip(s, { handle: hit.handle, ignoreConnections });
      selectStrip(touching!, { extend: true, handle: hit.handle === 'LEFT' ? 'RIGHT' : 'LEFT', ignoreConnections });
      setActive(s);
    } else if (hit.handle) selectStrip(s, { extend: e.shiftKey, handle: hit.handle, ignoreConnections });
    else if (!s.select) selectStrip(s, { extend: e.shiftKey, ignoreConnections });
    else if (s.select_left_handle || s.select_right_handle) selectStrip(s, { extend: true, ignoreConnections });
    app.changed('doc');
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) {
        dragging = true;
        cleanup();
        if (roll) startSlide(this, x0, y0, { label: 'Roll Edit' });
        else if (hit.handle && !ctrl) startSlide(this, x0, y0, { label: 'Trim Strip', ...(ignoreConnections || !isConnected(seqList(), s) ? { handleStrip: s, handleSide: hit.handle } : {}) });
        else startSlide(this, x0, y0);
      }
    };
    const up = () => {
      cleanup();
      if (dragging) return;
      // click: shift toggles, plain click selects only this strip
      if (ctrl) {
        // already selected on press
      } else if (e.shiftKey && wasSelected && !hit.handle) selectStrip(s, { toggle: true, ignoreConnections });
      else if (!e.shiftKey && !hit.handle) selectStrip(s, { ignoreConnections });
      app.pushUndo('Select');
      app.changed('doc');
    };
    const cleanup = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  /** Blade tool: click splits the strip under the pointer, dragging a box cuts out its contents. */
  private bladeDown(e: PointerEvent) {
    const p0 = this.local(e);
    let dragging = false;
    const move = (ev: PointerEvent) => {
      const p = this.local(ev);
      if (!dragging && Math.hypot(p.x - p0.x, p.y - p0.y) > 4) dragging = true;
      if (!dragging) return;
      // the box snaps to whole frames and channels
      const f0 = Math.round(this.xf(Math.min(p0.x, p.x))),
        f1 = Math.round(this.xf(Math.max(p0.x, p.x)));
      this.boxRect = { x0: this.fx(f0), x1: this.fx(f1), y0: p0.y, y1: p.y };
      this.redraw();
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      this.boxRect = null;
      this.redraw();
      const p = this.local(ev);
      if (!dragging) {
        const hit = this.hitTest(p0.x, p0.y);
        if (hit) app.run('sequencer.split', { frame: Math.round(this.xf(p0.x)), channel: hit.strip.channel, type: e.shiftKey ? 'HARD' : 'SOFT', use_cursor_position: true, ignore_selection: true, side: 'NO_CHANGE' }, { invoke: false });
        return;
      }
      const c0 = Math.floor(this.pointerChannel(e.clientY)),
        c1 = Math.floor(this.pointerChannel(ev.clientY));
      app.run('sequencer.box_blade', { frame_start: Math.round(this.xf(Math.min(p0.x, p.x))), frame_end: Math.round(this.xf(Math.max(p0.x, p.x))), channel_start: Math.max(1, Math.min(c0, c1)), channel_end: Math.max(1, Math.max(c0, c1)), remove_gaps: !e.shiftKey, ignore_connections: e.altKey }, { invoke: false });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  /** Plain click on a strip (lasso / circle tools fall back to it). */
  private clickSelect(hit: { strip: Strip; handle: 'LEFT' | 'RIGHT' | null }, e: PointerEvent) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl) this.selectLinkedTime(hit, e.shiftKey, e.altKey);
    else if (e.shiftKey && hit.strip.select && !hit.handle) selectStrip(hit.strip, { toggle: true, ignoreConnections: e.altKey });
    else selectStrip(hit.strip, { extend: e.shiftKey, handle: hit.handle, ignoreConnections: e.altKey });
    app.pushUndo('Select');
    app.changed('doc');
  }

  /** Ctrl click: the strip plus strips on other channels sharing its range (or the clicked edge). */
  private selectLinkedTime(hit: { strip: Strip; handle: 'LEFT' | 'RIGHT' | null }, extend: boolean, ignoreConnections: boolean) {
    const s = hit.strip;
    selectStrip(s, { extend, handle: hit.handle, ignoreConnections });
    const list = seqList();
    if (!hit.handle) {
      for (const o of sameTime(list, s)) {
        o.select = true;
        o.select_left_handle = o.select_right_handle = false;
      }
      return;
    }
    for (const o of list) {
      if (o === s || o.channel === s.channel || S.inputCount(o.type)) continue;
      if (hit.handle === 'LEFT' && S.finalStart(o) === S.finalStart(s)) {
        o.select = true;
        o.select_left_handle = true;
      } else if (hit.handle === 'RIGHT' && S.finalEnd(o) === S.finalEnd(s)) {
        o.select = true;
        o.select_right_handle = true;
      }
    }
  }

  startBoxSelect(e: { clientX: number; clientY: number }, mode: 'SET' | 'ADD' | 'SUB' = 'SET', startNow = false, opts: { includeHandles?: boolean; ignoreConnections?: boolean } = {}) {
    if (!hasEditor()) return;
    if (this.hover === 'preview') return this.previewBox(e, mode);
    const p0 = this.local(e);
    let started = startNow;
    this.boxRect = started ? { x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y } : null;
    // B: the box starts at the next click
    const move = (ev: PointerEvent) => {
      if (!this.boxRect) return;
      const p = this.local(ev);
      this.boxRect.x1 = p.x;
      this.boxRect.y1 = p.y;
      this.redraw();
    };
    const down = (ev: PointerEvent) => {
      if (started) return;
      if (ev.button !== 0) {
        cleanup();
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      started = true;
      const p = this.local(ev);
      this.boxRect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    };
    const up = (ev: PointerEvent) => {
      if (!started) return;
      cleanup();
      const b = this.boxRect;
      this.boxRect = null;
      if (!b) return;
      const m = startNow ? mode : ev.shiftKey ? 'ADD' : ev.ctrlKey || ev.metaKey ? 'SUB' : mode;
      const rx0 = Math.min(b.x0, b.x1),
        rx1 = Math.max(b.x0, b.x1),
        ry0 = Math.min(b.y0, b.y1),
        ry1 = Math.max(b.y0, b.y1);
      const list = seqList();
      if (m === 'SET') deselectAll(list);
      const hits: Strip[] = [];
      for (const s of list) {
        const r = this.stripRect(s);
        if (r.x1 < rx0 || r.x0 > rx1 || r.y1 < ry0 || r.y0 > ry1) continue;
        const part = opts.includeHandles && !S.inputCount(s.type) ? boxHit(r.x0, r.x1, rx0, rx1, this.handleWidth(r)) : 'STRIP';
        if (m === 'SUB') {
          s.select = false;
          s.select_left_handle = s.select_right_handle = false;
          continue;
        }
        s.select = true;
        if (part === 'LEFT') s.select_left_handle = true;
        else if (part === 'RIGHT') s.select_right_handle = true;
        else {
          s.select_left_handle = s.select_right_handle = false;
          hits.push(s);
        }
      }
      if (!opts.ignoreConnections && m !== 'SUB') for (const s of hits) for (const c of connectedOf(list, s)) c.select = true;
      app.pushUndo('Box Select');
      app.changed('doc');
    };
    const cleanup = () => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerdown', down, true);
      removeEventListener('pointerup', up, true);
      this.redraw();
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerdown', down, true);
    addEventListener('pointerup', up, true);
  }

  /** Strips touched by a shape given in client pixels (timeline or preview). */
  private shapeHits(region: 'timeline' | 'preview', test: (r: { x0: number; y0: number; x1: number; y1: number }) => boolean): Strip[] {
    if (!hasEditor()) return [];
    if (region === 'preview') return this.preview.stripsWhere(test);
    const c = this.canvas.getBoundingClientRect();
    return seqList().filter((s) => {
      const r = this.stripRect(s);
      return r.y1 > RULER_H && test({ x0: r.x0 + c.left, x1: r.x1 + c.left, y0: r.y0 + c.top, y1: r.y1 + c.top });
    });
  }

  private applyShape(hits: Strip[], add: boolean, region: 'timeline' | 'preview') {
    const list = seqList();
    for (const s of hits) {
      for (const x of region === 'timeline' && add ? [s, ...connectedOf(list, s)] : [s]) {
        x.select = add;
        x.select_left_handle = x.select_right_handle = false;
      }
    }
    if (hits.length) app.changed('select');
  }

  private setShape(region: 'timeline' | 'preview', shape: SelectShape | null) {
    if (region === 'preview') {
      this.preview.shape = shape;
      this.preview.draw();
    } else {
      this.shape = shape;
      this.redraw();
    }
  }

  private regionOrigin(region: 'timeline' | 'preview') {
    const r = (region === 'preview' ? this.preview.el : this.canvas).getBoundingClientRect();
    return { left: r.left, top: r.top };
  }

  /**
   * Circle select. With a pointer event (tool drag) it paints while the button is held; without
   * one (C) it stays active: LMB paints, Shift/Ctrl/MMB deselects, the wheel resizes, RMB/Esc ends.
   */
  startCircle(mode: 'SET' | 'ADD' | 'SUB' = 'ADD', drag?: PointerEvent) {
    if (!hasEditor()) return;
    const region = this.hover === 'preview' ? 'preview' : 'timeline';
    const o = this.regionOrigin(region);
    const at = drag ? { x: drag.clientX, y: drag.clientY } : app.pointer;
    const circle = { kind: 'circle' as const, x: at.x - o.left, y: at.y - o.top, r: this.circleRadius };
    if (mode === 'SET') deselectAll();
    let paint: 'ADD' | 'SUB' | null = drag ? (mode === 'SUB' ? 'SUB' : 'ADD') : null;
    const apply = () => {
      if (!paint) return;
      const cx = circle.x + o.left,
        cy = circle.y + o.top;
      this.applyShape(this.shapeHits(region, (r) => rectCircle(r, cx, cy, circle.r)), paint === 'ADD', region);
    };
    this.setShape(region, circle);
    apply();
    const self = this;
    const end = () => self.setShape(region, null);
    app.startModal({
      label: 'Circle Select',
      cursor: 'crosshair',
      header: () => (drag ? 'Circle Select' : 'Circle Select: LMB select, Shift / MMB deselect, wheel resize, RMB / Esc confirm'),
      onPointerMove(e) {
        circle.x = e.clientX - o.left;
        circle.y = e.clientY - o.top;
        apply();
        self.setShape(region, circle);
      },
      onPointerDown(e) {
        if (drag) return undefined;
        if (e.button === 2) return 'FINISHED';
        paint = e.button === 1 || e.shiftKey || e.ctrlKey || e.metaKey || mode === 'SUB' ? 'SUB' : 'ADD';
        apply();
        return undefined;
      },
      onPointerUp() {
        if (drag) return 'FINISHED';
        paint = null;
        return undefined;
      },
      onWheel(e) {
        circle.r = Math.max(5, Math.min(400, circle.r * (e.deltaY > 0 ? 1 / 1.1 : 1.1)));
        self.circleRadius = circle.r;
        self.setShape(region, circle);
      },
      onKey(e) {
        if (e.type !== 'keydown') return true;
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') return 'FINISHED';
        if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') circle.r = Math.min(400, circle.r * 1.1);
        else if (e.key === '-' || e.code === 'NumpadSubtract') circle.r = Math.max(5, circle.r / 1.1);
        self.circleRadius = circle.r;
        self.setShape(region, circle);
        return true;
      },
      cancel: end,
      finish: end,
    });
  }

  /** Lasso select: draw a freehand shape from `e`; on release, strips inside it are (de)selected. */
  startLasso(e: { clientX: number; clientY: number }, mode: 'SET' | 'ADD' | 'SUB' = 'SET', first?: { clientX: number; clientY: number }) {
    if (!hasEditor()) return;
    const region = this.hover === 'preview' ? 'preview' : 'timeline';
    const o = this.regionOrigin(region);
    const pts: [number, number][] = [[e.clientX - o.left, e.clientY - o.top]];
    if (first) pts.push([first.clientX - o.left, first.clientY - o.top]);
    const shape = { kind: 'lasso' as const, pts };
    this.setShape(region, shape);
    const move = (ev: PointerEvent) => {
      pts.push([ev.clientX - o.left, ev.clientY - o.top]);
      this.setShape(region, shape);
    };
    const up = () => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      this.setShape(region, null);
      const poly = pts.map(([x, y]) => [x + o.left, y + o.top] as [number, number]);
      if (mode === 'SET') deselectAll();
      this.applyShape(this.shapeHits(region, (r) => rectLasso(r, poly)), mode !== 'SUB', region);
      app.pushUndo('Lasso Select');
      app.changed('doc');
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
  }

  private previewBox(e: { clientX: number; clientY: number }, mode: 'SET' | 'ADD' | 'SUB') {
    const r = this.preview.el.getBoundingClientRect();
    const x0 = e.clientX,
      y0 = e.clientY;
    this.preview.boxRect = { x0: x0 - r.left, y0: y0 - r.top, x1: x0 - r.left, y1: y0 - r.top };
    const move = (ev: PointerEvent) => {
      this.preview.boxRect = { x0: x0 - r.left, y0: y0 - r.top, x1: ev.clientX - r.left, y1: ev.clientY - r.top };
      this.preview.draw();
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      this.preview.boxRect = null;
      const hits = this.preview.stripsInRect(Math.min(x0, ev.clientX), Math.min(y0, ev.clientY), Math.max(x0, ev.clientX), Math.max(y0, ev.clientY));
      if (mode === 'SET') deselectAll();
      for (const s of hits) s.select = mode !== 'SUB';
      app.pushUndo('Box Select');
      app.changed('select');
      this.redraw();
      this.preview.draw();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  scrub(e: PointerEvent) {
    const ts = toolSettings();
    const snapOn = (ev: PointerEvent) => !!ts.use_snap_current_frame_to_strips && (app.doc.scene.tool_settings.use_snap_sequencer ?? true) !== (ev.ctrlKey || ev.metaKey);
    const set = (ev: PointerEvent) => {
      let f = Math.round(this.pointerFrame(ev.clientX));
      if (snapOn(ev) && hasEditor()) {
        // the nearest strip edge within the snapping distance
        const d = S.snapOffset([f], S.snapTargets(seqList(), new Set(), { ignoreMuted: ts.snap_ignore_muted, ignoreSound: ts.snap_ignore_sound }), ts.snap_distance / Math.max(1e-6, this.ppf));
        if (d !== null) f += d;
      }
      if (f !== app.doc.scene.frame_current) app.setFrame(f);
    };
    set(e);
    const up = () => {
      removeEventListener('pointermove', set);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', set);
    addEventListener('pointerup', up);
  }

  private markerDown(e: PointerEvent, x: number) {
    const markers = app.doc.scene.timeline_markers;
    let best: (typeof markers)[number] | null = null,
      bd = 7;
    for (const m of markers) {
      const d = Math.abs(this.fx(m.frame) - x);
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    if (!best) {
      if (!e.shiftKey) markers.forEach((m) => (m.select = false));
      app.changed('ui');
      this.redraw();
      return;
    }
    if (e.shiftKey) best.select = !best.select;
    else if (!best.select) {
      markers.forEach((m) => (m.select = false));
      best.select = true;
    }
    const sel = markers.filter((m) => m.select);
    const orig = sel.map((m) => m.frame);
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const df = Math.round((ev.clientX - x0) / this.ppf);
      if (Math.abs(ev.clientX - x0) > 3) moved = true;
      if (!moved) return;
      sel.forEach((m, i) => (m.frame = orig[i] + df));
      this.redraw();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      app.pushUndo(moved ? 'Move Markers' : 'Select Marker');
      app.changed('doc');
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    this.redraw();
  }

  private dragPan(e: PointerEvent) {
    let lx = e.clientX,
      ly = e.clientY;
    const move = (ev: PointerEvent) => {
      this.x0 -= (ev.clientX - lx) / this.ppf;
      this.cy0 = Math.max(0.4, Math.min(MAX_CHANNELS - 2, this.cy0 + (ev.clientY - ly) / this.chH));
      lx = ev.clientX;
      ly = ev.clientY;
      this.drawChannels();
      this.redraw();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  private dragZoom(e: PointerEvent) {
    const { x: ax } = this.local(e);
    let lx = e.clientX,
      ly = e.clientY;
    const move = (ev: PointerEvent) => {
      const f = this.xf(ax);
      this.ppf = Math.max(0.01, Math.min(400, this.ppf * Math.exp((ev.clientX - lx) * 0.01)));
      this.x0 = f - ax / this.ppf;
      this.chH = Math.max(14, Math.min(160, this.chH * Math.exp(-(ev.clientY - ly) * 0.01)));
      lx = ev.clientX;
      ly = ev.clientY;
      this.drawChannels();
      this.redraw();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  // ------------------------------------------------------------------ preview input

  private onPreviewWheel(e: WheelEvent) {
    e.preventDefault();
    if (app.modal) return;
    if (e.ctrlKey && Math.abs(e.deltaY) < 50) this.preview.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey) {
      this.preview.panX -= e.deltaX;
      this.preview.fitted = false;
      this.preview.draw();
    } else this.preview.zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
  }

  private onPreviewDown(e: PointerEvent) {
    if (app.modal) return;
    app.activeArea = this.area;
    this.hover = 'preview';
    if (e.button === 1) {
      e.preventDefault();
      let lx = e.clientX,
        ly = e.clientY;
      const move = (ev: PointerEvent) => {
        this.preview.panX += ev.clientX - lx;
        this.preview.panY += ev.clientY - ly;
        this.preview.fitted = false;
        lx = ev.clientX;
        ly = ev.clientY;
        this.preview.draw();
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      return;
    }
    if ((annotateKeyHeld() && (e.button === 0 || e.button === 2)) || (e.button === 0 && isAnnotateTool(this.pvTool) && !editedText())) {
      const mode = annotateKeyHeld() ? (e.button === 2 ? 'ERASER' : e.altKey ? (e.shiftKey ? 'DRAW_POLY' : 'DRAW_STRAIGHT') : 'DRAW') : annotateModeOf(this.pvTool as AnnotateTool);
      annotatePointerDown(this.preview, e, mode);
      return;
    }
    if (e.button === 2) {
      e.preventDefault();
      if (e.shiftKey) {
        // Shift right click places the 2D cursor
        const [fx, fy] = this.preview.toFrame(e.clientX, e.clientY);
        setCursorPoint(fx, fy);
        app.pushUndo('Set 2D Cursor');
        app.changed('ui');
        this.preview.draw();
        return;
      }
      openMenu(stripMenu(true), { x: e.clientX, y: e.clientY });
      return;
    }
    if (e.button !== 0 || !hasEditor()) return;
    const editing = editedText();
    if (editing) {
      const [fx, fy] = this.preview.toFrame(e.clientX, e.clientY);
      if (hitsText(editing, fx, fy)) return this.textDrag(editing, e);
      endTextEdit();
    }
    const hit = this.preview.stripAt(e.clientX, e.clientY);
    const x0 = e.clientX,
      y0 = e.clientY;
    if (this.pvTool === 'sample') {
      const r = this.preview.el.getBoundingClientRect();
      const show = (ev: { clientX: number; clientY: number }) => {
        const v = this.preview.sample(ev.clientX, ev.clientY);
        this.preview.sampleInfo = v ? { x: ev.clientX - r.left, y: ev.clientY - r.top, ...v } : null;
        this.preview.draw();
      };
      show(e);
      const up = () => {
        removeEventListener('pointermove', show);
        removeEventListener('pointerup', up);
        this.preview.sampleInfo = null;
        this.preview.draw();
      };
      addEventListener('pointermove', show);
      addEventListener('pointerup', up);
      return;
    }
    if (this.pvTool === 'cursor') {
      const place = (ev: { clientX: number; clientY: number }) => {
        const [fx, fy] = this.preview.toFrame(ev.clientX, ev.clientY);
        setCursorPoint(fx, fy);
        this.preview.draw();
      };
      place(e);
      const up = () => {
        removeEventListener('pointermove', place);
        removeEventListener('pointerup', up);
        app.pushUndo('Set 2D Cursor');
        app.changed('ui');
      };
      addEventListener('pointermove', place);
      addEventListener('pointerup', up);
      return;
    }
    const pmode = e.shiftKey ? 'ADD' : e.ctrlKey || e.metaKey ? 'SUB' : 'SET';
    if (this.pvTool === 'select_circle') return this.startCircle(pmode, e);
    if (this.pvTool === 'select_lasso') {
      let dragging = false;
      const move = (ev: PointerEvent) => {
        if (dragging || Math.hypot(ev.clientX - x0, ev.clientY - y0) <= 4) return;
        dragging = true;
        cleanup();
        this.startLasso(e, pmode, ev);
      };
      const up = () => {
        cleanup();
        if (dragging) return;
        if (!hit) {
          if (!e.shiftKey) selectStrip(null, {});
        } else selectStrip(hit, { extend: e.shiftKey, toggle: e.shiftKey && hit.select, ignoreConnections: true });
        app.pushUndo('Select');
        app.changed('select');
      };
      const cleanup = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
      return;
    }
    if (this.pvTool === 'transform') {
      const r = this.preview.el.getBoundingClientRect();
      const part = this.preview.cagePart(x0 - r.left, y0 - r.top);
      if (!part) {
        // nothing selected yet: a click selects
        if (hit) selectStrip(hit, { extend: e.shiftKey });
        app.pushUndo('Select');
        app.changed('select');
        return;
      }
      startPreviewTransform(this, part === 'MOVE' ? 'TRANSLATE' : part === 'SCALE' ? 'RESIZE' : 'ROTATE', x0, y0, true);
      return;
    }
    if (this.pvTool !== 'select') {
      if (hit && !hit.select) selectStrip(hit, { extend: e.shiftKey });
      app.changed('select');
      const mode = this.pvTool === 'move' ? 'TRANSLATE' : this.pvTool === 'rotate' ? 'ROTATE' : 'RESIZE';
      startPreviewTransform(this, mode, x0, y0, true);
      return;
    }
    const wasSelected = !!hit?.select;
    if (hit && !hit.select) {
      selectStrip(hit, { extend: e.shiftKey });
      app.changed('select');
    }
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) {
        dragging = true;
        cleanup();
        if (hit) startPreviewTransform(this, 'TRANSLATE', x0, y0, true);
        else this.previewBox({ clientX: x0, clientY: y0 }, e.shiftKey ? 'ADD' : e.ctrlKey || e.metaKey ? 'SUB' : 'SET');
      }
    };
    const up = () => {
      cleanup();
      if (dragging) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl) {
        // Ctrl click: the strip whose image centre is nearest
        const near = this.preview.stripNearestCenter(x0, y0);
        if (near) selectStrip(near, { extend: e.shiftKey });
      } else if (!hit) {
        if (!e.shiftKey) selectStrip(null, {});
      } else if (e.shiftKey && wasSelected) selectStrip(hit, { toggle: true });
      else if (!e.shiftKey) {
        // clicking the active strip again cycles to the one below it
        const under = this.preview.stripsAt(x0, y0);
        const pick = wasSelected && activeStrip() === hit && under.length > 1 ? under[(under.indexOf(hit) + 1) % under.length] : hit;
        selectStrip(pick, {});
      }
      app.pushUndo('Select');
      app.changed('select');
    };
    const cleanup = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  /** Click / drag in the edited text: place the cursor, Shift extends, dragging selects. */
  private textDrag(s: Strip, e: PointerEvent) {
    e.preventDefault();
    const at = (ev: { clientX: number; clientY: number }) => indexAt(s, ...this.preview.toFrame(ev.clientX, ev.clientY));
    textEdit.cursor = at(e);
    if (!e.shiftKey) textEdit.anchor = textEdit.cursor;
    this.preview.draw();
    const move = (ev: PointerEvent) => {
      textEdit.cursor = at(ev);
      this.preview.draw();
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  // ------------------------------------------------------------------ keys

  onKey(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.code === 'KeyN' && !ctrl && !e.shiftKey && !e.altKey) {
      this.toggleSidebar();
      return true;
    }
    if (e.code === 'KeyT' && !ctrl && !e.shiftKey && !e.altKey) {
      this.toggleToolbar();
      return true;
    }
    if (e.code === 'KeyT' && ctrl && !e.shiftKey && !e.altKey) {
      this.showSeconds = !this.showSeconds;
      this.redraw();
      app.changed('ui');
      return true;
    }
    if (e.code === 'Backquote' && ctrl && !e.shiftKey && !e.altKey && this.hasPreview()) {
      this.showGizmo = !this.showGizmo;
      this.drawPreviewNav();
      return true;
    }
    if (e.code === 'Tab' && ctrl && !e.shiftKey) {
      this.setView(this.view === 'SEQUENCER' ? 'PREVIEW' : 'SEQUENCER');
      return true;
    }
    if (e.code === 'Tab' && e.shiftKey && !ctrl) {
      const ts = app.doc.scene.tool_settings;
      ts.use_snap_sequencer = !(ts.use_snap_sequencer ?? true);
      app.changed('ui');
      return true;
    }
    return false;
  }
}

/** Small chain-link glyph marking connected strips (centred vertically on y). */
function drawLink(g: CanvasRenderingContext2D, x: number, y: number) {
  g.save();
  g.strokeStyle = 'rgba(255, 255, 255,0.9)';
  g.lineWidth = 1.4;
  g.beginPath();
  roundRect(g, x, y - 2.5, 6, 5, 2.5);
  g.stroke();
  g.beginPath();
  roundRect(g, x + 4, y - 2.5, 6, 5, 2.5);
  g.stroke();
  g.restore();
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, hh / 2));
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + hh, r);
  g.arcTo(x + w, y + hh, x, y + hh, r);
  g.arcTo(x, y + hh, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export type { MenuItem };
