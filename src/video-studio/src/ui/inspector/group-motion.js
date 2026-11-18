/** Editable motion retained from compounds that have been broken apart. */
import { h } from '../../lib/dom.js';
import { inheritedTime, inheritedLocal } from '../../model/inherited-motion.js';
import { valueAt, baseValue, setBaseValue, setKey, keyIndexAt, removeKey } from '../../model/keyframes.js';
import { ANIMATIONS } from '../../model/catalog.js';
import { selectField } from '../controls.js';
import { scaleFields } from './video-extras.js';
import { volumeSlider } from './audio.js';
import { slider, toggle, propSection, note } from './common.js';

export function inheritedPaths(clip) {
  const paths = [];
  if (!clip.inherited?.length) return paths;
  const pending = [];
  const append = (owner, path) => {
    for (let i = (owner.inherited?.length || 0) - 1; i >= 0; i--) pending.push({ clip: owner.inherited[i].parent, path: [...path, i] });
  };
  append(clip, []);
  while (pending.length) {
    const item = pending.pop();
    if (!item.clip.clockOnly) paths.push(item.path);
    append(item.clip, item.path);
  }
  return paths;
}

const recordAt = (clip, path) => {
  let record;
  for (const i of path) { record = clip?.inherited?.[i]; clip = record?.parent; }
  return record;
};

export function groupMotionView(view, path) {
  const onClip = () => view.store.time >= view.clip.start && view.store.time <= view.clip.start + view.clip.duration;
  const timeAt = time => {
    let clip = view.clip;
    for (const i of path) {
      const record = clip.inherited[i];
      time = inheritedTime(record, clip, time);
      clip = record.parent;
    }
    return time;
  };
  const local = () => Math.max(0, Math.min(recordAt(view.clip, path).parent.duration, timeAt(view.local())));
  const tolerance = () => {
    const time = view.local();
    const center = timeAt(time);
    return Math.max(0.5, Math.abs(timeAt(time + view.tol()) - center), Math.abs(timeAt(time - view.tol()) - center));
  };
  const group = {
    ctx: view.ctx, store: view.store, id: view.id, bind: view.bind, tol: tolerance,
    get clip() { return recordAt(view.clip, path)?.parent; },
    get found() { return view.found; },
    get project() { return view.project; },
    local,
    edit(label, fn, opts) { return view.edit(label, c => fn(recordAt(c, path).parent), opts); },
    valueOf(prop) { return valueAt(group.clip.keyframes, prop, local(), baseValue(group.clip, prop)); },
    keyState(prop) {
      const keys = group.clip.keyframes?.[prop];
      return !keys?.length ? 'none' : onClip() && keyIndexAt(group.clip.keyframes, prop, local(), tolerance()) >= 0 ? 'on' : 'some';
    },
    animate(prop, value, opts = {}) {
      if (group.clip.keyframes?.[prop]?.length && !onClip()) { view.actions.playheadHint(); return false; }
      return group.edit(opts.label || 'Edit group motion', c => {
        if (c.keyframes?.[prop]?.length) setKey(c.keyframes, prop, Math.round(local()), value, 'linear', tolerance());
        else setBaseValue(c, prop, value);
      }, { key: `group:${path.join('.')}:${prop}`, final: opts.final });
    },
    jumpKey(prop, dir) {
      const frames = [];
      let clip = view.clip;
      for (const i of path) { const record = clip.inherited[i]; frames.push({ clip, record }); clip = record.parent; }
      const times = (group.clip.keyframes?.[prop] || []).map(k => {
        let time = k.t;
        for (let i = frames.length - 1; i >= 0; i--) time = inheritedLocal(frames[i].record, frames[i].clip, time);
        return time;
      }).filter(t => t >= 0 && t <= view.clip.duration).sort((a, b) => a - b);
      const target = dir < 0 ? times.filter(t => t < view.local() - view.tol()).at(-1) : times.find(t => t > view.local() + view.tol());
      if (target !== undefined) view.store.seek(view.clip.start + target);
    },
  };
  group.actions = {
    toggleKeyframe(_id, prop) {
      if (!onClip()) { view.actions.playheadHint(); return; }
      group.edit('Toggle group keyframe', c => {
        c.keyframes ||= {};
        const time = Math.round(local());
        if (keyIndexAt(c.keyframes, prop, time, tolerance()) >= 0) {
          const value = group.valueOf(prop);
          removeKey(c.keyframes, prop, time, tolerance());
          if (!c.keyframes[prop]?.length) setBaseValue(c, prop, value);
        } else setKey(c.keyframes, prop, time, group.valueOf(prop), 'linear', tolerance());
      });
    },
  };
  return group;
}

export function groupMotionTab(view) {
  const paths = inheritedPaths(view.clip);
  const panel = h('div');
  let selected = 0;
  const picker = selectField({ label: 'Group', options: paths.map((path, i) => ({ value: String(i), label: recordAt(view.clip, path).parent.name || `Group ${i + 1}` })), value: '0', onChange: value => { selected = Number(value); render(); } });
  const render = () => {
    view.resetScope();
    const path = paths[selected];
    const group = groupMotionView(view, path);
    const fields = [];
    if (view.clip.transform) {
      const { width, height } = view.project.settings;
      for (const [prop, label, min, max, unit, factor] of [['x', 'Position X', -width, width, 'px', width], ['y', 'Position Y', -height, height, 'px', -height], ['scale', 'Scale', 1, 500, '%', 100], ['rotation', 'Rotation', -360, 360, '°', 1], ['opacity', 'Opacity', 0, 100, '%', 100]]) {
        const limits = prop === 'scale' ? { hardMax: 5000 } : prop === 'rotation' ? { hardMin: -3600, hardMax: 3600 } : prop === 'x' || prop === 'y' ? { hardMin: -20000, hardMax: 20000 } : {};
        fields.push(slider(group, { label, prop, min, max, ...limits, step: prop === 'rotation' ? 0.1 : 1, unit, get: () => group.valueOf(prop) * factor, set: (v, final) => group.animate(prop, v / factor, { label: `Group ${label.toLowerCase()}`, final }) }).el);
      }
      fields.push(...scaleFields(group));
      for (const [key, label] of [['flipH', 'Flip horizontal'], ['flipV', 'Flip vertical']]) fields.push(toggle(group, { label, get: c => c.transform[key], set: value => group.edit(label, c => { c.transform[key] = value; }) }).el);
    }
    if ('volume' in view.clip) {
      fields.push(volumeSlider(group).el);
      for (const [key, label] of [['fadeIn', 'Fade in'], ['fadeOut', 'Fade out']]) fields.push(slider(group, { label, min: 0, max: group.clip.duration / 1e6, step: 0.1, unit: 's', get: c => c[key] / 1e6, set: (v, final) => group.edit(label, c => { c[key] = v * 1e6; }, { key, final }) }).el);
    }
    if (view.clip.transform) for (const [kind, key, label] of [['in', 'animIn', 'Animate in'], ['out', 'animOut', 'Animate out'], ['loop', 'animLoop', 'Loop']]) {
      const select = selectField({ label, options: [{ value: '', label: 'None' }, ...ANIMATIONS[kind].filter(a => !a.textOnly).map(a => ({ value: a.id, label: a.label }))], value: group.clip[key]?.id || '', onChange: id => group.edit(label, c => { c[key] = id ? { id, duration: c[key]?.duration || Math.min(1e6, c.duration) } : null; }) });
      group.bind(() => select.set(group.clip[key]?.id || ''));
      const duration = slider(group, { label: `${kind[0].toUpperCase()}${kind.slice(1)} duration`, min: 0.1, max: Math.max(0.1, group.clip.duration / 1e6), step: 0.1, unit: 's', get: c => (c[key]?.duration || 1e6) / 1e6, set: (v, final) => group.edit(label, c => { if (c[key]) c[key].duration = v * 1e6; }, { key, final }) });
      const showDuration = () => { duration.el.hidden = !group.clip[key]; };
      showDuration(); group.bind(showDuration);
      fields.push(select.el, duration.el);
    }
    const remove = h('button.btn', { type: 'button' }, 'Remove group motion');
    remove.addEventListener('click', () => view.edit('Remove group motion', c => {
      const parent = recordAt(c, path).parent;
      if (parent.inherited?.length) {
        // Outer groups still need this group's clock after its own motion is removed.
        parent.clockOnly = true;
        return;
      }
      let owner = c;
      const ancestors = [];
      for (const i of path.slice(0, -1)) { ancestors.push({ owner, i }); owner = owner.inherited[i].parent; }
      owner.inherited.splice(path.at(-1), 1);
      if (!owner.inherited.length) delete owner.inherited;
      while (owner.clockOnly && !owner.inherited?.length && ancestors.length) {
        const entry = ancestors.pop(); owner = entry.owner;
        owner.inherited.splice(entry.i, 1);
        if (!owner.inherited.length) delete owner.inherited;
      }
    }));
    panel.replaceChildren(propSection('Group motion', [note('Motion and volume retained from the former compound. These controls affect only this clip.'), ...fields, remove]));
  };
  render();
  return h('div', picker.el, panel);
}
