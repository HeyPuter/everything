/**
 * Edit > Color Settings, Edit > Assign Profile and View > Proof Setup >
 * Customize.
 */
import { h } from '../../lib/dom.js';
import {
  RGB_SPACES, CMYK_PROFILES, POLICIES, INTENTS, COLOR_SETTING_PRESETS, normalizeColorSettings, presetSettings,
  colorSettings, proofCmyk, documentCmykProfile, documentRgbSpace, separate,
} from './color-management.js';
import { proofSettings, DEFAULT_PROOF } from './proof.js';

let uidc = 0;
const fid = (p) => `pp-${p}-${++uidc}`;

export function selectEl(options, value, attrs = {}) {
  return h('select', attrs, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

export function row(label, control, help = null) {
  control.id ||= fid('c');
  return h('div.form-row', h('label', { for: control.id }, label), control, help ? h('p.form-help', help) : null);
}

export function check(label, value, attrs = {}) {
  const input = h('input', { type: 'checkbox', id: fid('cb'), checked: Boolean(value), ...attrs });
  return { input, el: h('div.form-row.check', input, h('label', { for: input.id }, label)) };
}

const SETTINGS_FORMAT = 'vector-studio-color-settings';

/** Hue sweeps on top, the same colors as the press prints them below. */
function gamutStrip(canvas, settings) {
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof ctx.createImageData !== 'function') return;
  const w = canvas.width;
  const hgt = canvas.height;
  const img = ctx.createImageData(w, hgt);
  if (!img?.data) return;
  for (let x = 0; x < w; x++) {
    const hue = (x / w) * 6;
    const f = hue % 1;
    const i = Math.floor(hue);
    const rgb = [[1, f, 0], [1 - f, 1, 0], [0, 1, f], [0, 1 - f, 1], [f, 0, 1], [1, 0, 1 - f]][i] || [1, 0, 0];
    const printed = proofCmyk(rgb, settings.cmyk, { intent: settings.intent, bpc: settings.bpc });
    for (let y = 0; y < hgt; y++) {
      const c = y < hgt / 2 ? rgb : printed;
      const o = (y * w + x) * 4;
      img.data[o] = c[0] * 255;
      img.data[o + 1] = c[1] * 255;
      img.data[o + 2] = c[2] * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

const HELP = {
  preset: 'A named combination of the settings below. Changing any setting makes it Custom.',
  rgb: 'The color space new RGB documents use, and how RGB numbers are interpreted.',
  cmyk: 'The printing condition: paper, inks, dot gain, ink limits and black generation used for CMYK conversion, separations and proofs.',
  policyRgb: 'What to do with RGB documents that carry a different profile when they open.',
  policyCmyk: 'What to do with CMYK documents that carry a different profile when they open.',
  ask: 'Ask before applying the policy, so each document can be handled individually.',
  intent: 'How colors the press cannot print are brought into its range.',
  bpc: 'Map the darkest color of the screen to the richest black of the press, keeping shadow detail.',
};

/** Edit > Color Settings. Resolves to the saved settings or null. */
export async function colorSettingsDialog(app) {
  let st = colorSettings(app);
  const desc = h('p.pp-desc', { role: 'status' }, 'Point at a setting to see what it does.');
  const strip = h('canvas.pp-strip', { width: 360, height: 36, role: 'img', 'aria-label': 'Hues on screen (top) and as the CMYK working space prints them (bottom)' });
  const presetSel = selectEl([...Object.entries(COLOR_SETTING_PRESETS).map(([k, p]) => [k, p.label]), ['custom', 'Custom']], st.preset);
  const rgbSel = selectEl(Object.entries(RGB_SPACES).map(([k, s]) => [k, s.label]), st.rgb);
  const cmykSel = selectEl(Object.entries(CMYK_PROFILES).map(([k, p]) => [k, p.label]), st.cmyk);
  const polRgb = selectEl(['off', 'preserve', 'convert'].map((k) => [k, POLICIES[k]]), st.policyRgb);
  const polCmyk = selectEl(['off', 'preserveNumbers', 'preserve', 'convert'].map((k) => [k, POLICIES[k]]), st.policyCmyk);
  const askOpen = check('Ask when opening', st.askOpen);
  const askPaste = check('Ask when pasting', st.askPaste);
  const askMissing = check('Ask when opening documents without a profile', st.askMissing);
  const intent = selectEl(Object.entries(INTENTS), st.intent);
  const bpc = check('Use black point compensation', st.bpc);
  const read = () => normalizeColorSettings({
    rgb: rgbSel.value, cmyk: cmykSel.value, policyRgb: polRgb.value, policyCmyk: polCmyk.value,
    askOpen: askOpen.input.checked, askPaste: askPaste.input.checked, askMissing: askMissing.input.checked,
    intent: intent.value, bpc: bpc.input.checked,
  });
  const fill = (s) => {
    rgbSel.value = s.rgb;
    cmykSel.value = s.cmyk;
    polRgb.value = s.policyRgb;
    polCmyk.value = s.policyCmyk;
    askOpen.input.checked = s.askOpen;
    askPaste.input.checked = s.askPaste;
    askMissing.input.checked = s.askMissing;
    intent.value = s.intent;
    bpc.input.checked = s.bpc;
  };
  const changed = () => {
    st = read();
    presetSel.value = st.preset;
    gamutStrip(strip, st);
  };
  presetSel.addEventListener('change', () => {
    const p = presetSettings(presetSel.value);
    if (p) fill(p);
    changed();
  });
  const sample = h('p.form-help');
  const updateSample = () => {
    const c = separate([0.5, 0.5, 0.5], cmykSel.value);
    sample.textContent = `50% gray separates as C${Math.round(c.c)} M${Math.round(c.m)} Y${Math.round(c.y)} K${Math.round(c.k)}.`;
  };
  for (const el of [rgbSel, cmykSel, polRgb, polCmyk, askOpen.input, askPaste.input, askMissing.input, intent, bpc.input]) el.addEventListener('change', () => (changed(), updateSample()));
  const describe = (el, key) => {
    const show = () => (desc.textContent = HELP[key]);
    el.addEventListener('focus', show);
    el.addEventListener('pointerenter', show);
  };
  describe(presetSel, 'preset');
  describe(rgbSel, 'rgb');
  describe(cmykSel, 'cmyk');
  describe(polRgb, 'policyRgb');
  describe(polCmyk, 'policyCmyk');
  for (const c of [askOpen, askPaste, askMissing]) describe(c.input, 'ask');
  describe(intent, 'intent');
  describe(bpc.input, 'bpc');

  const load = h('button.btn.small', { type: 'button', onclick: async () => {
    const { pickWithInput } = await import('../files/service.js');
    const [file] = await pickWithInput('.json,application/json');
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== SETTINGS_FORMAT) throw new Error('format');
      fill(normalizeColorSettings(data.settings));
      changed();
      updateSample();
    } catch {
      app.notify('This file does not hold color settings.', { error: true });
    }
  } }, 'Load…');
  const save = h('button.btn.small', { type: 'button', onclick: async () => {
    const blob = new Blob([JSON.stringify({ format: SETTINGS_FORMAT, version: 1, settings: read() }, null, 2)], { type: 'application/json' });
    const { deliverFiles } = await import('../io/deliver.js');
    const msg = await deliverFiles(app, [{ name: 'Color Settings.json', blob }], { dest: 'device' });
    if (msg) app.notify(msg, { polite: true });
  } }, 'Save…');

  const body = h(
    'div.form.pp-color-settings',
    h('div.form-row', h('label', { for: presetSel.id || (presetSel.id = fid('preset')) }, 'Settings'), h('div.pp-inline', presetSel, load, save)),
    h('h3.form-heading', 'Working Spaces'),
    row('RGB', rgbSel),
    row('CMYK', cmykSel),
    h('div.form-row', h('span'), sample),
    h('div.form-row', h('span.form-label', 'Printed hues'), strip),
    h('h3.form-heading', 'Color Management Policies'),
    row('RGB', polRgb),
    row('CMYK', polCmyk),
    h('div.form-row', h('span.form-label', 'Profile mismatches'), h('div.pp-checks', askOpen.el, askPaste.el)),
    h('div.form-row', h('span.form-label', 'Missing profiles'), askMissing.el),
    h('h3.form-heading', 'Conversion Options'),
    row('Intent', intent),
    h('div.form-row', h('span'), bpc.el),
    h('h3.form-heading', 'Description'),
    desc,
  );
  gamutStrip(strip, st);
  updateSample();
  const res = await app.dialogs.open({
    title: 'Color Settings',
    className: 'pp-dialog',
    body,
    initialFocus: () => presetSel,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => read() }],
  });
  if (!res) return null;
  app.prefs.set('colorSettings', res);
  return res;
}

/** Edit > Assign Profile: the document's own profile (undoable). */
export async function assignProfileDialog(app) {
  const ed = app.editor;
  if (!ed) return false;
  const doc = ed.doc;
  const cmyk = doc.root.colorMode === 'CMYK';
  const cs = colorSettings(app);
  const current = doc.root.colorProfile || null;
  const name = `pp-assign-${++uidc}`;
  const radio = (value, label, checked) => {
    const input = h('input', { type: 'radio', name, value, checked, id: fid('r') });
    return { input, el: h('label.radio', { for: input.id }, input, label) };
  };
  const list = cmyk ? Object.entries(CMYK_PROFILES).map(([k, p]) => [k, p.label]) : Object.entries(RGB_SPACES).map(([k, s]) => [k, s.label]);
  const working = cmyk ? CMYK_PROFILES[cs.cmyk].label : RGB_SPACES[cs.rgb].label;
  const none = radio('none', 'Don’t color manage this document', current === 'none');
  const work = radio('working', `Working ${cmyk ? 'CMYK' : 'RGB'}: ${working}`, !current);
  const other = radio('profile', 'Profile:', Boolean(current && current !== 'none'));
  const sel = selectEl(list, current && current !== 'none' ? current : cmyk ? documentCmykProfile(app, doc) : documentRgbSpace(app, doc), { 'aria-label': 'Profile' });
  sel.addEventListener('change', () => (other.input.checked = true));
  const res = await app.dialogs.open({
    title: 'Assign Profile',
    className: 'pp-dialog',
    body: h('div.form', h('p.form-description', `Choose how this ${cmyk ? 'CMYK' : 'RGB'} document’s color numbers are interpreted. The numbers themselves do not change.`), h('div.pp-radios', { role: 'radiogroup', 'aria-label': 'Assign profile' }, none.el, work.el, h('div.pp-inline', other.el, sel))),
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => (none.input.checked ? 'none' : work.input.checked ? 'working' : sel.value) }],
  });
  if (!res) return false;
  const next = res === 'working' ? null : res;
  if ((doc.root.colorProfile || null) === next) return true;
  doc.transact('Assign Profile', () => doc.updateRoot({ colorProfile: next }));
  return true;
}

/** View > Proof Setup > Customize: the device to simulate and how. */
export async function proofCustomizeDialog(app) {
  const p = proofSettings(app);
  const devices = [
    ['cmyk:document', `Document CMYK (${CMYK_PROFILES[documentCmykProfile(app, app.editor?.doc)].label})`],
    ...Object.entries(CMYK_PROFILES).map(([k, v]) => [`cmyk:${k}`, v.label]),
    ...Object.entries(RGB_SPACES).map(([k, v]) => [`rgb:${k}`, v.label]),
  ];
  const device = selectEl(devices, p.device);
  const preserve = check('Preserve RGB numbers', p.preserve);
  const intent = selectEl(Object.entries(INTENTS), p.intent);
  const paper = check('Simulate paper color', p.paper);
  const black = check('Simulate black ink', p.black);
  const sync = () => {
    const rgb = device.value.startsWith('rgb:');
    preserve.input.disabled = !rgb;
    intent.disabled = rgb && preserve.input.checked;
    paper.input.disabled = rgb;
    black.input.disabled = rgb || paper.input.checked;
    if (paper.input.checked) black.input.checked = true;
  };
  for (const el of [device, preserve.input, paper.input]) el.addEventListener('change', sync);
  sync();
  const res = await app.dialogs.open({
    title: 'Customize Proof Condition',
    className: 'pp-dialog',
    body: h('div.form', row('Device to simulate', device), h('div.form-row', h('span'), preserve.el), row('Rendering intent', intent), h('h3.form-heading', 'Display Options (On-Screen)'), paper.el, black.el),
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => ({ ...DEFAULT_PROOF, device: device.value, preserve: preserve.input.checked, intent: intent.value, paper: paper.input.checked, black: black.input.checked }) }],
  });
  if (!res) return null;
  app.prefs.set('proofCustom', res);
  return res;
}
