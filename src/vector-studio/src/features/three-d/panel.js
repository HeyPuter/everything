/**
 * 3D and Materials panel (Window > 3D and Materials).
 *
 * Three tabs edit the 3D effect of the selected objects:
 *  - Object: the 3D type (Rotate, Extrude, Revolve, Inflate) and its shape
 *    settings, the orientation (view presets, a trackball, X/Y/Z angles),
 *    perspective and mesh detail
 *  - Material: material presets with shaded previews, the base color and
 *    the surface settings they set
 *  - Light: light presets, a light sphere for the direction, intensity,
 *    ambient light, shading style and shadows
 * With artwork selected that has no 3D effect yet, choosing a type adds
 * one. Dragging a slider, the trackball or the light previews live in
 * draft quality and makes one undo step; the full-quality result renders
 * on release.
 */
import { h } from '../../lib/dom.js';
import { Panel } from '../../ui/panels/panel.js';
import { icon } from '../../ui/icons.js';
import { numberField } from '../../ui/widgets.js';
import { normalizeEffect } from '../paint/effects-model.js';
import { effectTargets } from '../paint/effects-ui.js';
import { gestureKey } from '../paint/ui-common.js';
import { KINDS, VIEWS, SHADING, EFFECT_TYPE, DEFAULTS, threeDRecord, materialParams, lightParams } from './params.js';
import { MATERIALS, LIGHTS, MATERIAL_KEYS, baseColorOf } from './shading.js';
import { BEVELS } from './mesh.js';
import { trackball, lightSphere, paintMaterialBall } from './widgets.js';
import { setDraft } from './live-kind.js';
import { normalize } from './math.js';

let uid = 0;
const nid = (p) => `td-${p}-${++uid}`;

const TABS = [
  { id: 'object', label: 'Object', icon: 'three-d' },
  { id: 'material', label: 'Material', icon: 'three-d-material' },
  { id: 'light', label: 'Light', icon: 'three-d-light' },
];

/**
 * A labeled slider with a number box. onInput(v) while dragging,
 * onCommit(v) on release, Enter, blur or arrow keys. `scale` maps stored
 * values to shown ones (0.5 -> 50 for percentages).
 */
function slider({ label, min, max, step = 1, unit = '', scale = 1, onInput, onCommit }) {
  const id = nid('s');
  const range = h('input.td-range', { type: 'range', id, min, max, step });
  const box = h('input.td-num', { type: 'text', inputmode: 'decimal', spellcheck: false, autocomplete: 'off', 'aria-label': `${label}${unit ? ` (${unit})` : ''}` });
  let current = 0;
  const fmt = (v) => String(Number((v * scale).toFixed(step < 1 ? 2 : 1)));
  const show = (v) => {
    range.value = String(v * scale);
    range.setAttribute('aria-valuetext', `${fmt(v)}${unit}`);
    if (document.activeElement !== box) box.value = fmt(v);
  };
  const clampV = (shown) => Math.max(min, Math.min(max, shown)) / scale;
  range.addEventListener('input', () => {
    current = clampV(Number(range.value));
    box.value = fmt(current);
    onInput?.(current);
  });
  range.addEventListener('change', () => {
    current = clampV(Number(range.value));
    onCommit(current);
  });
  range.addEventListener('keydown', (e) => e.stopPropagation());
  const commitBox = () => {
    const v = parseFloat(String(box.value).replace(',', '.'));
    if (!Number.isFinite(v)) return show(current);
    const n = clampV(v);
    show(n);
    if (n !== current) {
      current = n;
      onCommit(n);
    }
  };
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitBox();
    } else if (e.key === 'Escape') show(current);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const n = clampV(current * scale + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
      current = n;
      show(n);
      onCommit(n);
    }
  });
  box.addEventListener('blur', commitBox);
  box.addEventListener('focus', () => box.select());
  const el = h('div.td-row.td-slider', h('label.td-label', { for: id }, label), range, h('span.td-num-wrap', box, unit ? h('span.td-unit', { 'aria-hidden': 'true' }, unit) : null));
  return {
    el,
    set: (v) => {
      current = v;
      show(v);
    },
  };
}

function check(label, onChange) {
  const id = nid('c');
  const input = h('input', { type: 'checkbox', id, onchange: () => onChange(input.checked) });
  return { el: h('div.td-check', input, h('label', { for: id }, label)), input, set: (v) => (input.checked = Boolean(v)) };
}

function select(label, options, onChange) {
  const id = nid('sel');
  const sel = h('select.select', { id, onchange: () => onChange(sel.value) }, options.map((o) => h('option', { value: o.value }, o.label)));
  return { el: h('div.td-row', h('label.td-label', { for: id }, label), sel), sel, set: (v) => (sel.value = v) };
}

/** Radio buttons in a row (arrow keys move between them). */
function choices(label, options, onChange, { big = false } = {}) {
  const lid = nid('ch');
  const buttons = options.map((o) =>
    h(
      `button.td-choice${big ? '.td-choice-big' : ''}`,
      {
        type: 'button',
        role: 'radio',
        'aria-checked': 'false',
        'data-value': o.value,
        'data-tip': o.tip || null,
        onclick: () => onChange(o.value),
        onkeydown: (e) => {
          const i = options.indexOf(o);
          const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          e.stopPropagation();
          const n = options[(i + d + options.length) % options.length];
          onChange(n.value);
          buttons[options.indexOf(n)].focus();
        },
      },
      o.icon ? icon(o.icon, big ? 22 : 16) : null,
      h('span', o.label),
    ),
  );
  const group = h('div.td-choices', { role: 'radiogroup', 'aria-labelledby': lid }, buttons);
  return {
    el: h('div.td-row', h('span.td-label', { id: lid }, label), group),
    group,
    buttons,
    set: (v) =>
      buttons.forEach((b, i) => {
        const on = b.dataset.value === v;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on || (!options.some((o) => o.value === v) && i === 0) ? 0 : -1;
      }),
    setDisabled: (d) => buttons.forEach((b) => (b.disabled = d)),
  };
}

export class ThreeDPanel extends Panel {
  static id = '3d';
  static title = '3D and Materials';
  static icon = 'three-d';
  static placement = 'strip';

  build() {
    this.tab = 'object';
    this.gesture = null;
    this.tabButtons = new Map();
    this.pages = new Map();
    const tablist = h('div.td-tabs', { role: 'tablist', 'aria-label': '3D settings' });
    TABS.forEach((t, i) => {
      const pageId = nid(`page-${t.id}`);
      const tabId = nid(`tab-${t.id}`);
      const b = h(
        'button.td-tab',
        {
          type: 'button',
          role: 'tab',
          id: tabId,
          'aria-controls': pageId,
          'aria-selected': String(i === 0),
          tabindex: i === 0 ? '0' : '-1',
          onclick: () => this.showTab(t.id),
          onkeydown: (e) => {
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            e.stopPropagation();
            const n = TABS[(i + d + TABS.length) % TABS.length];
            this.showTab(n.id);
            this.tabButtons.get(n.id).focus();
          },
        },
        icon(t.icon, 15),
        h('span', t.label),
      );
      this.tabButtons.set(t.id, b);
      tablist.append(b);
      this.pages.set(t.id, h('div.td-page', { role: 'tabpanel', id: pageId, 'aria-labelledby': tabId, hidden: i !== 0 }));
    });
    this.empty = h('p.td-empty', { role: 'status' });
    this.buildObject();
    this.buildMaterial();
    this.buildLight();
    this.removeBtn = h('button.btn', { type: 'button', onclick: () => this.remove3D() }, 'Remove 3D');
    this.expandBtn = h('button.btn', { type: 'button', onclick: () => this.app.commands.run('object.expandAppearance') }, 'Expand');
    this.footer = h('div.td-footer', this.removeBtn, this.expandBtn);
    this.el.append(tablist, this.empty, ...this.pages.values(), this.footer);
  }

  // ---- structure ----

  buildObject() {
    const page = this.pages.get('object');
    this.kind = choices(
      '3D type',
      KINDS.map((k) => ({ value: k.id, label: k.label, icon: `three-d-${k.id}`, tip: k.hint })),
      (v) => this.chooseKind(v),
      { big: true },
    );
    this.kind.el.classList.add('td-kind-row');
    const live = (key) => ({ onInput: (v) => this.apply({ [key]: v }, { live: true }), onCommit: (v) => this.apply({ [key]: v }) });
    this.depth = slider({ label: 'Depth', min: 0, max: 500, unit: 'pt', ...live('depth') });
    this.twist = slider({ label: 'Twist', min: -360, max: 360, unit: '°', ...live('twist') });
    this.taper = slider({ label: 'Taper', min: 1, max: 200, unit: '%', scale: 100, ...live('taper') });
    this.cap = check('Cap the ends', (v) => this.apply({ cap: v }));
    this.bevel = select('Bevel', [{ value: 'none', label: 'None' }, ...BEVELS.map((b) => ({ value: b.id, label: b.label }))], (v) => this.apply({ bevel: v }));
    this.bevelWidth = slider({ label: 'Bevel width', min: 0, max: 100, step: 0.5, unit: 'pt', ...live('bevelWidth') });
    this.bevelHeight = slider({ label: 'Bevel height', min: 0, max: 100, step: 0.5, unit: 'pt', ...live('bevelHeight') });
    this.bevelOut = check('Bevel outward', (v) => this.apply({ bevelOut: v }));
    this.bevelBack = check('Bevel both ends', (v) => this.apply({ bevelBack: v }));
    this.bevelBox = h('div.td-sub', this.bevelWidth.el, this.bevelHeight.el, h('div.td-checks', this.bevelOut.el, this.bevelBack.el));
    this.extrudeBox = h('div.td-group', this.depth.el, this.twist.el, this.taper.el, h('div.td-checks', this.cap.el), this.bevel.el, this.bevelBox);

    this.angle = slider({ label: 'Angle', min: 1, max: 360, unit: '°', ...live('angle') });
    this.offset = slider({ label: 'Offset', min: 0, max: 500, unit: 'pt', ...live('offset') });
    this.axis = choices(
      'Axis',
      [
        { value: 'left', label: 'Left edge' },
        { value: 'right', label: 'Right edge' },
      ],
      (v) => this.apply({ axis: v }),
    );
    this.revCap = check('Cap open ends', (v) => this.apply({ cap: v }));
    this.revolveBox = h('div.td-group', this.angle.el, this.offset.el, this.axis.el, h('div.td-checks', this.revCap.el));

    this.inflateDepth = slider({ label: 'Thickness', min: 0, max: 500, unit: 'pt', ...live('depth') });
    this.volume = slider({ label: 'Volume', min: 0, max: 100, unit: '%', scale: 100, ...live('volume') });
    this.bothSides = check('Inflate both sides', (v) => this.apply({ bothSides: v }));
    this.inflateBox = h('div.td-group', this.inflateDepth.el, this.volume.el, h('div.td-checks', this.bothSides.el));

    this.view = select('View', [{ value: '', label: 'Custom' }, ...VIEWS.map((v) => ({ value: v.id, label: v.label }))], (id) => {
      const v = VIEWS.find((x) => x.id === id);
      if (v) this.apply({ rotX: v.x, rotY: v.y, rotZ: v.z });
    });
    this.ball = trackball({
      get: () => {
        const fx = this.current();
        return { x: fx.rotX, y: fx.rotY, z: fx.rotZ };
      },
      onChange: (a, { live: isLive }) => this.apply({ rotX: a.x, rotY: a.y, rotZ: a.z }, { live: isLive }),
      onGesture: (phase) => phase === 'end' && this.endGesture(),
    });
    const angleField = (key, label) =>
      numberField({
        label,
        ariaLabel: `${label} rotation`,
        kind: 'angle',
        value: 0,
        min: -180,
        max: 180,
        step: 1,
        digits: 1,
        width: '58px',
        onCommit: (v, o) => this.apply({ [key]: v }, { live: Boolean(o?.live) }),
      });
    this.rx = angleField('rotX', 'X');
    this.ry = angleField('rotY', 'Y');
    this.rz = angleField('rotZ', 'Z');
    this.perspective = slider({ label: 'Perspective', min: 0, max: 160, unit: '°', ...live('perspective') });
    this.detail = choices(
      'Detail',
      [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
      (v) => this.apply({ detail: v }),
    );
    const orient = h(
      'section.td-section',
      { 'aria-label': 'Orientation' },
      h('h3.td-heading', 'Orientation'),
      this.view.el,
      h('div.td-orient', this.ball.el, h('div.td-angles', this.rx.el, this.ry.el, this.rz.el)),
      this.perspective.el,
      this.detail.el,
    );
    this.shapeSection = h('section.td-section', { 'aria-label': 'Shape' }, this.extrudeBox, this.revolveBox, this.inflateBox);
    page.append(h('section.td-section', this.kind.el), this.shapeSection, orient);
    // Mouse users get the label scrubbing of the number fields; the pointer
    // releasing anywhere ends a scrub gesture.
    page.addEventListener('pointerup', () => this.endGesture());
  }

  buildMaterial() {
    const page = this.pages.get('material');
    this.matButtons = MATERIALS.map((m) => {
      const canvas = h('canvas.td-swatch-ball', { width: 40, height: 40, 'aria-hidden': 'true' });
      const b = h('button.td-swatch', { type: 'button', 'aria-pressed': 'false', 'data-id': m.id, onclick: () => this.apply(materialParams(m.id)) }, canvas, h('span', m.label));
      return { m, b, canvas };
    });
    this.matGrid = h('div.td-swatches', { role: 'group', 'aria-label': 'Material presets' }, this.matButtons.map((x) => x.b));
    this.useObjectColor = check("Use the object's color", (v) => this.apply({ color: v ? '' : this.colorInput.value || '#5b8def' }));
    const cid = nid('color');
    this.colorInput = h('input.td-color', { type: 'color', id: cid, value: '#5b8def', oninput: () => this.apply({ color: this.colorInput.value }, { live: true }), onchange: () => this.apply({ color: this.colorInput.value }) });
    this.colorRow = h('div.td-row', h('label.td-label', { for: cid }, 'Base color'), this.colorInput);
    const live = (key) => ({ onInput: (v) => this.apply({ [key]: v, material: 'custom' }, { live: true }), onCommit: (v) => this.apply({ [key]: v, material: 'custom' }) });
    this.roughness = slider({ label: 'Roughness', min: 0, max: 100, unit: '%', scale: 100, ...live('roughness') });
    this.specular = slider({ label: 'Highlight', min: 0, max: 100, unit: '%', scale: 100, ...live('specular') });
    this.metallic = slider({ label: 'Metallic', min: 0, max: 100, unit: '%', scale: 100, ...live('metallic') });
    this.reflection = slider({ label: 'Reflection', min: 0, max: 100, unit: '%', scale: 100, ...live('reflection') });
    this.opacity = slider({ label: 'Opacity', min: 5, max: 100, unit: '%', scale: 100, ...live('opacity') });
    this.matName = h('p.td-note', { role: 'status' });
    page.append(
      h('section.td-section', h('h3.td-heading', 'Presets'), this.matGrid, this.matName),
      h('section.td-section', h('h3.td-heading', 'Surface'), h('div.td-checks', this.useObjectColor.el), this.colorRow, this.roughness.el, this.specular.el, this.metallic.el, this.reflection.el, this.opacity.el),
    );
    page.addEventListener('pointerup', () => this.endGesture());
  }

  buildLight() {
    const page = this.pages.get('light');
    this.lightPreset = select('Preset', [{ value: 'custom', label: 'Custom' }, ...LIGHTS.map((l) => ({ value: l.id, label: l.label }))], (id) => id !== 'custom' && this.apply(lightParams(id)));
    this.sphere = lightSphere({
      get: () => {
        const fx = this.current();
        return [fx.lightX, fx.lightY, fx.lightZ];
      },
      onChange: (v, { live: isLive }) => this.apply({ lightX: v[0], lightY: v[1], lightZ: v[2], light: 'custom' }, { live: isLive }),
      onGesture: (phase) => phase === 'end' && this.endGesture(),
    });
    this.behind = check('Light behind the object', (v) => {
      const fx = this.current();
      const z = Math.abs(fx.lightZ) || 0.2;
      const [x, y, zz] = normalize([fx.lightX, fx.lightY, v ? -z : z]);
      this.apply({ lightX: x, lightY: y, lightZ: zz, light: 'custom' });
    });
    const lid = nid('lc');
    this.lightColor = h('input.td-color', { type: 'color', id: lid, value: '#ffffff', oninput: () => this.apply({ lightColor: this.lightColor.value }, { live: true }), onchange: () => this.apply({ lightColor: this.lightColor.value }) });
    const live = (key, extra = {}) => ({ onInput: (v) => this.apply({ [key]: v, ...extra }, { live: true }), onCommit: (v) => this.apply({ [key]: v, ...extra }) });
    this.intensity = slider({ label: 'Intensity', min: 0, max: 200, unit: '%', scale: 100, ...live('intensity', { light: 'custom' }) });
    this.ambient = slider({ label: 'Ambient', min: 0, max: 100, unit: '%', scale: 100, ...live('ambient', { light: 'custom' }) });
    this.shading = choices(
      'Shading',
      SHADING.map((s) => ({ value: s.id, label: s.label })),
      (v) => this.apply({ shading: v }),
    );
    this.steps = slider({ label: 'Tones', min: 2, max: 64, unit: '', ...live('steps') });
    this.shadow = check('Cast a shadow', (v) => this.apply({ shadow: v }));
    this.shadowPlane = choices(
      'Shadow',
      [
        { value: 'below', label: 'Below' },
        { value: 'behind', label: 'Behind' },
      ],
      (v) => this.apply({ shadowPlane: v }),
    );
    this.shadowDistance = slider({ label: 'Distance', min: 0, max: 200, unit: 'pt', ...live('shadowDistance') });
    this.shadowOpacity = slider({ label: 'Darkness', min: 0, max: 100, unit: '%', scale: 100, ...live('shadowOpacity') });
    this.shadowBox = h('div.td-sub', this.shadowPlane.el, this.shadowDistance.el, this.shadowOpacity.el);
    page.append(
      h('section.td-section', h('h3.td-heading', 'Light'), this.lightPreset.el, h('div.td-light', this.sphere.el), h('div.td-checks', this.behind.el), h('div.td-row', h('label.td-label', { for: lid }, 'Color'), this.lightColor), this.intensity.el, this.ambient.el),
      h('section.td-section', h('h3.td-heading', 'Rendering'), this.shading.el, this.steps.el, h('div.td-checks', this.shadow.el), this.shadowBox),
    );
    page.addEventListener('pointerup', () => this.endGesture());
  }

  showTab(id) {
    if (!this.built) this.ensureBuilt();
    if (!this.pages.has(id)) return;
    this.tab = id;
    for (const [tid, b] of this.tabButtons) {
      b.setAttribute('aria-selected', String(tid === id));
      b.tabIndex = tid === id ? 0 : -1;
    }
    for (const [pid, p] of this.pages) p.hidden = pid !== id;
    this.update();
  }

  // ---- model ----

  /** Selected objects that can carry a 3D effect. */
  candidates() {
    const ed = this.app.editor;
    if (!ed) return [];
    return effectTargets(ed).filter((n) => n.type === 'path' || n.type === 'compound' || n.type === 'group' || n.type === 'text');
  }

  targets() {
    return this.candidates().filter((n) => threeDRecord(n));
  }

  /** The record shown: the first target's, or the defaults. */
  current() {
    const t = this.targets()[0];
    const rec = t ? threeDRecord(t).fx : null;
    return rec ? { ...DEFAULTS, ...rec } : { ...DEFAULTS };
  }

  chooseKind(kind) {
    const ed = this.app.editor;
    const cands = this.candidates();
    if (!ed || !cands.length) return;
    this.app.commands.run(`effect.3d.${kind}`, { keepTab: true });
  }

  /**
   * Change the 3D effect of the selection. `live` edits are part of a drag:
   * they render in draft quality and merge into one undo step.
   */
  apply(patch, { live = false } = {}) {
    const ed = this.app.editor;
    const t = this.targets();
    if (!ed || !t.length) return;
    if (live && !this.gesture) {
      this.gesture = gestureKey('td');
      setDraft(true);
    }
    const key = this.gesture || gestureKey('td');
    if (!live && this.gesture) {
      this.gesture = null;
      setDraft(false);
    }
    ed.doc.transact(
      '3D Options',
      () => {
        for (const n of t) {
          const rec = threeDRecord(n);
          const list = n.effects.slice();
          list[rec.index] = { ...normalizeEffect({ ...rec.fx, ...patch }), ...(rec.fx.hidden ? { hidden: true } : {}) };
          ed.doc.update(n.id, { effects: list });
        }
      },
      { coalesce: key },
    );
    this.app.lastEffect = { ...threeDRecord(ed.doc.get(t[0].id)).fx };
    delete this.app.lastEffect.hidden;
    if (!this.visible) return;
    this.update();
  }

  /** A drag ended without a final value: render the full-quality result. */
  endGesture() {
    if (!this.gesture) return;
    this.apply({});
  }

  menu() {
    const has = this.targets().length > 0;
    const cur = this.current();
    const quality = (value, label) => ({ label, checked: has && cur.detail === value, enabled: has, run: () => this.apply({ detail: value }) });
    return [
      { label: 'Copy 3D Settings', enabled: has, run: () => (this.app.threeDClipboard = { ...cur }) },
      { label: 'Paste 3D Settings', enabled: Boolean(this.app.threeDClipboard) && this.candidates().length > 0, run: () => this.paste3D() },
      { label: 'Reset to Defaults', enabled: has, run: () => this.apply({ ...DEFAULTS, kind: cur.kind }) },
      '-',
      { label: 'Mesh Quality', submenu: [quality('low', 'Low (fast)'), quality('medium', 'Medium'), quality('high', 'High')] },
      '-',
      { id: 'object.expandAppearance', label: 'Expand' },
      { label: 'Remove 3D', enabled: has, run: () => this.remove3D() },
    ];
  }

  /** Paste 3D Settings: the copied settings replace (or become) the selection's 3D effect. */
  paste3D() {
    const ed = this.app.editor;
    const clip = this.app.threeDClipboard;
    const cands = this.candidates();
    if (!ed || !clip || !cands.length) return;
    const fx = normalizeEffect({ ...clip, type: EFFECT_TYPE });
    ed.doc.transact('Paste 3D Settings', () => {
      for (const n of cands) {
        const rec = threeDRecord(n);
        const list = (n.effects || []).slice();
        if (rec) list[rec.index] = { ...fx, ...(rec.fx.hidden ? { hidden: true } : {}) };
        else list.push(fx);
        ed.doc.update(n.id, { effects: list });
      }
    });
  }

  remove3D() {
    const ed = this.app.editor;
    const t = this.targets();
    if (!ed || !t.length) return;
    ed.doc.transact('Remove 3D', () => {
      for (const n of t) ed.doc.update(n.id, { effects: n.effects.filter((e) => e.type !== EFFECT_TYPE) });
    });
  }

  // ---- refresh ----

  update() {
    if (!this.built) return;
    const ed = this.app.editor;
    const cands = this.candidates();
    const t = this.targets();
    const fx = this.current();
    const has = t.length > 0;
    this.empty.hidden = has;
    this.empty.textContent = !ed ? 'Open a document to work in 3D.' : !cands.length ? 'Select artwork to give it depth.' : 'Choose a 3D type to turn the selection into a 3D object.';
    this.kind.setDisabled(!cands.length);
    this.kind.set(has ? fx.kind : '');
    this.shapeSection.hidden = !has;
    this.footer.hidden = !has;
    for (const [id, p] of this.pages) {
      if (id === 'object') {
        for (const s of p.querySelectorAll('.td-section')) if (s !== this.shapeSection && !s.contains(this.kind.el)) s.hidden = !has;
      } else p.classList.toggle('td-disabled', !has);
    }
    for (const id of ['material', 'light']) {
      for (const el of this.pages.get(id).querySelectorAll('input, select, button, .td-lightball')) {
        if ('disabled' in el) el.disabled = !has;
        else el.setAttribute('aria-disabled', String(!has));
      }
    }
    this.extrudeBox.hidden = fx.kind !== 'extrude';
    this.revolveBox.hidden = fx.kind !== 'revolve';
    this.inflateBox.hidden = fx.kind !== 'inflate';
    this.depth.set(fx.depth);
    this.twist.set(fx.twist);
    this.taper.set(fx.taper);
    this.cap.set(fx.cap);
    this.bevel.set(fx.bevel);
    this.bevelBox.hidden = fx.bevel === 'none';
    this.bevelWidth.set(fx.bevelWidth);
    this.bevelHeight.set(fx.bevelHeight);
    this.bevelOut.set(fx.bevelOut);
    this.bevelBack.set(fx.bevelBack);
    this.angle.set(fx.angle);
    this.offset.set(fx.offset);
    this.axis.set(fx.axis);
    this.revCap.set(fx.cap);
    this.revCap.el.hidden = fx.angle >= 360;
    this.inflateDepth.set(fx.depth);
    this.volume.set(fx.volume);
    this.bothSides.set(fx.bothSides);
    const view = VIEWS.find((v) => Math.abs(v.x - fx.rotX) < 0.05 && Math.abs(v.y - fx.rotY) < 0.05 && Math.abs(v.z - fx.rotZ) < 0.05);
    this.view.set(view ? view.id : '');
    this.rx.set(fx.rotX);
    this.ry.set(fx.rotY);
    this.rz.set(fx.rotZ);
    this.ball.refresh();
    this.perspective.set(fx.perspective);
    this.detail.set(fx.detail);

    const base = t[0] ? baseColorOf(t[0], fx.color) : '#5b8def';
    for (const { m, b, canvas } of this.matButtons) {
      b.setAttribute('aria-pressed', String(m.id === fx.material));
      if (canvas.dataset.base !== base) {
        canvas.dataset.base = base;
        paintMaterialBall(canvas, m, base);
      }
    }
    const mat = MATERIALS.find((m) => m.id === fx.material);
    this.matName.textContent = mat ? `Material: ${mat.label}` : 'Material: Custom';
    this.useObjectColor.set(!fx.color);
    this.colorRow.hidden = !fx.color;
    if (fx.color && document.activeElement !== this.colorInput) this.colorInput.value = fx.color;
    const special = mat?.special;
    for (const k of MATERIAL_KEYS) this[k].el.classList.toggle('td-muted', Boolean(special));
    this.roughness.set(fx.roughness);
    this.specular.set(fx.specular);
    this.metallic.set(fx.metallic);
    this.reflection.set(fx.reflection);
    this.opacity.set(fx.opacity);

    this.lightPreset.set(LIGHTS.some((l) => l.id === fx.light) ? fx.light : 'custom');
    this.sphere.refresh();
    this.behind.set(fx.lightZ < 0);
    if (document.activeElement !== this.lightColor) this.lightColor.value = fx.lightColor || '#ffffff';
    this.intensity.set(fx.intensity);
    this.ambient.set(fx.ambient);
    this.shading.set(fx.shading);
    this.steps.el.hidden = fx.shading !== 'banded';
    this.steps.set(fx.steps);
    this.shadow.set(fx.shadow);
    this.shadowBox.hidden = !fx.shadow;
    this.shadowPlane.set(fx.shadowPlane);
    this.shadowDistance.set(fx.shadowDistance);
    this.shadowOpacity.set(fx.shadowOpacity);
  }
}

