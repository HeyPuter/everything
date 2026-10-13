/**
 * Video > Remove: take an unwanted object, logo or watermark out of the
 * shot. Paint over it or drag a box around it on the preview
 * (ui/removal-overlay.js); it is filled from the picture around it on every
 * frame (model/removal.js, engine/source-fx.js). Regions can follow a
 * moving object with the motion tracker or keyframed positions.
 */
import '../../styles/masks.css';
import { h, announce } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import {
  REMOVAL_DEFAULT, REGION_TYPES, MAX_REGIONS, defaultRegion, addRegion, removeRegion, regionProp, regionHasShape, clearRegionKeys, REGION_KEYED,
} from '../../model/removal.js';
import { segmented, sliderField, switchField } from '../controls.js';
import { slider, propSection, createScope, note, toggle } from './common.js';
import { removeEdit, REMOVE_TOOLS } from '../remove-edit-state.js';
import { followRegion } from '../removal-track.js';
import { toast } from '../dialog.js';

const typeOf = (id) => REGION_TYPES.find((t) => t.id === id) || REGION_TYPES[0];

export function removeTab(view) {
  const root = h('div.removal-tab');
  const regions = () => view.clip?.removal?.regions || [];
  const sel = () => Math.min(removeEdit.index, Math.max(0, regions().length - 1));
  const isVideo = () => view.clip?.type === 'video';
  let sub = createScope();
  view.bind(() => sub.update());
  view.bind(() => sub.tick(), { time: true });
  const sv = Object.create(view);
  sv.bind = (fn, opts) => sub.bind(fn, opts);

  const setRemoval = (label, key, fn, final = true) => view.edit(label, (c) => {
    c.removal = { ...REMOVAL_DEFAULT, regions: [], ...c.removal };
    return fn(c.removal, c);
  }, { key: `removal-${key}`, final });

  // --- On / off -----------------------------------------------------------------
  const enable = toggle(view, {
    label: 'Remove objects',
    hint: 'Fills the regions from the picture around them on every frame.',
    get: (c) => Boolean(c?.removal?.on),
    set: (on) => {
      setRemoval(on ? 'Turn on object removal' : 'Turn off object removal', 'on', (r) => {
        r.on = on;
      });
      announce(on ? 'Object removal on' : 'Object removal off');
    },
  });

  // --- Tools ----------------------------------------------------------------------
  const tools = segmented({
    label: 'Tool',
    options: REMOVE_TOOLS.map((t) => ({ value: t.id, label: t.label, icon: t.icon })),
    value: removeEdit.tool,
    onChange: (v) => {
      removeEdit.set({ tool: v });
      toolHint.textContent = REMOVE_TOOLS.find((t) => t.id === v).hint;
    },
  });
  const toolHint = h('p.asset-hint.removal-tool-hint', REMOVE_TOOLS.find((t) => t.id === removeEdit.tool).hint);
  const size = sliderField({
    label: 'Brush size',
    min: 1,
    max: 30,
    unit: '%',
    value: Math.round(removeEdit.size * 100),
    onInput: (v) => removeEdit.set({ size: v / 100 }),
  });
  const show = switchField({
    label: 'Show regions',
    hint: 'Tint what is being removed while you edit.',
    checked: removeEdit.show,
    onChange: (v) => removeEdit.set({ show: v }),
  });
  const newBtn = h('button.btn.small', { type: 'button' }, icon('plus', 14), h('span', 'New painted region'));
  newBtn.addEventListener('click', () => {
    let index = -1;
    setRemoval('New removal region', 'add', (r, c) => {
      r.on = true;
      index = addRegion(c, defaultRegion('brush'));
      return index >= 0;
    });
    if (index < 0) return;
    removeEdit.set({ index, tool: removeEdit.tool === 'box' ? 'brush' : removeEdit.tool });
    tools.set(removeEdit.tool);
    announce('New region. Paint on the preview.');
    render(true);
  });
  const toolsBox = h('div.removal-tools',
    h('div.field.insp-row', h('span.field-label', 'Tool'), tools.el), toolHint, size.el, show.el, h('div.insp-tools', newBtn));

  // --- Region list ------------------------------------------------------------------
  const listEl = h('div.mask-list.removal-list', { role: 'list', 'aria-label': 'Regions' });
  const empty = h('p.insp-empty', 'Paint over an object, logo or watermark on the preview, or drag a box around it with the Box tool. It is filled in from the picture around it.');
  const full = note(`A clip can have up to ${MAX_REGIONS} regions.`);

  function rowFor(r, i) {
    const t = typeOf(r.type);
    const selected = i === sel();
    const keyed = REGION_KEYED.some((k) => view.clip?.keyframes?.[regionProp(i, k)]?.length);
    const name = `${i + 1}. ${t.label}${regionHasShape({ ...r, hidden: false }) ? '' : ' (empty)'}`;
    const pick = h('button.mask-row-main', { type: 'button', 'aria-pressed': String(selected), 'aria-label': `Region ${i + 1}, ${t.label}${r.hidden ? ', hidden' : ''}${keyed ? ', follows motion' : ''}` },
      h('span.mask-row-icon', icon(t.icon, 16)), h('span.mask-row-name', name), keyed ? h('span.mask-row-mode', 'Moves') : null);
    pick.addEventListener('click', () => {
      removeEdit.set({ index: i, tool: r.type === 'rectangle' ? 'box' : removeEdit.tool === 'box' ? 'brush' : removeEdit.tool });
      tools.set(removeEdit.tool);
      render(true);
    });
    const btn = (name, label, fn) => {
      const b = h('button.icon-btn.small', { type: 'button', 'aria-label': `${label} region ${i + 1}`, 'data-tip': label }, icon(name, 14));
      b.addEventListener('click', fn);
      return b;
    };
    const eye = btn(r.hidden ? 'eyeOff' : 'eye', r.hidden ? 'Show' : 'Hide', () => {
      view.edit(r.hidden ? 'Show removal region' : 'Hide removal region', (c) => {
        const x = c.removal?.regions?.[i];
        if (!x) return false;
        if (x.hidden) delete x.hidden;
        else x.hidden = true;
      });
    });
    eye.setAttribute('aria-pressed', String(Boolean(r.hidden)));
    const del = btn('trash', 'Delete', () => {
      view.edit('Delete removal region', (c) => removeRegion(c, i));
      removeEdit.set({ index: Math.max(0, i - 1) });
      announce('Region deleted');
      render(true);
    });
    return h(`div.mask-row${selected ? '.selected' : ''}${r.hidden ? '.is-hidden' : ''}`, { role: 'listitem' }, pick, h('div.mask-row-tools', eye, del));
  }

  // --- Selected region: position (keyframes) and follow motion ------------------------
  let tracking = null; // { ac, index }
  const progressBar = h('span');
  const progress = h('div.progress', { hidden: true }, progressBar);
  const trackStatus = h('p.asset-hint', { role: 'status' });

  function buildSettings(i) {
    sub = createScope();
    const r = regions()[i];
    if (!r) return null;
    const keyed = (key, opts) => slider(sv, {
      ...opts,
      prop: regionProp(i, key),
      get: () => opts.toUi(sv.valueOf(regionProp(i, key))),
      set: (v, final) => sv.animate(regionProp(i, key), opts.fromUi(v), { label: 'Move removal region', final }),
    });
    const rows = [
      keyed('x', { label: 'Position X', min: -50, max: 50, hardMin: -100, hardMax: 100, unit: '%', className: 'centered', toUi: (v) => Math.round(v * 1000) / 10, fromUi: (v) => v / 100, step: 0.1 }).el,
      keyed('y', { label: 'Position Y', min: -50, max: 50, hardMin: -100, hardMax: 100, unit: '%', className: 'centered', toUi: (v) => Math.round(-v * 1000) / 10, fromUi: (v) => -v / 100, step: 0.1 }).el,
    ];
    const follow = h('button.btn.small', { type: 'button' }, icon('crosshair', 14), h('span', 'Follow motion'));
    const stop = h('button.btn.small.ghost', { type: 'button', hidden: true }, 'Stop');
    const still = h('button.btn.small.ghost', { type: 'button' }, 'Keep still');
    const syncTrack = () => {
      const busy = Boolean(tracking);
      const hasKeys = REGION_KEYED.some((k) => view.clip?.keyframes?.[regionProp(i, k)]?.length);
      follow.disabled = busy || !isVideo();
      stop.hidden = !busy;
      still.hidden = busy || !hasKeys;
      progress.hidden = !busy;
    };
    follow.addEventListener('click', async () => {
      if (tracking) return;
      const ac = new AbortController();
      tracking = { ac, index: i };
      progressBar.style.width = '0%';
      trackStatus.textContent = 'Following the object...';
      syncTrack();
      try {
        const n = await followRegion(view.ctx, view.id, i, { signal: ac.signal, onProgress: (p) => (progressBar.style.width = `${Math.round(p * 100)}%`) });
        trackStatus.textContent = n ? 'The region now follows the object. Adjust its position at any frame to fix the path.' : '';
        announce('Region follows the object');
      } catch (err) {
        trackStatus.textContent = err?.name === 'AbortError' ? 'Stopped.' : '';
        if (err?.name !== 'AbortError') toast(err?.message || 'Tracking failed.', { kind: 'error' });
      } finally {
        tracking = null;
        if (follow.isConnected) syncTrack();
      }
    });
    stop.addEventListener('click', () => tracking?.ac.abort());
    still.addEventListener('click', () => {
      view.edit('Keep removal region still', (c) => clearRegionKeys(c, i));
      trackStatus.textContent = '';
      announce('Region keeps still');
    });
    sub.bind(syncTrack);
    syncTrack();
    rows.push(
      h('div.insp-tools.removal-follow', follow, stop, still),
      progress,
      trackStatus,
      isVideo() ? note('Follow motion tracks what is under the region from the playhead to both ends of the clip. Or key Position X and Y by hand.') : null,
    );
    return propSection(`Region ${i + 1}: ${typeOf(r.type).label}`, rows.filter(Boolean), { open: true });
  }

  // --- Fill settings --------------------------------------------------------------------
  const feather = slider(view, {
    label: 'Feather', min: 0, max: 100,
    get: (c) => Math.round(c?.removal?.feather ?? REMOVAL_DEFAULT.feather),
    set: (v, final) => setRemoval('Removal feather', 'feather', (r) => {
      r.feather = v;
    }, final),
  });
  const grain = slider(view, {
    label: 'Grain', min: 0, max: 100,
    get: (c) => Math.round(c?.removal?.grain ?? REMOVAL_DEFAULT.grain),
    set: (v, final) => setRemoval('Removal grain', 'grain', (r) => {
      r.grain = v;
    }, final),
  });
  const fillHint = h('p.asset-hint', 'Feather widens the soft edge around each region. Grain adds noise matched to the picture around it, so the fill does not look smeared.');
  const settingsHost = h('div.removal-settings');

  let sig = null;
  function render(force = false) {
    const c = view.clip;
    if (!c) return;
    const list = regions();
    const keys = list.map((_, i) => (REGION_KEYED.some((k) => c.keyframes?.[regionProp(i, k)]?.length) ? 1 : 0));
    const s = `${list.map((r, i) => `${r.id}:${r.hidden ? 1 : 0}:${regionHasShape({ ...r, hidden: false }) ? 1 : 0}:${keys[i]}`).join(',')}|${sel()}|${c.removal?.on ? 1 : 0}`;
    if (!force && s === sig) return;
    sig = s;
    if (removeEdit.index !== sel()) removeEdit.index = sel();
    listEl.replaceChildren(...list.map((r, i) => rowFor(r, i)));
    listEl.hidden = !list.length;
    empty.hidden = list.length > 0;
    full.hidden = list.length < MAX_REGIONS;
    newBtn.disabled = list.length >= MAX_REGIONS;
    const settings = list.length ? buildSettings(sel()) : null;
    settingsHost.replaceChildren(...(settings ? [settings] : []));
    if (!settings) sub = createScope();
  }

  root.append(
    propSection('Remove object', [enable.el, toolsBox, empty, listEl, full], {
      onReset: () => {
        view.edit('Reset object removal', (c) => {
          if (!c.removal) return false;
          clearRegionKeys(c);
          c.removal = { ...REMOVAL_DEFAULT, regions: [] };
        });
        removeEdit.set({ index: 0 });
        announce('Object removal reset');
        render(true);
      },
    }),
    settingsHost,
    propSection('Fill', [feather.el, grain.el, fillHint]),
  );
  render(true);
  view.bind(() => render());
  removeEdit.open(root, view.id);
  // Selecting a region on the preview updates the list.
  const off = removeEdit.on('change', () => (root.isConnected ? render() : off()));
  return root;
}
