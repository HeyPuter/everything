/**
 * Profile UI shared by the color dialogs: profile selects, loading .icc /
 * .icm files, saving a profile as a file, and the Color Profiles manager
 * (opened from Color Settings and Assign Profile).
 */
import { h } from '../../lib/dom.js';
import { listProfiles, profileEntry, profileBytes, registryEvents } from './profiles.js';
import { parseProfile, CLASS_LABELS } from './parse.js';
import { ICC_MIME } from './store.js';

const SOURCE_LABELS = { builtin: 'Built-in', user: 'Yours', embedded: 'From a document' };

/**
 * A <select> of the profiles of a kind ('RGB' | 'CMYK' | 'Gray'), grouped
 * by where they come from. A value that names no available profile shows
 * as missing. extra: [[value, label]] options placed first.
 */
export function profileSelect(kind, value, { extra = [], outputOnly = false, attrs = {} } = {}) {
  const sel = h('select', attrs);
  const fill = (v) => {
    const groups = new Map();
    for (const e of listProfiles(kind, { outputOnly })) {
      if (!groups.has(e.source)) groups.set(e.source, []);
      groups.get(e.source).push(e);
    }
    const known = new Set([...extra.map(([x]) => x), ...[...groups.values()].flat().map((e) => e.id)]);
    sel.replaceChildren(
      ...extra.map(([x, l]) => h('option', { value: x, selected: x === v }, l)),
      ...[...groups].map(([src, list]) => h('optgroup', { label: SOURCE_LABELS[src] || src }, list.map((e) => h('option', { value: e.id, selected: e.id === v }, e.name)))),
      ...(v && !known.has(v) ? [h('option', { value: v, selected: true }, 'Missing profile')] : []),
    );
    sel.value = v;
  };
  fill(value);
  sel.refill = (v = sel.value) => fill(v);
  return sel;
}

/** Pick .icc/.icm files and add them to the user's profiles. Resolves to the added entries. */
export async function loadProfileFiles(app) {
  const { pickWithInput } = await import('../files/service.js');
  const files = await pickWithInput(`.icc,.icm,${ICC_MIME}`);
  const added = [];
  for (const file of files || []) {
    try {
      added.push(await app.iccProfiles.add(file));
    } catch (err) {
      app.notify(`“${file.name}”: ${err?.message || 'not a usable color profile.'}`, { error: true });
    }
  }
  if (added.length) app.notify(added.length === 1 ? `Added the profile “${added[0].name}”.` : `Added ${added.length} profiles.`, { polite: true });
  return added;
}

/** Save a profile's ICC data as a file. */
export async function saveProfileFile(app, id) {
  const e = profileEntry(id);
  const bytes = profileBytes(id);
  if (!e || !bytes) return;
  const name = `${e.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Profile'}.icc`;
  const { deliverFiles } = await import('../io/deliver.js');
  const msg = await deliverFiles(app, [{ name, blob: new Blob([bytes], { type: ICC_MIME }) }], { dest: 'device' });
  if (msg) app.notify(msg, { polite: true });
}

const fmt = (v) => (v ? v.map((x) => x.toFixed(4)).join(', ') : '—');

/** Facts about a profile for the manager's details. */
export function profileFacts(id) {
  const e = profileEntry(id);
  if (!e) return [];
  const rows = [['Kind', `${e.kind}${e.press ? ' (press model)' : ''}`], ['Source', SOURCE_LABELS[e.source] || e.source]];
  let p = e.parsed;
  if (!p && e.source === 'builtin' && !e.press) {
    try {
      p = parseProfile(e.bytes());
    } catch {
      p = null;
    }
  }
  if (p) {
    rows.push(['Class', CLASS_LABELS[p.deviceClass] || p.deviceClass], ['ICC version', p.version.text], ['Connection space', p.pcs.trim()], ['White point', fmt(p.whitePoint)]);
    const tables = ['A2B0', 'A2B1', 'A2B2', 'B2A0', 'B2A1', 'B2A2'].filter((t) => p.tags.has(t));
    rows.push(['Conversion', tables.length ? `Lookup tables (${tables.join(', ')})` : 'Matrix and curves']);
    if (p.copyright) rows.push(['Copyright', p.copyright]);
    rows.push(['Size', `${Math.max(1, Math.round(p.size / 1024))} KB`]);
  } else if (e.press) rows.push(['Class', 'Output'], ['Conversion', 'Press model (ink, paper and dot gain)']);
  return rows;
}

/** The Color Profiles manager. Resolves when closed. */
export async function profilesDialog(app) {
  let selected = null;
  const list = h('ul.pp-preset-list.icc-list', { role: 'listbox', tabindex: '0', 'aria-label': 'Color profiles' });
  const details = h('dl.pp-summary', { 'aria-live': 'polite' });
  const btn = (label, onclick) => h('button.btn.small', { type: 'button', onclick }, label);
  const items = () => listProfiles().filter((e) => e.kind !== 'Lab');
  const loadBtn = btn('Load…', async () => {
    const added = await loadProfileFiles(app);
    if (added.length) selected = added[added.length - 1].id;
    render();
  });
  const keepBtn = btn('Keep', async () => {
    const e = profileEntry(selected);
    if (!e || e.source !== 'embedded') return;
    try {
      await app.iccProfiles.add(profileBytes(e.id));
    } catch (err) {
      app.notify(err?.message || 'The profile could not be kept.', { error: true });
    }
    render();
  });
  const removeBtn = btn('Remove', async () => {
    const e = profileEntry(selected);
    if (!e || e.source !== 'user') return;
    await app.iccProfiles.remove(e.id);
    selected = items()[0]?.id || null;
    render();
  });
  const saveBtn = btn('Save as File…', () => saveProfileFile(app, selected));
  function render() {
    const all = items();
    if (!all.some((e) => e.id === selected)) selected = all[0]?.id || null;
    list.replaceChildren(...all.map((e, i) => h('li.pp-preset', { role: 'option', id: `icc-opt-${i}`, 'aria-selected': String(e.id === selected), onclick: () => ((selected = e.id), render()) }, h('span', e.name), h('span.pp-badge', `${e.kind} · ${SOURCE_LABELS[e.source]}`))));
    const i = all.findIndex((e) => e.id === selected);
    if (i >= 0) list.setAttribute('aria-activedescendant', `icc-opt-${i}`);
    const e = profileEntry(selected);
    removeBtn.disabled = e?.source !== 'user';
    keepBtn.hidden = e?.source !== 'embedded';
    saveBtn.disabled = !e;
    details.replaceChildren(...profileFacts(selected).flatMap(([k, v]) => [h('dt', k), h('dd', v)]));
  }
  list.addEventListener('keydown', (ev) => {
    const all = items();
    const i = all.findIndex((e) => e.id === selected);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      selected = all[Math.max(0, Math.min(all.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))]?.id ?? selected;
      render();
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      removeBtn.click();
    }
  });
  const off = registryEvents.on('change', render);
  render();
  const where = { cloud: 'your Puter cloud', local: 'this browser', memory: 'this session only' }[app.iccProfiles?.location] || 'this browser';
  try {
    await app.dialogs.open({
      title: 'Color Profiles',
      className: 'pp-dialog pp-presets icc-profiles',
      body: h('div.pp-manager', list, h('div.pp-preset-buttons', loadBtn, keepBtn, removeBtn, h('span.pp-spacer'), saveBtn), h('p.form-help', `Profiles you load are kept in ${where}. Documents carry the profiles assigned to them.`), h('div.pp-label', 'Details'), details),
      initialFocus: () => list,
      buttons: [{ label: 'Done', primary: true, value: true }],
    });
  } finally {
    off();
  }
}
