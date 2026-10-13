/**
 * Effect menu commands and dialogs: Drop Shadow, Inner Glow, Outer Glow,
 * Gaussian Blur, Feather and Round Corners, plus Apply Last Effect and
 * Last Effect. Dialogs preview live inside an open transaction that Cancel
 * rolls back, so the whole edit is one undo step. Effects are added to the
 * selected objects themselves (groups render their effects on the group's
 * isolated layer).
 */
import { EFFECTS, createEffect, normalizeEffect, effectLabel } from './effects-model.js';
import { BLEND_MODES } from '../../render/draw.js';
import { BLEND_LABELS } from '../../ui/panels/properties.js';
import { effectItemIndex, effectsOf, effectsPatch } from './appearance-ops.js';

export { effectsOf, effectsPatch };

/** Objects effects apply to: the top-level selection (not layers). */
export function effectTargets(editor) {
  return editor.topSelection().map((id) => editor.doc.get(id)).filter((n) => n && n.type !== 'layer');
}

const modeOptions = () => BLEND_MODES.map((m) => ({ value: m, label: BLEND_LABELS[m] || m }));

/** Form fields for an effect's dialog, filled from params. */
export function effectFields(type, p) {
  switch (type) {
    case 'dropShadow':
      return [
        { key: 'mode', label: 'Mode', type: 'select', options: modeOptions(), value: p.mode },
        { key: 'opacity', label: 'Opacity', type: 'percent', value: p.opacity * 100, min: 0, max: 100 },
        { key: 'x', label: 'X Offset', type: 'length', value: p.x },
        { key: 'y', label: 'Y Offset', type: 'length', value: p.y },
        { key: 'blur', label: 'Blur', type: 'length', value: p.blur, min: 0 },
        {
          key: 'shadowFrom',
          label: 'Shadow',
          type: 'radio',
          value: p.shadowFrom || 'color',
          options: [
            { value: 'color', label: 'Color' },
            { value: 'darkness', label: 'Darkness' },
          ],
        },
        { key: 'color', label: 'Color', type: 'color', value: p.color, disabled: (v) => v.shadowFrom === 'darkness' },
        { key: 'darkness', label: 'Darkness', type: 'percent', value: (p.darkness ?? 1) * 100, min: 0, max: 100, disabled: (v) => v.shadowFrom !== 'darkness' },
      ];
    case 'innerGlow':
      return [
        { key: 'mode', label: 'Mode', type: 'select', options: modeOptions(), value: p.mode },
        { key: 'color', label: 'Color', type: 'color', value: p.color },
        { key: 'opacity', label: 'Opacity', type: 'percent', value: p.opacity * 100, min: 0, max: 100 },
        { key: 'blur', label: 'Blur', type: 'length', value: p.blur, min: 0 },
        { key: 'source', label: 'Source', type: 'radio', value: p.source, options: [{ value: 'center', label: 'Center' }, { value: 'edge', label: 'Edge' }] },
      ];
    case 'outerGlow':
      return [
        { key: 'mode', label: 'Mode', type: 'select', options: modeOptions(), value: p.mode },
        { key: 'color', label: 'Color', type: 'color', value: p.color },
        { key: 'opacity', label: 'Opacity', type: 'percent', value: p.opacity * 100, min: 0, max: 100 },
        { key: 'blur', label: 'Blur', type: 'length', value: p.blur, min: 0 },
      ];
    case 'blur':
      return [{ key: 'radius', label: 'Radius', type: 'length', value: p.radius, min: 0, max: 250 }];
    case 'feather':
      return [{ key: 'radius', label: 'Feather Radius', type: 'length', value: p.radius, min: 0 }];
    case 'roundCorners':
      return [{ key: 'radius', label: 'Radius', type: 'length', value: p.radius, min: 0 }];
    default:
      return [];
  }
}

/** Effect params from dialog values. */
export function effectFromValues(type, v) {
  const out = { type };
  for (const [k, val] of Object.entries(v)) {
    if (k === 'preview' || k === '__action') continue;
    out[k] = k === 'opacity' || k === 'darkness' ? val / 100 : val;
  }
  return normalizeEffect(out);
}

/** Remember the last effect for Apply Last Effect / Last Effect. */
export function rememberEffect(app, effect) {
  app.lastEffect = { ...effect };
  delete app.lastEffect.hidden;
}

/**
 * Open an effect dialog. With `edit` ({ id, index, item? }) it edits an
 * existing effect on one object (on one of its appearance items with
 * `item`); otherwise it adds a new effect to the selection, or to the fill
 * or stroke picked in the Appearance panel.
 */
export async function effectDialog(app, type, { params = null, edit = null } = {}) {
  const ed = app.editor;
  if (!ed) return false;
  // Effect types with their own dialog (Warp, Transform, Scribble, ...).
  if (EFFECTS[type]?.openDialog) return EFFECTS[type].openDialog(app, { params, edit });
  const doc = ed.doc;
  const targets = edit ? [doc.get(edit.id)].filter(Boolean) : effectTargets(ed);
  if (!targets.length) {
    app.notify('Select an object to apply the effect to.');
    return false;
  }
  const slot = edit ? edit.item ?? null : effectItemIndex(ed);
  const start = normalizeEffect({ type, ...(params || (edit ? effectsOf(targets[0], slot)[edit.index] : null) || app.lastEffects?.[type] || EFFECTS[type].defaults) });
  const originals = new Map(targets.map((n) => [n.id, effectsOf(n, slot)]));
  const label = EFFECTS[type].label;
  const tx = doc.begin(label);
  const apply = (fx) => {
    for (const [id, orig] of originals) {
      let list;
      if (edit) {
        list = orig.slice();
        list[edit.index] = fx ? { ...fx, ...(orig[edit.index]?.hidden ? { hidden: true } : {}) } : orig[edit.index];
      } else list = fx ? [...orig, fx] : orig;
      doc.update(id, effectsPatch(doc.get(id), slot, list));
    }
  };
  let res = null;
  try {
    res = await app.dialogs.form({
      title: label,
      fields: [...effectFields(type, start), { key: 'preview', label: 'Preview', type: 'checkbox', value: true }],
      previewToggle: true,
      onChange: (v) => apply(v.preview ? effectFromValues(type, v) : null),
    });
  } catch (err) {
    tx.cancel();
    throw err;
  }
  if (!res) {
    tx.cancel();
    return false;
  }
  const fx = effectFromValues(type, res);
  apply(fx);
  tx.commit();
  app.lastEffects = { ...(app.lastEffects || {}), [type]: fx };
  rememberEffect(app, fx);
  return true;
}

/** Add an effect record to the selection without a dialog. */
export function applyEffect(app, fx) {
  const ed = app.editor;
  if (!ed) return;
  const targets = effectTargets(ed);
  if (!targets.length) return;
  const e = normalizeEffect(fx);
  if (!e) return;
  const slot = effectItemIndex(ed);
  ed.doc.transact(`Apply ${effectLabel(e)}`, () => {
    for (const n of targets) ed.doc.update(n.id, effectsPatch(n, slot, [...effectsOf(n, slot), { ...e }]));
  });
  rememberEffect(app, e);
}

export function registerEffectCommands(app) {
  const hasSel = (a) => Boolean(a.editor && a.editor.selection.size);
  const cmds = Object.entries(EFFECTS).map(([type, def]) => ({
    id: def.command,
    label: `${def.label}...`,
    enabled: hasSel,
    run: (a) => effectDialog(a, type),
  }));
  cmds.push(
    {
      id: 'effect.applyLast',
      label: (a) => (a.lastEffect ? `Apply ${effectLabel(a.lastEffect)}` : 'Apply Last Effect'),
      shortcut: 'Shift+Mod+E',
      enabled: (a) => hasSel(a) && Boolean(a.lastEffect),
      run: (a) => applyEffect(a, a.lastEffect),
    },
    {
      id: 'effect.last',
      label: (a) => (a.lastEffect ? `${effectLabel(a.lastEffect)}...` : 'Last Effect...'),
      shortcut: 'Alt+Shift+Mod+E',
      enabled: (a) => hasSel(a) && Boolean(a.lastEffect),
      run: (a) => effectDialog(a, a.lastEffect.type, { params: a.lastEffect }),
    },
  );
  app.commands.register(cmds);
}

export { createEffect };
