/**
 * Object > Transform dialogs: Move, Rotate, Reflect, Scale, Shear,
 * Transform Each, plus Path > Average. Each has a live Preview (an open
 * transaction re-applied on every edit), Copy (transform a duplicate) and
 * OK; Cancel rolls the preview back.
 */
import { formDialog } from './dialog.js';
import { multiply, rotate, scale, shear, translate } from '../../lib/matrix.js';
import { nodeBounds, transformNodes, usesPatternPaint } from '../../model/geometry.js';
import { reflectAcross } from '../../tools/transform-tools.js';
import { applyTransform, transformEach } from '../../commands/core.js';
import { average } from '../../ops/object-ops.js';

function selectionCenter(editor) {
  const b = editor.selectionBounds(false);
  return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2, b } : null;
}

/** Shear by `deg` along an axis at `axisDeg` (0 = horizontal) about (x, y). */
export function shearAlong(deg, axisDeg, x, y) {
  return multiply(rotate(-axisDeg, x, y), multiply(shear(deg, 0, x, y), rotate(axisDeg, x, y)));
}

export function matrixFor(kind, v, origin) {
  const { x, y } = origin;
  switch (kind) {
    case 'move':
      return translate(v.dx, v.dy);
    case 'rotate':
      return rotate(-v.angle, x, y);
    case 'reflect':
      return v.axis === 'horizontal' ? reflectAcross(x, y, 0) : v.axis === 'vertical' ? reflectAcross(x, y, 90) : reflectAcross(x, y, -v.angle);
    case 'scale':
      // Actions recorded before the Uniform/Non-Uniform choice carry `uniform: true`.
      return (v.mode ? v.mode === 'uniform' : v.uniform) ? scale(v.uniformPct / 100, v.uniformPct / 100, x, y) : scale(v.sx / 100, v.sy / 100, x, y);
    case 'shear':
      if (v.axis === 'vertical') return shear(0, v.angle, x, y);
      if (v.axis === 'angle') return shearAlong(v.angle, v.axisAngle ?? 0, x, y);
      return shear(v.angle, 0, x, y);
    default:
      return null;
  }
}

const LAST = {
  move: { dx: 0, dy: 0, preview: false },
  rotate: { angle: 0, preview: false },
  reflect: { axis: 'vertical', angle: 90, preview: false },
  scale: { mode: 'uniform', uniformPct: 100, sx: 100, sy: 100, preview: false },
  shear: { angle: 0, axis: 'horizontal', axisAngle: 0, preview: false },
  each: { mode: 'relative', scaleX: 100, scaleY: 100, constrain: false, moveX: 0, moveY: 0, angle: 0, reflectX: false, reflectY: false, random: false, ref: { x: 0.5, y: 0.5 }, preview: false },
};

const round = (v, d = 4) => Number(v.toFixed(d));
const optionHeading = { type: 'heading', label: 'Options' };

export async function transformDialog(app, kind, args = {}) {
  const editor = app.editor;
  if (!editor?.selection.size) return;
  const c = args.origin ? { ...args.origin } : selectionCenter(editor);
  if (!c) return;
  const doc = editor.doc;
  const titles = { move: 'Move', rotate: 'Rotate', reflect: 'Reflect', scale: 'Scale', shear: 'Shear', each: 'Transform Each' };
  const last = LAST[kind];
  // Move starts from the last move however it was made (drag, nudge, dialog).
  const lm = editor.lastTransform?.matrix;
  if (kind === 'move' && lm && Math.abs(lm[0] - 1) < 1e-9 && Math.abs(lm[3] - 1) < 1e-9 && Math.abs(lm[1]) < 1e-9 && Math.abs(lm[2]) < 1e-9) {
    last.dx = lm[4];
    last.dy = lm[5];
  }
  const patterns = usesPatternPaint(doc, editor.topSelection());
  const transformOptions = (inline = true) => [
    { key: 'objects', label: 'Transform Objects', type: 'checkbox', value: true },
    // Pattern fills move with their objects unless this is off; without patterns there is nothing to choose.
    { key: 'patterns', label: 'Transform Patterns', type: 'checkbox', value: patterns ? (app.prefs.get('transformPatterns') ?? true) : false, inline, disabled: () => !patterns },
  ];
  const polar = (dx, dy) => ({ dist: Math.hypot(dx, dy), ang: Math.hypot(dx, dy) < 1e-9 ? 0 : (Math.atan2(-dy, dx) * 180) / Math.PI });
  // Move: Distance and Angle follow Horizontal and Vertical, and the other way round (angles are counterclockwise, y down).
  const syncPolar = (_, form) => {
    const p = polar(form.get('dx'), form.get('dy'));
    form.set('distance', round(p.dist));
    form.set('moveAngle', round(p.ang, 3));
  };
  const syncCartesian = (_, form) => {
    const d = form.get('distance');
    const a = (form.get('moveAngle') * Math.PI) / 180;
    if (!Number.isFinite(d) || !Number.isFinite(a)) return;
    form.set('dx', round(d * Math.cos(a)));
    form.set('dy', round(-d * Math.sin(a)));
  };
  // Absolute sizes start from (and keep the proportions of) the first selected object.
  const firstId = editor.topSelection()[0];
  const sel = firstId ? nodeBounds(doc, doc.get(firstId)) : null;
  // Constrain Proportions keeps the two scale values (or the width and height) in step.
  const constrained = (key, other, ratio) => (v, form) => {
    if (form.get('constrain')) form.set(other, round(v * ratio()));
  };
  const aspect = () => (sel && sel.w > 0 && sel.h > 0 ? sel.h / sel.w : 1);
  const fields = {
    move: [
      { type: 'heading', label: 'Position' },
      { key: 'dx', label: 'Horizontal', type: 'length', value: last.dx, onInput: syncPolar },
      { key: 'dy', label: 'Vertical', type: 'length', value: last.dy, onInput: syncPolar },
      { key: 'distance', label: 'Distance', type: 'length', value: polar(last.dx, last.dy).dist, min: 0, onInput: syncCartesian },
      { key: 'moveAngle', label: 'Angle', type: 'angle', value: round(polar(last.dx, last.dy).ang, 3), dial: true, onInput: syncCartesian },
      optionHeading,
      ...transformOptions(),
    ],
    rotate: [{ key: 'angle', label: 'Angle', type: 'angle', value: last.angle, dial: true }, optionHeading, ...transformOptions()],
    reflect: [
      {
        key: 'axis',
        label: 'Axis',
        type: 'radio',
        value: last.axis,
        options: [
          { value: 'horizontal', label: 'Horizontal' },
          { value: 'vertical', label: 'Vertical' },
          { value: 'angle', label: 'Angle' },
        ],
      },
      { key: 'angle', label: 'Angle', type: 'angle', value: last.angle, dial: true, disabled: (v) => v.axis !== 'angle' },
      optionHeading,
      ...transformOptions(),
    ],
    scale: [
      {
        key: 'mode',
        label: 'Scale',
        type: 'radio',
        value: last.mode,
        options: [
          { value: 'uniform', label: 'Uniform' },
          { value: 'nonuniform', label: 'Non-Uniform' },
        ],
      },
      { key: 'uniformPct', label: 'Uniform scale', type: 'percent', value: last.uniformPct, disabled: (v) => v.mode !== 'uniform' },
      { key: 'sx', label: 'Horizontal', type: 'percent', value: last.sx, disabled: (v) => v.mode === 'uniform' },
      { key: 'sy', label: 'Vertical', type: 'percent', value: last.sy, disabled: (v) => v.mode === 'uniform' },
      optionHeading,
      { key: 'corners', label: 'Scale Corners', type: 'checkbox', value: app.prefs.get('scaleCorners') },
      { key: 'strokes', label: 'Scale Strokes & Effects', type: 'checkbox', value: app.prefs.get('scaleStrokes') },
      ...transformOptions(),
    ],
    shear: [
      { key: 'angle', label: 'Shear Angle', type: 'angle', value: last.angle, min: -89.9, max: 89.9, dial: true },
      {
        key: 'axis',
        label: 'Axis',
        type: 'radio',
        value: last.axis,
        options: [
          { value: 'horizontal', label: 'Horizontal' },
          { value: 'vertical', label: 'Vertical' },
          { value: 'angle', label: 'Angle' },
        ],
      },
      { key: 'axisAngle', label: 'Axis Angle', type: 'angle', value: last.axisAngle, dial: true, disabled: (v) => v.axis !== 'angle' },
      optionHeading,
      ...transformOptions(),
    ],
    each: [
      { type: 'heading', label: 'Scale' },
      {
        key: 'mode',
        label: 'Values are',
        type: 'radio',
        value: last.mode,
        options: [
          { value: 'relative', label: 'Relative (%)' },
          { value: 'absolute', label: 'Absolute size' },
        ],
      },
      { key: 'scaleX', label: 'Horizontal', type: 'percent', value: last.scaleX, min: 0, slider: [0, 200], disabled: (v) => v.mode !== 'relative', onInput: constrained('scaleX', 'scaleY', () => 1) },
      { key: 'scaleY', label: 'Vertical', type: 'percent', value: last.scaleY, min: 0, slider: [0, 200], disabled: (v) => v.mode !== 'relative', onInput: constrained('scaleY', 'scaleX', () => 1) },
      { key: 'width', label: 'Width', type: 'length', value: last.width ?? sel?.w ?? 100, min: 0, disabled: (v) => v.mode !== 'absolute', onInput: constrained('width', 'height', aspect) },
      { key: 'height', label: 'Height', type: 'length', value: last.height ?? sel?.h ?? 100, min: 0, disabled: (v) => v.mode !== 'absolute', onInput: constrained('height', 'width', () => 1 / aspect()) },
      { key: 'constrain', label: 'Constrain Proportions', type: 'checkbox', value: last.constrain },
      { type: 'heading', label: 'Move' },
      { key: 'moveX', label: 'Horizontal', type: 'length', value: last.moveX, slider: [-500, 500] },
      { key: 'moveY', label: 'Vertical', type: 'length', value: last.moveY, slider: [-500, 500] },
      { type: 'heading', label: 'Rotate' },
      { key: 'angle', label: 'Angle', type: 'angle', value: last.angle, dial: true },
      optionHeading,
      ...transformOptions(false),
      { key: 'strokes', label: 'Scale Strokes & Effects', type: 'checkbox', value: app.prefs.get('scaleStrokes') },
      { key: 'corners', label: 'Scale Corners', type: 'checkbox', value: app.prefs.get('scaleCorners') },
      { key: 'reflectX', label: 'Reflect X', type: 'checkbox', value: last.reflectX },
      { key: 'reflectY', label: 'Reflect Y', type: 'checkbox', value: last.reflectY, inline: true },
      { key: 'random', label: 'Random', type: 'checkbox', value: last.random, inline: true },
      { key: 'ref', label: 'Reference Point', type: 'refpoint', value: last.ref },
    ],
  }[kind];
  fields.push({ key: 'preview', label: 'Preview', type: 'checkbox', value: last.preview });

  let tx = null;
  // One seed per dialog session: the random preview is what OK applies.
  const seed = (Math.random() * 2 ** 32) >>> 0;
  const optsFor = (v) => ({
    scaleStrokes: 'strokes' in v ? v.strokes : app.prefs.get('scaleStrokes'),
    scaleCorners: 'corners' in v ? v.corners : app.prefs.get('scaleCorners'),
    transformPatterns: patterns ? v.patterns : (app.prefs.get('transformPatterns') ?? true),
    ...(v.objects === false ? { transformObjects: false } : {}),
  });
  const eachParams = (v) => ({
    scaleX: v.mode === 'absolute' ? v.width : v.scaleX,
    scaleY: v.mode === 'absolute' ? v.height : v.scaleY,
    absolute: v.mode === 'absolute',
    moveX: v.moveX,
    moveY: v.moveY,
    angle: v.angle,
    reflectX: v.reflectX,
    reflectY: v.reflectY,
    random: v.random,
    seed,
    refX: v.ref?.x ?? v.refX ?? 0.5,
    refY: v.ref?.y ?? v.refY ?? 0.5,
    scaleStrokes: v.strokes,
    scaleCorners: v.corners,
    objects: v.objects,
    patterns: patterns ? v.patterns : undefined,
  });
  const rollback = () => {
    if (tx) {
      tx.cancel();
      tx = null;
    }
  };
  const preview = (v) => {
    rollback();
    if (!v.preview) return;
    if (v.objects === false && !(patterns && v.patterns)) return;
    tx = doc.begin(titles[kind]);
    if (kind === 'each') transformEach(editor, eachParams(v));
    else transformNodes(doc, editor.topSelection(), matrixFor(kind, v, c), optsFor(v));
  };
  const result = await formDialog(app, {
    title: titles[kind],
    fields,
    onChange: preview,
    previewToggle: last.preview,
    className: kind === 'each' ? 'transform-each-dialog' : '',
    extraButtons: [{ label: 'Copy', action: 'copy', left: true }],
  });
  rollback();
  if (!result) return;
  const copy = result.__action === 'copy';
  if ('strokes' in result) app.prefs.set('scaleStrokes', result.strokes);
  if ('corners' in result) app.prefs.set('scaleCorners', result.corners);
  if (patterns && result.objects) app.prefs.set('transformPatterns', result.patterns);
  const { __action, ...remember } = result;
  Object.assign(LAST[kind], remember);
  if (result.objects === false && !(patterns && result.patterns)) return;
  if (kind === 'each') {
    const p = eachParams(result);
    doc.transact('Transform Each', () => transformEach(editor, p, copy));
    // Transform Again draws new random values.
    editor.lastTransform = { each: { ...p, seed: undefined }, copy };
    return;
  }
  applyTransform(editor, titles[kind], matrixFor(kind, result, c), { copy, opts: optsFor(result) });
}

export async function averageDialog(app) {
  const v = await formDialog(app, {
    title: 'Average',
    fields: [
      {
        key: 'axis',
        label: 'Axis',
        type: 'radio',
        value: 'both',
        options: [
          { value: 'h', label: 'Horizontal' },
          { value: 'v', label: 'Vertical' },
          { value: 'both', label: 'Both' },
        ],
      },
    ],
  });
  if (v) average(app.editor, v.axis);
}
