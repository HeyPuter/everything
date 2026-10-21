// Graph Editor: F-Curves drawn in a 2D time/value view with keyframes, Bézier
// handles, extrapolation and F-Modifiers; sidebar with F-Curve / Modifiers / View tabs.
import { h, type Child } from '../ui/h';
import { icon } from '../ui/icons';
import { app, registerOperators, type OpContext } from '../app/app';
import { registerEditor, type Area } from '../ui/screen';
import { openMenu, type MenuItem } from '../ui/menu';
import type { FCurve, Keyframe } from '../data/types';
import { AnimEditor, RULER_H, menuButton, hdrToggle, markerMenu, type SidebarTab, type Selectable } from './animeditor';
import { channelCurves, type Channel, type CurveRef, type SpaceKind } from './channels';
import { C, curveColor, HANDLE_COLORS } from './theme';
import { valueStep, formatValue, animSettings } from './view2d';
import { evaluateFCurve } from '../anim/fcurve';
import { lassoGesture } from './selecttools';
import { curveDisplayFactor } from './units';
import { setKeySelected, selectAll, selectColumns, keyBounds, isAnySelected } from './keyedit';
import { startKeyTransform, type KeyTransformHost, type KeyTransformMode } from './transformkeys';
import { proportionalOf, proportionalHeader } from './proportional';
import { viewMenuCommon, selectMenu, channelMenu, keyMenu } from './menus';
import { drawFCurveSidebar, drawModifiersSidebar } from './graphsidebar';
import { numberField, checkbox, button } from '../ui/widgets';

type Pick = { r: CurveRef; k: Keyframe; part: 'co' | 'l' | 'r' } | null;

export const curveId = (r: CurveRef) => `${r.ob.id}|${r.action.id}|${r.fc.data_path}|${r.fc.array_index}`;

export class GraphEditor extends AnimEditor {
  keymaps = ['Markers', 'Animation Channels', 'Graph Editor', 'Animation'];
  prefix = 'graph' as const;
  protected rowScroll = false;
  normalize = false;
  /** Auto Normalization: recompute the normalization as curves change */
  autoNormalize = true;
  showHandles = true;
  onlySelectedHandles = true;
  /** curves continue past their first and last keys (View ▸ Show Extrapolation) */
  showExtrapolation = true;
  showCursor = true;
  cursorValue = 0;
  pivot: 'BOUNDING_BOX_CENTER' | 'CURSOR' = 'BOUNDING_BOX_CENTER';
  activeKey: string | null = null;
  activeKeyFrame: number | null = null;
  /** faded snapshot of curves (Create Ghost Curves): frame/value pairs */
  ghosts: { fc: FCurve; pts: number[] }[] = [];
  /** Local View: ids of the curves shown (null = all) */
  localView: Set<string> | null = null;
  private normCache = new Map<FCurve, { offset: number; factor: number }>();

  constructor(area: Area, state?: unknown) {
    super(area, state);
    const s = (state ?? {}) as Record<string, unknown>;
    if (typeof s.normalize === 'boolean') this.normalize = s.normalize;
    if (typeof s.showHandles === 'boolean') this.showHandles = s.showHandles;
    if (typeof s.onlySelectedHandles === 'boolean') this.onlySelectedHandles = s.onlySelectedHandles;
    if (typeof s.showExtrapolation === 'boolean') this.showExtrapolation = s.showExtrapolation;
    if (typeof s.cursorValue === 'number') this.cursorValue = s.cursorValue;
  }

  protected serializeExtra() {
    return {
      normalize: this.normalize,
      showHandles: this.showHandles,
      onlySelectedHandles: this.onlySelectedHandles,
      showExtrapolation: this.showExtrapolation,
      cursorValue: this.cursorValue,
    };
  }

  space(): SpaceKind {
    return 'GRAPH';
  }

  editCurves(): CurveRef[] {
    return this.list.curves.filter((r) => !r.fc.lock && !r.fc.hide);
  }

  visibleCurves(): CurveRef[] {
    return this.list.curves.filter((r) => !r.fc.hide);
  }

  activeCurve(): CurveRef | null {
    const vis = this.visibleCurves();
    return vis.find((r) => curveId(r) === this.activeKey) ?? vis.find((r) => r.fc.select) ?? null;
  }

  /** active keyframe of the active curve */
  activeKeyframe(): Keyframe | null {
    const r = this.activeCurve();
    if (!r) return null;
    const ks = r.fc.keyframe_points;
    if (this.activeKeyFrame !== null) {
      const k = ks.find((x) => Math.abs(x.co[0] - this.activeKeyFrame!) < 1e-3 && isAnySelected(x));
      if (k) return k;
    }
    return ks.find(isAnySelected) ?? null;
  }

  protected onActiveCurve(ch: Channel) {
    if (ch.fc && ch.ob && ch.action) this.activeKey = curveId({ ob: ch.ob, action: ch.action, fc: ch.fc });
  }

  // ---------------------------------------------------------------- normalization

  private norm(fc: FCurve) {
    if (!this.normalize) return { offset: 0, factor: 1 };
    let n = this.normCache.get(fc);
    if (!n) {
      let lo = Infinity,
        hi = -Infinity;
      for (const k of fc.keyframe_points) {
        lo = Math.min(lo, k.co[1]);
        hi = Math.max(hi, k.co[1]);
        if (k.interpolation === 'BEZIER') {
          lo = Math.min(lo, k.handle_left[1], k.handle_right[1]);
          hi = Math.max(hi, k.handle_left[1], k.handle_right[1]);
        }
      }
      if (lo === Infinity || hi - lo < 1e-9) n = { offset: lo === Infinity ? 0 : -lo, factor: 1 };
      else n = { offset: -(lo + hi) / 2, factor: 2 / (hi - lo) };
      this.normCache.set(fc, n);
    }
    return n;
  }
  /** stored value → displayed value (normalized, or in display units such as degrees) */
  toDisp(fc: FCurve, v: number) {
    if (!this.normalize) return v * curveDisplayFactor(app.doc, fc);
    const n = this.norm(fc);
    return (v + n.offset) * n.factor;
  }
  fromDisp(fc: FCurve, d: number) {
    if (!this.normalize) return d / curveDisplayFactor(app.doc, fc);
    const n = this.norm(fc);
    return d / n.factor - n.offset;
  }
  toDispValue(r: CurveRef, v: number) {
    return this.toDisp(r.fc, v);
  }
  fromDispValue(r: CurveRef, d: number) {
    return this.fromDisp(r.fc, d);
  }
  px(x: number) {
    return this.view.fx(x);
  }
  py(d: number) {
    return RULER_H + this.view.vy(d);
  }

  // ---------------------------------------------------------------- header / menus

  header(): Child {
    return h(
      'div',
      { class: 'hdr-row' },
      menuButton('View', () => this.viewMenu()),
      menuButton('Select', () => selectMenu('graph')),
      menuButton('Marker', markerMenu),
      menuButton('Channel', () => channelMenu('graph')),
      menuButton('Key', () => keyMenu('graph')),
      h(
        'button',
        {
          key: 'norm',
          class: { 'hdr-toggle': true, wide: true, on: this.normalize },
          'data-tip': 'Normalize\nDisplay curves in normalized range from -1 to 1, for easier editing of multiple curves with different ranges',
          onclick: () => this.setNormalize(!this.normalize),
        },
        icon('graph'),
        'Normalize',
      ),
      this.normalize
        ? hdrToggle('auto-norm', 'file_refresh', this.autoNormalize, 'Auto Normalization\nRecalculate the normalization while editing (off: keep the current factors)', () => {
            this.autoNormalize = !this.autoNormalize;
            if (this.autoNormalize) this.normCache.clear();
            this.draw();
            app.changed('ui');
          })
        : null,
      h('div', { class: 'hdr-spacer' }),
      hdrToggle(
        'only-sel',
        'restrict_select_off',
        this.onlySelected,
        'Only Show Selected\nOnly include channels relating to selected objects and data',
        () => ((this.onlySelected = !this.onlySelected), this.refresh(), app.changed('ui')),
      ),
      hdrToggle(
        'show-hidden',
        'hide_off',
        this.showHidden,
        'Show Hidden\nInclude channels from objects/bone that are not visible',
        () => ((this.showHidden = !this.showHidden), this.refresh(), app.changed('ui')),
      ),
      h(
        'button',
        {
          key: 'pivot',
          class: 'hdr-toggle',
          'data-tip': 'Pivot Point\nPivot center for rotation/scaling',
          onpointerdown: (e: PointerEvent) => {
            e.preventDefault();
            openMenu(
              [
                {
                  label: 'Bounding Box Center',
                  icon: 'pivot_boundbox',
                  active: this.pivot === 'BOUNDING_BOX_CENTER',
                  action: () => ((this.pivot = 'BOUNDING_BOX_CENTER'), app.changed('ui')),
                },
                {
                  label: '2D Cursor',
                  icon: 'pivot_cursor',
                  active: this.pivot === 'CURSOR',
                  action: () => ((this.pivot = 'CURSOR'), app.changed('ui')),
                },
              ],
              e.currentTarget as HTMLElement,
              { title: 'Pivot Point' },
            );
          },
        },
        icon(this.pivot === 'CURSOR' ? 'pivot_cursor' : 'pivot_boundbox'),
        icon('down_arrow_hlt', 'tiny'),
      ),
      this.errorsToggle(),
      this.filtersHeader(),
      this.snapHeader('keyframes'),
      proportionalHeader('use_proportional_fcurve'),
    );
  }

  setNormalize(v: boolean) {
    this.normalize = v;
    this.normCache.clear();
    this.fitValues();
    app.changed('ui');
    this.refresh();
  }

  viewMenu(): MenuItem[] {
    return [
      {
        label: 'Sidebar',
        checked: this.showSidebar,
        shortcut: 'N',
        action: () => this.toggleSidebar(),
      },
      this.channelsMenuItem(),
      { separator: true },
      {
        label: 'Show Cursor',
        checked: this.showCursor,
        action: () => ((this.showCursor = !this.showCursor), this.draw()),
      },
      {
        label: 'Show Markers',
        checked: this.showMarkers,
        action: () => ((this.showMarkers = !this.showMarkers), this.refresh()),
      },
      {
        label: 'Show Extrapolation',
        checked: this.showExtrapolation,
        action: () => ((this.showExtrapolation = !this.showExtrapolation), this.draw()),
      },
      {
        label: 'Show Handles',
        checked: this.showHandles,
        shortcut: 'Ctrl H',
        action: () => ((this.showHandles = !this.showHandles), this.draw()),
      },
      {
        label: 'Only Selected Keyframes Handles',
        checked: this.onlySelectedHandles,
        action: () => ((this.onlySelectedHandles = !this.onlySelectedHandles), this.draw()),
      },
      ...viewMenuCommon('graph', this),
    ];
  }

  protected mainContextMenu(): MenuItem[] {
    const km = keyMenu('graph');
    const sub = (label: string) => km.find((i) => i.label === label)!.submenu!;
    return [
      { heading: 'F-Curve' },
      { label: 'Copy', op: 'graph.copy', shortcut: 'Ctrl C' },
      { label: 'Paste', op: 'graph.paste', shortcut: 'Ctrl V' },
      {
        label: 'Paste Flipped',
        op: 'graph.paste',
        props: { flipped: true },
        shortcut: 'Shift Ctrl V',
      },
      { separator: true },
      { label: 'Handle Type', submenu: sub('Handle Type') },
      { label: 'Interpolation Mode', submenu: sub('Interpolation Mode') },
      { label: 'Easing Mode', submenu: sub('Easing Mode') },
      { separator: true },
      { label: 'Insert Keyframes', op: 'graph.keyframe_insert', shortcut: 'I' },
      { label: 'Duplicate', op: 'graph.duplicate_move', shortcut: 'Shift D' },
      { label: 'Delete Keyframes', op: 'graph.delete', shortcut: 'X' },
      { separator: true },
      { label: 'Mirror', submenu: sub('Mirror') },
      { label: 'Snap', submenu: sub('Snap') },
    ];
  }

  channelContextMenu(): MenuItem[] {
    return channelMenu('graph');
  }

  // ---------------------------------------------------------------- channel rows

  protected rowPrefix(ch: Channel): Child {
    const fcs = channelCurves(ch);
    if (!fcs.length || ch.kind === 'SUMMARY' || ch.kind === 'ACTION' || ch.kind === 'SLOT') return null;
    const hidden = fcs.every((f) => f.hide);
    const out: Child[] = [];
    const pin = this.pinToggle(ch);
    if (pin) out.push(pin);
    out.push(
      h(
        'button',
        {
          key: 'eye',
          class: { 'anim-tg': true, off: hidden },
          'data-tip': 'Visibility\nF-Curve visibility in Graph Editor',
          onpointerdown: (e: PointerEvent) => (e.stopPropagation(), e.button === 0 && this.toggleSetting(ch, 'hide')),
        },
        icon(hidden ? 'hide_on' : 'hide_off'),
      ),
    );
    if (ch.kind === 'FCURVE' && ch.fc) {
      const i = this.list.curves.findIndex((r) => r.fc === ch.fc);
      out.unshift(
        h('span', {
          key: 'color',
          class: 'anim-swatch',
          style: { background: curveColor(ch.fc, i, this.list.curves.length) },
        }),
      );
    }
    return out;
  }

  /** F-Curve rows start with their colour swatch where other rows have the expander. */
  protected expanderSpace(ch: Channel): boolean {
    return ch.kind !== 'FCURVE';
  }

  protected rowToggles(ch: Channel): Child {
    return [this.modifierToggle(ch), channelCurves(ch).length ? this.muteLockToggles(ch) : null];
  }

  // ---------------------------------------------------------------- drawing

  protected fitInitial(W: number) {
    super.fitInitial(W);
    this.fitValues();
  }

  fitValues() {
    this.normCache.clear();
    this.view.height = Math.max(1, this.contentBottom() - RULER_H);
    let lo = Infinity,
      hi = -Infinity;
    for (const r of this.visibleCurves())
      for (const k of r.fc.keyframe_points) {
        for (const v of [k.co[1], ...(k.interpolation === 'BEZIER' ? [k.handle_left[1], k.handle_right[1]] : [])]) {
          const d = this.toDisp(r.fc, v);
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
      }
    if (lo === Infinity) {
      lo = -1;
      hi = 1;
    }
    this.view.fitY(lo, hi, 40);
  }

  refresh() {
    // with Auto Normalization off the factors stay as they were when it was turned off
    if (!app.modal && this.autoNormalize) this.normCache.clear();
    super.refresh();
  }

  rebuild() {
    super.rebuild();
    const lv = this.localView;
    if (!lv) return;
    const keep = (r: CurveRef) => lv.has(curveId(r));
    const list = this.list;
    this.list = { rows: list.rows.filter((ch) => ch.kind === 'SUMMARY' || ch.curves.some(keep)), curves: list.curves.filter(keep) };
  }

  protected drawContent(g: CanvasRenderingContext2D, W: number, H: number) {
    const v = this.view;
    // horizontal grid + value labels
    const step = valueStep(v.ppv, 36);
    const bottom = this.contentBottom();
    const vTop = v.yv(0),
      vBot = v.yv(bottom - RULER_H);
    g.font = '11px Inter, system-ui, sans-serif';
    g.textAlign = 'left';
    for (let val = Math.floor(vBot / step) * step; val <= vTop + step; val += step) {
      const y = Math.round(this.py(val)) + 0.5;
      g.strokeStyle = Math.abs(val) < step / 2 ? 'rgba(0, 0, 0,0.45)' : C.grid;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
      g.fillStyle = C.rulerText;
      g.fillText(formatValue(Math.abs(val) < step / 1e6 ? 0 : val, step), 4, y - 3);
    }
    // 2D cursor value line
    if (this.showCursor) {
      const y = Math.round(this.py(this.cursorValue)) + 0.5;
      g.strokeStyle = C.cursorLine;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
    }
    if (this.ghosts.length) {
      g.save();
      g.globalAlpha = 0.35;
      g.lineWidth = 2;
      g.strokeStyle = C.rulerText;
      for (const gh of this.ghosts) {
        g.beginPath();
        for (let i = 0; i < gh.pts.length; i += 2) {
          const x = this.px(gh.pts[i]),
            y = this.py(this.toDisp(gh.fc, gh.pts[i + 1]));
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.stroke();
      }
      g.restore();
    }
    const curves = this.list.curves;
    const active = this.activeCurve();
    // unselected curves first, then selected, then active on top
    const order = curves.map((r, i) => ({ r, i })).filter((x) => !x.r.fc.hide);
    order.sort((a, b) => rank(a.r) - rank(b.r));
    function rank(r: CurveRef) {
      return r === active ? 2 : r.fc.select ? 1 : 0;
    }
    for (const { r, i } of order) this.drawCurve(g, r, curveColor(r.fc, i, curves.length), r.fc.select || r === active, W);
    for (const { r } of order) if (!animSettings.onlySelectedKeys || r.fc.select || r === active) this.drawPoints(g, r, r === active);
    void H;
  }

  private drawCurve(g: CanvasRenderingContext2D, r: CurveRef, color: string, selected: boolean, W: number) {
    const fc = r.fc;
    if (!fc.keyframe_points.length && !fc.sampled_points?.length && !fc.modifiers.some((m) => m.type === 'GENERATOR')) {
      // a driver curve without keys passes the driver value through: show that as the line y = x
      if (this.space() === 'DRIVERS' && !fc.modifiers.length) {
        const x0 = this.view.xf(0),
          x1 = this.view.xf(W);
        g.strokeStyle = color;
        g.globalAlpha = selected ? 1 : animSettings.unselectedAlpha;
        g.lineWidth = selected ? 1.6 : 1.2;
        g.beginPath();
        g.moveTo(this.px(x0), this.py(this.toDisp(fc, x0)));
        g.lineTo(this.px(x1), this.py(this.toDisp(fc, x1)));
        g.stroke();
        g.globalAlpha = 1;
        g.lineWidth = 1;
      }
      return;
    }
    g.strokeStyle = color;
    g.globalAlpha = selected ? 1 : animSettings.unselectedAlpha;
    g.lineWidth = selected ? 1.6 : 1.2;
    if (fc.mute) g.setLineDash([6, 4]);
    if (fc.lock) g.globalAlpha *= 0.6;
    g.beginPath();
    const v = this.view;
    const k = fc.keyframe_points;
    const pt = (x: number, val: number, first: boolean) => {
      const sx = this.px(x),
        sy = this.py(this.toDisp(fc, val));
      if (first) g.moveTo(sx, sy);
      else g.lineTo(sx, sy);
    };
    if (fc.modifiers.some((m) => !m.mute) || !k.length) {
      for (let x = 0; x <= W; x += 1.5) pt(v.xf(x), evaluateFCurve(fc, v.xf(x)), x === 0);
    } else {
      const left = this.showExtrapolation ? v.xf(-2) : k[0].co[0],
        right = this.showExtrapolation ? v.xf(W + 2) : k[k.length - 1].co[0];
      pt(Math.min(left, k[0].co[0]), evaluateFCurve(fc, Math.min(left, k[0].co[0])), true);
      for (let i = 0; i < k.length; i++) {
        const a = k[i],
          b = k[i + 1];
        pt(a.co[0], a.co[1], false);
        if (!b) break;
        if (b.co[0] < left || a.co[0] > right) continue;
        if (a.interpolation === 'CONSTANT') pt(b.co[0], a.co[1], false);
        else if (a.interpolation !== 'LINEAR') {
          const x0 = Math.max(a.co[0], left),
            x1 = Math.min(b.co[0], right);
          const n = Math.max(2, Math.ceil(((x1 - x0) * v.ppf) / 2));
          for (let j = 1; j < n; j++) {
            const x = x0 + ((x1 - x0) * j) / n;
            pt(x, evaluateFCurve(fc, x), false);
          }
        }
      }
      const last = k[k.length - 1];
      const end = this.showExtrapolation ? Math.max(right, last.co[0]) : last.co[0];
      pt(end, evaluateFCurve(fc, end), false);
    }
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
    g.lineWidth = 1;
  }

  handlesShown(k: Keyframe) {
    return this.showHandles && k.interpolation === 'BEZIER' && (!this.onlySelectedHandles || isAnySelected(k));
  }

  private drawPoints(g: CanvasRenderingContext2D, r: CurveRef, isActive: boolean) {
    const fc = r.fc;
    const k = fc.keyframe_points;
    const activeKey = isActive ? this.activeKeyframe() : null;
    for (let i = 0; i < k.length; i++) {
      const kf = k[i];
      const prevBezier = i === 0 || k[i - 1].interpolation === 'BEZIER';
      const x = this.px(kf.co[0]),
        y = this.py(this.toDisp(fc, kf.co[1]));
      if (x < -50 || x > this.mainW + 50) continue;
      if (this.handlesShown(kf) || (this.showHandles && !this.onlySelectedHandles && prevBezier && kf.interpolation !== 'BEZIER')) {
        const sides: ['l' | 'r', [number, number], Keyframe['handle_left_type'], boolean][] = [];
        if (prevBezier) sides.push(['l', kf.handle_left, kf.handle_left_type, !!kf.select_left_handle]);
        if (kf.interpolation === 'BEZIER') sides.push(['r', kf.handle_right, kf.handle_right_type, !!kf.select_right_handle]);
        for (const [, hp, ht, hs] of sides) {
          const hx = this.px(hp[0]),
            hy = this.py(this.toDisp(fc, hp[1]));
          g.strokeStyle = HANDLE_COLORS[ht][hs || kf.select_control_point ? 1 : 0];
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(hx, hy);
          g.stroke();
          g.beginPath();
          g.arc(hx, hy, 3, 0, Math.PI * 2);
          g.fillStyle = hs ? C.vertexSelect : '#161719';
          g.fill();
          g.strokeStyle = hs ? C.vertexSelect : HANDLE_COLORS[ht][0];
          g.stroke();
        }
      }
      const sel = !!kf.select_control_point;
      g.beginPath();
      g.arc(x, y, 3.5, 0, Math.PI * 2);
      g.fillStyle = kf === activeKey ? C.vertexActive : sel ? C.vertexSelect : C.vertex;
      g.fill();
      g.strokeStyle = sel ? 'rgba(0, 0, 0,0.6)' : 'rgba(255, 255, 255,0.75)';
      g.lineWidth = 1;
      g.stroke();
    }
  }

  // ---------------------------------------------------------------- picking

  pick(x: number, y: number): Pick {
    let best: Pick = null,
      bd = 8;
    for (const r of this.editCurves()) {
      const fc = r.fc;
      fc.keyframe_points.forEach((k, i) => {
        const prevBezier = i === 0 || fc.keyframe_points[i - 1].interpolation === 'BEZIER';
        const test = (px: number, py: number, part: 'co' | 'l' | 'r') => {
          const d = Math.hypot(px - x, py - y);
          if (d < bd || (d <= bd + 0.5 && part === 'co')) {
            bd = d;
            best = { r, k, part };
          }
        };
        if (this.handlesShown(k)) {
          if (prevBezier) test(this.px(k.handle_left[0]), this.py(this.toDisp(fc, k.handle_left[1])), 'l');
          test(this.px(k.handle_right[0]), this.py(this.toDisp(fc, k.handle_right[1])), 'r');
        }
        test(this.px(k.co[0]), this.py(this.toDisp(fc, k.co[1])), 'co');
      });
    }
    return best;
  }

  pickCurve(x: number, y: number): CurveRef | null {
    const f = this.view.xf(x);
    let best: CurveRef | null = null,
      bd = 6;
    for (const r of this.editCurves()) {
      if (!r.fc.keyframe_points.length && !r.fc.sampled_points?.length) continue;
      const d = Math.abs(this.py(this.toDisp(r.fc, evaluateFCurve(r.fc, f))) - y);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    return best;
  }

  keyHost(): KeyTransformHost {
    return {
      transformCurves: () => this.editCurves(),
      graph: true,
      ppf: () => this.view.ppf,
      ppv: () => this.view.ppv,
      toDisp: (fc, v) => this.toDisp(fc, v),
      fromDisp: (fc, d) => this.fromDisp(fc, d),
      screen: (x, d) => this.toClient(this.px(x), this.py(d)),
      autoSnap: this.autoSnap,
      snapTo: this.snapTo(),
      handlesVisible: (k) => this.handlesShown(k),
      pivot: this.pivot,
      cursorValue: this.cursorValue,
      proportional: proportionalOf('use_proportional_fcurve'),
      autoMerge: this.autoMerge,
    };
  }

  startTransform(mode: KeyTransformMode, start: { x: number; y: number }, releaseConfirm = false, onCancel?: () => void) {
    return startKeyTransform(this.keyHost(), mode, {
      start,
      releaseConfirm,
      redoIdname: 'graph.transform',
      onCancel,
    });
  }

  setActive(r: CurveRef, k?: Keyframe) {
    for (const c of this.list.curves) c.fc.select = false;
    r.fc.select = true;
    this.activeKey = curveId(r);
    this.activeKeyFrame = k ? k.co[0] : null;
  }

  protected mainDown(e: PointerEvent, x: number, y: number) {
    const curves = this.visibleCurves();
    const hit = this.pick(x, y);
    const curveHit = e.altKey && (e.ctrlKey || e.metaKey) ? (hit?.r ?? this.pickCurve(x, y)) : null;
    if (curveHit) {
      // Ctrl+Alt: every key of the curve
      if (!e.shiftKey) selectAll(curves, 'DESELECT');
      curveHit.fc.keyframe_points.forEach((k) => setKeySelected(k, true));
      this.setActive(curveHit);
      app.pushUndo('Select Curve Keys');
      app.changed('doc');
      return;
    }
    if (e.altKey && hit) {
      selectColumns(curves, [hit.k.co[0]], e.shiftKey);
      app.pushUndo('Select Column');
      app.changed('doc');
      return;
    }
    if (hit) {
      const { r, k, part } = hit;
      const isSel = part === 'co' ? !!k.select_control_point : part === 'l' ? !!k.select_left_handle : !!k.select_right_handle;
      const selectHit = (v: boolean) => {
        if (part === 'co') setKeySelected(k, v);
        else if (part === 'l') k.select_left_handle = v;
        else k.select_right_handle = v;
      };
      if (e.shiftKey) {
        selectHit(!isSel);
        if (!isSel) this.setActive(r, k);
        app.pushUndo('Select Keyframes');
        app.changed('doc');
        return;
      }
      if (!isSel) {
        selectAll(curves, 'DESELECT');
        selectHit(true);
        this.setActive(r, k);
        app.changed('doc');
      }
      this.clickOrDrag(
        e,
        () => {
          selectAll(curves, 'DESELECT');
          selectHit(true);
          this.setActive(r, k);
          app.pushUndo('Select Keyframes');
          app.changed('doc');
        },
        (start) => {
          // dragging a handle edits just that handle
          if (part !== 'co') {
            selectAll(curves, 'DESELECT');
            selectHit(true);
          }
          if (!isSel || part !== 'co') app.pushUndo('Select Keyframes');
          this.startTransform('TRANSLATION', { x: start.clientX, y: start.clientY }, true);
        },
      );
      return;
    }
    const curve = this.pickCurve(x, y);
    this.clickOrDrag(
      e,
      () => {
        if (!e.shiftKey) selectAll(curves, 'DESELECT');
        if (curve) {
          curve.fc.keyframe_points.forEach((k) => setKeySelected(k, true));
          this.setActive(curve);
        }
        app.pushUndo(curve ? 'Select Curve' : 'Deselect Keyframes');
        app.changed('doc');
      },
      (start) => this.boxGesture(start, (rect, mode) => this.boxSelect(rect, mode)),
    );
  }

  selectables(includeHandles = true): Selectable[] {
    const out: Selectable[] = [];
    for (const r of this.visibleCurves()) {
      if (r.fc.lock) continue;
      const fc = r.fc;
      fc.keyframe_points.forEach((k, i) => {
        out.push({ x: this.px(k.co[0]), y: this.py(this.toDisp(fc, k.co[1])), selected: !!k.select_control_point, set: (v) => setKeySelected(k, v) });
        if (!includeHandles || !this.handlesShown(k)) return;
        const prevBezier = i === 0 || fc.keyframe_points[i - 1].interpolation === 'BEZIER';
        if (prevBezier) out.push({ x: this.px(k.handle_left[0]), y: this.py(this.toDisp(fc, k.handle_left[1])), selected: !!k.select_left_handle, set: (v) => (k.select_left_handle = v) });
        out.push({ x: this.px(k.handle_right[0]), y: this.py(this.toDisp(fc, k.handle_right[1])), selected: !!k.select_right_handle, set: (v) => (k.select_right_handle = v) });
      });
    }
    return out;
  }

  boxSelect(rect: { x0: number; y0: number; x1: number; y1: number }, mode: 'SET' | 'ADD' | 'SUB') {
    const curves = this.visibleCurves();
    if (mode === 'SET') selectAll(curves, 'DESELECT');
    const inside = (px: number, py: number) => px >= rect.x0 && px <= rect.x1 && py >= rect.y0 && py <= rect.y1;
    const v = mode !== 'SUB';
    for (const r of curves) {
      if (r.fc.lock) continue;
      for (const k of r.fc.keyframe_points) {
        const showH = this.handlesShown(k);
        if (inside(this.px(k.co[0]), this.py(this.toDisp(r.fc, k.co[1])))) {
          setKeySelected(k, v);
        } else if (showH) {
          if (inside(this.px(k.handle_left[0]), this.py(this.toDisp(r.fc, k.handle_left[1])))) k.select_left_handle = v;
          if (inside(this.px(k.handle_right[0]), this.py(this.toDisp(r.fc, k.handle_right[1])))) k.select_right_handle = v;
        }
      }
    }
    app.pushUndo('Box Select');
    app.changed('doc');
  }

  protected onCanvasDown(e: PointerEvent) {
    if (e.button === 2 && this.regionAt(e) === 'main' && !app.modal) {
      // Ctrl+RMB: click inserts a key on the active curve, drag draws a selection lasso
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const { x, y } = this.local(e);
        this.clickOrDrag(
          e,
          () => {
            const frame = this.autoSnap ? Math.round(this.view.xf(x)) : this.view.xf(x);
            app.run('graph.click_insert', { frame, value: this.cursorValueAt(y), extend: e.shiftKey }, { area: this.area, invoke: false });
          },
          (start) => lassoGesture(this, start, e.shiftKey ? 'SUB' : 'ADD', true, 'graph'),
        );
        return;
      }
      // Shift+RMB: place the playhead and cursor value
      if (e.shiftKey) {
        e.preventDefault();
        app.run('graph.cursor_set', {}, { area: this.area });
        return;
      }
    }
    super.onCanvasDown(e);
  }

  /** Display value (cursor space) under a canvas-local y. */
  cursorValueAt(y: number) {
    return this.view.yv(y - RULER_H);
  }

  protected wheelZoom(factor: number, x: number, y: number) {
    this.view.zoomX(factor, x);
    this.view.zoomY(factor, y);
  }

  viewAll() {
    const b = keyBounds(this.visibleCurves(), false, true);
    this.fitTo(b);
  }

  viewSelected() {
    const b = keyBounds(this.visibleCurves(), true, true);
    if (!b) return this.viewAll();
    this.fitTo(b);
  }

  /** Fit the view to bounds, taking the value range from the given curves. */
  fitBounds(b: { x0: number; x1: number; y0: number; y1: number }, curves: CurveRef[]) {
    this.fitTo(b, curves);
  }

  private fitTo(b: { x0: number; x1: number; y0: number; y1: number } | null, only?: CurveRef[]) {
    this.normCache.clear();
    const s = app.doc.scene;
    this.view.width = this.mainW;
    this.view.height = Math.max(1, this.contentBottom() - RULER_H);
    if (!b) {
      this.view.fitX(s.frame_start, s.frame_end, 40);
      this.view.fitY(-1, 1, 40);
    } else {
      this.view.fitX(b.x0, b.x1, 40);
      // value bounds in display space
      let lo = Infinity,
        hi = -Infinity;
      for (const r of only ?? this.visibleCurves())
        for (const k of r.fc.keyframe_points) {
          if (b && !(k.co[0] >= b.x0 - 1e-6 && k.co[0] <= b.x1 + 1e-6)) continue;
          for (const v of [k.co[1], ...(k.interpolation === 'BEZIER' ? [k.handle_left[1], k.handle_right[1]] : [])]) {
            const d = this.toDisp(r.fc, v);
            lo = Math.min(lo, d);
            hi = Math.max(hi, d);
          }
        }
      if (lo === Infinity) {
        lo = b.y0;
        hi = b.y1;
      }
      this.view.fitY(lo, hi, 40);
    }
    this.draw();
  }

  // ---------------------------------------------------------------- sidebar

  protected sidebarTabs(): SidebarTab[] {
    return [
      { id: 'fcurve', label: 'F-Curve', draw: () => drawFCurveSidebar(this) },
      {
        id: 'modifiers',
        label: 'Modifiers',
        draw: () => drawModifiersSidebar(this),
      },
      { id: 'view', label: 'View', draw: () => this.viewTab() },
    ];
  }

  private viewTab(): Child {
    const s = app.doc.scene;
    return h(
      'div',
      { class: 'anim-sb-panel' },
      h(
        'div',
        { class: 'anim-sb-title' },
        checkbox('g-show-cursor', 'Show Cursor', this.showCursor, (v) => ((this.showCursor = v), this.refresh())),
      ),
      this.showCursor
        ? [
            h(
              'div',
              { class: 'split-row' },
              h('div', { class: 'sr-label' }, 'Cursor X'),
              h(
                'div',
                { class: 'sr-value' },
                numberField({
                  id: 'g-cur-x',
                  value: s.frame_current,
                  int: true,
                  set: (v) => app.setFrame(v),
                }),
              ),
              h('span'),
            ),
            h(
              'div',
              { class: 'split-row' },
              h('div', { class: 'sr-label' }, 'Y'),
              h(
                'div',
                { class: 'sr-value' },
                numberField({
                  id: 'g-cur-y',
                  value: this.cursorValue,
                  precision: 3,
                  set: (v) => ((this.cursorValue = v), this.refresh()),
                }),
              ),
              h('span'),
            ),
            h(
              'div',
              { class: 'anim-sb-btns' },
              button('g-cur-sel', 'Cursor to Selection', () => app.run('graph.frame_jump'), { disabled: !app.poll('graph.frame_jump', this.area) }),
              button('g-cur-val', 'Cursor Value to Selection', () => app.run('graph.snap_cursor_value'), { disabled: !app.poll('graph.snap_cursor_value', this.area) }),
            ),
          ]
        : null,
    );
  }
}

// ---------------------------------------------------------------------------
// Graph-only operators

function graphEd(ctx: OpContext): GraphEditor | null {
  const ed = ctx.area?.editor;
  return ed instanceof GraphEditor ? ed : null;
}

const MOD_TYPES: [string, string][] = [
  ['GENERATOR', 'Generator'],
  ['FNGENERATOR', 'Built-In Function'],
  ['ENVELOPE', 'Envelope'],
  ['CYCLES', 'Cycles'],
  ['NOISE', 'Noise'],
  ['LIMITS', 'Limits'],
  ['STEPPED', 'Stepped Interpolation'],
];

export function newModifier(type: string): FCurve['modifiers'][number] {
  switch (type) {
    case 'GENERATOR':
      return { type: 'GENERATOR', coefficients: [0, 1] };
    case 'CYCLES':
      return { type: 'CYCLES', mode_before: 'REPEAT', mode_after: 'REPEAT' };
    case 'FNGENERATOR':
      return { type: 'FNGENERATOR', function_type: 'SIN', amplitude: 1, phase_multiplier: 1, phase_offset: 0, value_offset: 0, use_additive: false };
    case 'ENVELOPE':
      return { type: 'ENVELOPE', reference_value: 0, default_min: -1, default_max: 1, control_points: [] };
    case 'NOISE':
      return {
        type: 'NOISE',
        scale: 1,
        strength: 1,
        phase: 1,
        offset: 0,
        depth: 0,
      };
    case 'LIMITS':
      return {
        type: 'LIMITS',
        use_min_y: false,
        use_max_y: false,
        min_y: 0,
        max_y: 0,
      };
    default:
      return { type: 'STEPPED', frame_step: 2, frame_offset: 0 };
  }
}

registerOperators([
  {
    idname: 'graph.select_linked_pick',
    label: 'Select Linked (Pick)',
    description: 'Select all keyframes of the F-Curve under the mouse',
    props: [{ id: 'deselect', label: 'Deselect', type: 'bool', default: false }],
    poll: (ctx) => !!graphEd(ctx),
    exec: (ctx, p) => {
      const ed = graphEd(ctx)!;
      const pt = ctx.event ? ed.local({ clientX: ctx.event.x, clientY: ctx.event.y }) : null;
      const hit = pt ? ed.pick(pt.x, pt.y) : null;
      const r = hit?.r ?? (pt ? ed.pickCurve(pt.x, pt.y) : null);
      if (!r) return 'CANCELLED';
      r.fc.keyframe_points.forEach((k) => setKeySelected(k, !p.deselect));
    },
  },
  {
    idname: 'graph.hide',
    label: 'Hide Curves',
    description: 'Hide selected curves from Graph Editor view',
    props: [{ id: 'unselected', label: 'Unselected', type: 'bool', default: false }],
    poll: (ctx) => !!graphEd(ctx),
    exec: (ctx, p) => {
      const ed = graphEd(ctx)!;
      let n = 0;
      for (const r of ed.list.curves) {
        const hit = p.unselected ? !r.fc.select : r.fc.select;
        if (hit && !r.fc.hide) {
          r.fc.hide = true;
          if (!p.unselected) r.fc.select = false;
          n++;
        }
      }
      if (!n) return 'CANCELLED';
    },
  },
  {
    idname: 'graph.reveal',
    label: 'Reveal Curves',
    description: 'Make previously hidden curves visible again in Graph Editor view',
    props: [{ id: 'select', label: 'Select', type: 'bool', default: true }],
    poll: (ctx) => !!graphEd(ctx),
    exec: (ctx, p) => {
      for (const r of graphEd(ctx)!.list.curves)
        if (r.fc.hide) {
          r.fc.hide = false;
          if (p.select) r.fc.select = true;
        }
    },
  },
  {
    idname: 'graph.toggle_handles',
    label: 'Show Handles',
    description: 'Show handles of Bézier control points',
    undo: false,
    internal: true,
    poll: (ctx) => !!graphEd(ctx),
    exec: (ctx) => {
      const ed = graphEd(ctx)!;
      ed.showHandles = !ed.showHandles;
      ed.draw();
    },
  },
  {
    idname: 'graph.snap_cursor_value',
    label: 'Cursor Value to Selection',
    description: 'Place the cursor value on the average value of selected keyframes',
    undo: false,
    poll: (ctx) =>
      !!graphEd(ctx) &&
      graphEd(ctx)!
        .editCurves()
        .some((r) => r.fc.keyframe_points.some((k) => k.select_control_point)),
    exec: (ctx) => {
      const ed = graphEd(ctx)!;
      let s = 0,
        n = 0;
      for (const r of ed.editCurves())
        for (const k of r.fc.keyframe_points)
          if (k.select_control_point) {
            s += ed.toDisp(r.fc, k.co[1]);
            n++;
          }
      if (!n) return 'CANCELLED';
      ed.cursorValue = s / n;
      ed.draw();
    },
  },
  {
    idname: 'graph.fmodifier_add',
    label: 'Add F-Curve Modifier',
    description: 'Add F-Modifier to the active/selected F-Curves',
    props: [
      {
        id: 'type',
        label: 'Type',
        type: 'enum',
        default: 'NOISE',
        items: MOD_TYPES,
      },
      { id: 'only_active', label: 'Only Active', type: 'bool', default: true },
    ],
    poll: (ctx) => !!graphEd(ctx)?.activeCurve(),
    exec: (ctx, p) => {
      const ed = graphEd(ctx)!;
      const targets = p.only_active ? [ed.activeCurve()!] : ed.editCurves().filter((r) => r.fc.select);
      if (!targets.length) return 'CANCELLED';
      for (const r of targets) {
        if (p.type === 'CYCLES' && r.fc.modifiers.some((m) => m.type === 'CYCLES')) continue;
        r.fc.modifiers.push(newModifier(p.type as string));
      }
    },
  },
]);

registerEditor({
  id: 'GRAPH',
  label: 'Graph Editor',
  icon: 'graph',
  group: 'Animation',
  create: (a, s) => new GraphEditor(a, s),
});

export { MOD_TYPES };
