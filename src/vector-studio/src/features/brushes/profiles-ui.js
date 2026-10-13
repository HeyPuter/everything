/**
 * Width profiles in the Stroke panel and the Properties panel: a Profile
 * picker (Uniform, the built-in shapes and saved ones) with Flip Along /
 * Flip Across, Add to Profiles, Delete Profile and Reset Profiles; and the
 * Properties panel's brush picker.
 *
 * Saved profiles are an app preference ('widthProfiles': [{ id, name,
 * points }]), so they are available in every document.
 */
import { h } from '../../lib/dom.js';
import { iconButton } from '../../ui/widgets.js';
import { openPopover, closePopover } from '../../ui/popover.js';
import { WIDTH_PROFILES, flipAlong, flipAcross, sameProfile, isUniformProfile, normalizeProfile } from './width-profile.js';
import { profilePreview } from './thumbs.js';
import { brushTargets, selectionBrush, applyBrush, removeBrush, pickedStroke } from './brush-ops.js';
import { setItemAttrs } from '../paint/appearance-ops.js';
import { stackItems } from '../../model/appearance.js';
import { docBrushes, BRUSH_TYPES } from './brush-model.js';
import { brushState, editSelectedStrokeOptions } from './brush-actions.js';

/** Paths and compound paths with a stroke under the selection. */
export function profileTargets(editor) {
  return brushTargets(editor).filter((n) => n.stroke && n.strokeWidth > 0);
}

/** The selection's common profile: points, null (uniform), 'mixed', or undefined (no stroked path). */
export function selectionProfile(editor) {
  // A stroke picked in the Appearance panel shows its own profile.
  const item = pickedStroke(editor);
  if (item) {
    const ps = item.owners.map((n) => {
      const p = stackItems(n)[item.index]?.widthProfile;
      return isUniformProfile(p) ? null : p;
    });
    return ps.every((p) => sameProfile(p, ps[0])) ? ps[0] : 'mixed';
  }
  const t = profileTargets(editor);
  if (!t.length) return undefined;
  const first = isUniformProfile(t[0].widthProfile) ? null : t[0].widthProfile;
  for (const n of t) {
    const p = isUniformProfile(n.widthProfile) ? null : n.widthProfile;
    if (!sameProfile(p, first)) return 'mixed';
  }
  return first;
}

/** Set (or with a function, transform) the width profile of the selected strokes. */
export function applyProfile(editor, pointsOrFn, label = 'Stroke Profile') {
  const item = pickedStroke(editor);
  if (item) {
    return setItemAttrs(editor, item.index, {
      widthProfile: (curRaw) => {
        const cur = isUniformProfile(curRaw) ? null : curRaw;
        const next = typeof pointsOrFn === 'function' ? (cur ? pointsOrFn(cur) : null) : pointsOrFn ? normalizeProfile(pointsOrFn) : null;
        return next && !isUniformProfile(next) ? next : undefined;
      },
    }, label);
  }
  const t = profileTargets(editor);
  if (!t.length) return false;
  const doc = editor.doc;
  doc.transact(label, () => {
    for (const n of t) {
      const cur = isUniformProfile(n.widthProfile) ? null : n.widthProfile;
      const next = typeof pointsOrFn === 'function' ? (cur ? pointsOrFn(cur) : null) : pointsOrFn ? normalizeProfile(pointsOrFn) : null;
      doc.update(n.id, { widthProfile: next && !isUniformProfile(next) ? next : undefined });
    }
  });
  return true;
}

export function savedProfiles(app) {
  const list = app.prefs.get('widthProfiles');
  return Array.isArray(list) ? list : [];
}

export function allProfiles(app) {
  return [...WIDTH_PROFILES, ...savedProfiles(app).map((p) => ({ ...p, saved: true }))];
}

/** Which listed profile matches the selection ('custom' when none does). */
function matchProfile(app, cur) {
  if (cur === undefined || cur === 'mixed') return cur;
  return allProfiles(app).find((p) => sameProfile(p.points, cur))?.id || 'custom';
}

/** Add to Profiles: save the selection's profile under a name. */
export async function addToProfiles(app) {
  const ed = app.editor;
  const cur = ed && selectionProfile(ed);
  if (!cur || cur === 'mixed') {
    app.notify('Select a path with a variable width to save its profile.');
    return false;
  }
  const n = savedProfiles(app).length + 1;
  const v = await app.dialogs.form({ title: 'Add to Profiles', fields: [{ key: 'name', label: 'Profile Name', type: 'text', value: `Width Profile ${n}` }], okLabel: 'Add' });
  if (!v) return false;
  const name = (v.name || '').trim() || `Width Profile ${n}`;
  app.prefs.set('widthProfiles', [...savedProfiles(app), { id: `user-${Date.now().toString(36)}`, name, points: cur }]);
  return true;
}

/**
 * The profile picker: a button showing the selection's profile that opens
 * a list of profiles, with the flip buttons beside it.
 */
export function profileControl(app) {
  const btn = h('button.sp-profile', { type: 'button', 'aria-haspopup': 'listbox', 'aria-label': 'Width profile' });
  const flipA = iconButton('flip-along', 'Flip Along', () => app.editor && applyProfile(app.editor, flipAlong, 'Flip Profile Along'), { className: 'small' });
  const flipX = iconButton('flip-across', 'Flip Across', () => app.editor && applyProfile(app.editor, flipAcross, 'Flip Profile Across'), { className: 'small' });
  const open = () => {
    const ed = app.editor;
    if (!ed) return;
    const curId = matchProfile(app, selectionProfile(ed));
    let focused = curId;
    const choose = (p) => {
      closePopover();
      applyProfile(ed, p.points, 'Stroke Profile');
      btn.focus();
    };
    const opts = allProfiles(app).map((p) =>
      h(
        'button.sp-profile-opt',
        {
          type: 'button',
          role: 'option',
          'aria-selected': String(p.id === curId),
          'aria-label': p.name,
          'data-id': p.id,
          onclick: () => choose(p),
          onfocus: () => {
            focused = p.id;
            delBtn.disabled = !p.saved;
          },
          onkeydown: (e) => {
            const items = [...list.querySelectorAll('.sp-profile-opt')];
            const i = items.indexOf(e.currentTarget);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
            }
          },
        },
        profilePreview(p.points),
        h('span', p.name),
      ),
    );
    const list = h('div.sp-profile-list', { role: 'listbox', 'aria-label': 'Width profiles' }, opts);
    const addBtn = h('button.btn.small', { type: 'button', onclick: async () => {
      closePopover();
      await addToProfiles(app);
    } }, 'Add to Profiles');
    const delBtn = h('button.btn.small', { type: 'button', disabled: !allProfiles(app).find((p) => p.id === curId)?.saved, onclick: () => {
      const target = savedProfiles(app).find((p) => p.id === focused);
      if (!target) return;
      app.prefs.set('widthProfiles', savedProfiles(app).filter((p) => p.id !== target.id));
      closePopover();
      app.notify(`Deleted “${target.name}”.`, { polite: true });
      btn.focus();
    } }, 'Delete Profile');
    const resetBtn = h('button.btn.small', { type: 'button', disabled: !savedProfiles(app).length, onclick: async () => {
      closePopover();
      const ok = await app.dialogs.confirm({ title: 'Reset Profiles', message: 'Remove all saved width profiles? The built-in ones stay.', okLabel: 'Reset', danger: true });
      if (ok) app.prefs.set('widthProfiles', []);
    } }, 'Reset');
    const content = h('div.sp-profile-pop', list, h('div.sp-profile-actions', addBtn, delBtn, resetBtn));
    openPopover(btn, content, { label: 'Width profiles' });
    (list.querySelector('[aria-selected="true"]') || list.firstChild).focus();
  };
  btn.addEventListener('click', open);
  const el = h('div.sp-profile-row', btn, flipA, flipX);
  const refresh = () => {
    const ed = app.editor;
    const cur = ed ? selectionProfile(ed) : undefined;
    const disabled = cur === undefined;
    btn.disabled = disabled;
    flipA.disabled = flipX.disabled = disabled || !cur || cur === 'mixed';
    const id = matchProfile(app, cur);
    const name = cur === 'mixed' ? 'Mixed' : cur === undefined ? 'Uniform' : allProfiles(app).find((p) => p.id === id)?.name || 'Custom';
    btn.replaceChildren(profilePreview(cur && cur !== 'mixed' ? cur : null, { w: 84, h: 16 }), h('span.sp-profile-name', name));
    btn.setAttribute('data-tip', `Profile: ${name}`);
    btn.setAttribute('aria-label', `Width profile: ${name}`);
  };
  return { el, refresh };
}

/** Stroke panel section: the Profile row. */
export function strokeProfileSection(app) {
  const ctl = profileControl(app);
  const el = h('div.pp-row.sp-profile-section', h('span.pp-label', 'Profile'), ctl.el);
  return { el, refresh: ctl.refresh };
}

/** Properties panel section: brush and width profile of the selected paths. */
export function propertiesBrushSection() {
  return {
    id: 'brush-stroke',
    title: 'Brush & Width',
    // Not for live objects (envelopes, repeats, ...), whose paths are their contents.
    when: (ed) => brushTargets(ed).length > 0 && !ed.selectedNodes().some((n) => n.type === 'group' && n.live),
    build: (app) => {
      const sel = h('select.select', { 'aria-label': 'Brush' });
      sel.addEventListener('change', () => {
        const ed = app.editor;
        if (!ed) return;
        if (sel.value === '__none') removeBrush(ed);
        else if (sel.value) {
          brushState(app).currentId = sel.value;
          applyBrush(ed, sel.value);
        }
      });
      const opt = iconButton('brush-stroke-options', 'Options of Selected Object', () => editSelectedStrokeOptions(app), { className: 'small' });
      const lib = iconButton('brushes', 'Open Brushes Panel', () => app.openPanel('brushes'), { className: 'small' });
      const prof = profileControl(app);
      const el = h('div.br-props', h('div.app-row', h('span.app-label', 'Brush'), sel, opt, lib), h('div.app-row', h('span.app-label', 'Profile'), prof.el));
      let key = null;
      const refresh = () => {
        const ed = app.editor;
        if (!ed) return;
        const active = selectionBrush(ed);
        const list = docBrushes(ed.doc);
        const k = [list, active];
        if (!key || k.some((x, i) => x !== key[i])) {
          key = k;
          const groups = Object.keys(BRUSH_TYPES)
            .map((t) => [t, list.filter((b) => b.type === t)])
            .filter(([, bs]) => bs.length)
            .map(([t, bs]) => h('optgroup', { label: BRUSH_TYPES[t].label }, bs.map((b) => h('option', { value: b.id }, b.name))));
          const extra = active && active !== 'mixed' && !list.some((b) => b.id === active) ? [h('option', { value: active }, 'Unknown brush')] : [];
          sel.replaceChildren(h('option', { value: '__none' }, 'Basic stroke (no brush)'), ...(active === 'mixed' ? [h('option', { value: '' }, 'Mixed')] : []), ...groups, ...extra);
          sel.value = active === 'mixed' ? '' : active || '__none';
        }
        opt.disabled = !active || active === 'mixed';
        prof.refresh();
      };
      return { el, refresh };
    },
  };
}
