/**
 * Color management policies (Edit > Color Settings):
 *   on open   a document whose own profile differs from the working space
 *             keeps it, is converted to the working space (ICC transform),
 *             or has the profile discarded, by policy or after asking; a
 *             document without a profile can be asked about too
 *   on paste  artwork copied from a document with other profiles keeps
 *             its appearance (colors converted) or its color numbers, by
 *             policy or after asking
 */
import { h } from '../../lib/dom.js';
import { hexToRgb, rgbToHex } from '../../lib/color.js';
import { colorSettings } from './color-management.js';
import { profileEntry, transformBetween } from '../icc/profiles.js';
import { conversionOptions, usableProfile, profileDisplayName, docRgbProfile, docCmykProfile } from '../icc/cms.js';

/** The policy's action for a profile mismatch: 'keep' | 'convert' | 'discard'. */
export function mismatchAction(policy) {
  if (policy === 'convert') return 'convert';
  if (policy === 'off' || policy === 'preserveNumbers') return 'discard';
  return 'keep';
}

/** A paint with every color mapped by fn(solid paint) -> patch | null. */
function mapPaint(p, fn) {
  if (!p) return p;
  if (p.type === 'solid') {
    const next = fn(p);
    return next ? { ...p, ...next } : p;
  }
  if (p.stops) return { ...p, stops: p.stops.map((s) => ({ ...s, ...(fn({ type: 'solid', color: s.color, ...(s.cmyk ? { cmyk: s.cmyk } : {}) }) || {}) })) };
  return p;
}

/** The changed paint fields of a node, or null. */
function mapNodePaints(node, fn) {
  if (node.type !== 'path' && node.type !== 'compound' && node.type !== 'text') return null;
  const patch = {};
  for (const key of ['fill', 'stroke']) if (node[key]) patch[key] = mapPaint(node[key], fn);
  if (node.type === 'text' && node.runs) patch.runs = node.runs.map((r) => ({ ...r, ...(r.fill ? { fill: mapPaint(r.fill, fn) } : {}), ...(r.stroke ? { stroke: mapPaint(r.stroke, fn) } : {}) }));
  if (Object.keys(patch).every((k) => JSON.stringify(patch[k]) === JSON.stringify(node[k]))) return null;
  return patch;
}

/** Rewrite every paint color of the document (fills, strokes, gradient stops, styled type). */
export function mapDocumentColors(doc, fn) {
  let n = 0;
  for (const node of doc.nodes.values()) {
    const patch = mapNodePaints(node, fn);
    if (!patch) continue;
    doc.update(node.id, patch);
    n++;
  }
  const swatches = doc.root.swatches;
  if (swatches) doc.updateRoot({ swatches: swatches.map((s) => (s.paint ? { ...s, paint: mapPaint(s.paint, fn) } : s)) });
  return n;
}

/** Clipboard items (subtrees) with their paint colors mapped. */
export function mapItemColors(items, fn) {
  return items.map((item) => ({ ...item, nodes: item.nodes.map((n) => {
    const patch = mapNodePaints(n, fn);
    return patch ? { ...n, ...patch } : n;
  }) }));
}

const toHex = (v) => rgbToHex({ r: v[0] * 255, g: v[1] * 255, b: v[2] * 255 });
const hex01 = (hex) => {
  const { r, g, b } = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
};
const pct = (v) => ({ c: Math.round(v[0] * 100), m: Math.round(v[1] * 100), y: Math.round(v[2] * 100), k: Math.round(v[3] * 100) });

/**
 * A paint mapper keeping colors' appearance from profiles `from` to `to`
 * ({ rgb, cmyk } profile ids): RGB numbers through the RGB profiles, CMYK
 * numbers through the CMYK profiles. Null when nothing changes.
 */
export function colorConverter(from, to, opts) {
  const rgb = from.rgb && to.rgb && from.rgb !== to.rgb ? transformBetween(from.rgb, to.rgb, opts) : null;
  const cmyk = from.cmyk && to.cmyk && from.cmyk !== to.cmyk ? transformBetween(from.cmyk, to.cmyk, opts) : null;
  if (!rgb && !cmyk) return null;
  return (p) => {
    if (p.cmyk) {
      if (!cmyk) return null;
      const c = p.cmyk;
      return { cmyk: pct(cmyk.convert([c.c / 100, c.m / 100, c.y / 100, c.k / 100])) };
    }
    return rgb ? { color: toHex(rgb.convert(hex01(p.color))) } : null;
  };
}

const kindOf = (doc) => (doc.root.colorMode === 'CMYK' ? 'CMYK' : 'RGB');

/** Whether a document's own profile is known (registered with the color engine) and of its color mode. */
export function knownProfile(doc) {
  const own = doc.root.colorProfile;
  return Boolean(own && own !== 'none' && profileEntry(own)?.kind === kindOf(doc));
}

/** Convert a document from its profile to the working space (one undo step). */
export function convertDocumentProfile(app, doc) {
  const cs = colorSettings(app);
  const from = doc.root.colorProfile;
  const cmyk = kindOf(doc) === 'CMYK';
  const opts = conversionOptions(app);
  doc.transact('Convert to Working Space', () => {
    if (knownProfile(doc)) {
      // The colors keep their look: RGB numbers or CMYK ink numbers are recomputed for the working space.
      const kind = cmyk ? 'cmyk' : 'rgb';
      const fn = colorConverter({ [kind]: from }, { [kind]: usableProfile(cmyk ? cs.cmyk : cs.rgb, cmyk ? 'CMYK' : 'RGB') }, opts);
      if (fn) mapDocumentColors(doc, fn);
    }
    doc.updateRoot({ colorProfile: undefined });
  });
}

function profileName(id) {
  return profileDisplayName(id) || id;
}

/** Ask what to do with a mismatched or missing profile. Resolves to an action, or null when cancelled (`cancel`). */
export function askPolicy(app, { title, message, options, value, cancel = false }) {
  const name = `pp-policy-${Date.now()}`;
  const radios = options.map(([v, label]) => {
    const input = h('input', { type: 'radio', name, value: v, checked: v === value });
    return { input, el: h('label.radio', input, label) };
  });
  return app.dialogs.open({
    title,
    className: 'pp-dialog',
    body: h('div.form', h('p.form-description', message), h('div.pp-radios', { role: 'radiogroup', 'aria-label': title }, radios.map((r) => r.el))),
    buttons: [...(cancel ? [{ label: 'Cancel', value: null }] : []), { label: 'OK', primary: true, value: () => radios.find((r) => r.input.checked)?.input.value || value }],
  });
}

/** Apply the open policies to a document that was just opened. */
export async function applyOpenPolicy(app, editor) {
  const doc = editor?.doc;
  if (!doc) return null;
  const cs = colorSettings(app);
  const cmyk = doc.root.colorMode === 'CMYK';
  const working = cmyk ? cs.cmyk : cs.rgb;
  const policy = cmyk ? cs.policyCmyk : cs.policyRgb;
  const own = doc.root.colorProfile;
  const kind = cmyk ? 'CMYK' : 'RGB';
  // A profile the document names but does not carry counts as missing.
  if (!own || (own !== 'none' && !knownProfile(doc))) {
    if (!cs.askMissing || policy === 'off') return null;
    const choice = await askPolicy(app, {
      title: 'Missing Profile',
      message: own ? `“${editor.name || doc.name || 'This document'}” names a ${kind} profile that is not available.` : `“${editor.name || doc.name || 'This document'}” has no ${kind} profile of its own.`,
      options: [['leave', 'Leave as is (use the working space while it is open)'], ['assign', `Assign the working ${kind} profile: ${profileName(working)}`]],
      value: 'leave',
    });
    if (choice === 'assign') doc.transact('Assign Profile', () => doc.updateRoot({ colorProfile: working }));
    return choice;
  }
  if (own === 'none' || own === working) return null;
  let action = mismatchAction(policy);
  if (cs.askOpen) {
    action = await askPolicy(app, {
      title: 'Profile Mismatch',
      message: `“${editor.name || doc.name || 'This document'}” uses ${profileName(own)}, which differs from the working ${kind} space (${profileName(working)}).`,
      options: [['keep', 'Use the document’s profile'], ['convert', 'Convert the colors to the working space'], ['discard', 'Discard the profile (keep the color numbers)']],
      value: action,
    });
  }
  if (action === 'convert') convertDocumentProfile(app, doc);
  else if (action === 'discard') doc.transact('Discard Profile', () => doc.updateRoot({ colorProfile: undefined }));
  return action;
}

// ---- paste ----

/** The profiles of a document's color numbers: { rgb, cmyk } profile ids. */
export function documentProfiles(app, doc) {
  return { rgb: docRgbProfile(app, doc), cmyk: docCmykProfile(app, doc) };
}

/** Whether artwork copied with profiles `from` pastes into `doc` with other profiles (for its color mode). */
export function pasteMismatch(app, doc, from) {
  if (!from) return false;
  const to = documentProfiles(app, doc);
  return doc.root.colorMode === 'CMYK' ? from.cmyk !== to.cmyk : from.rgb !== to.rgb;
}

/** The policy's action for pasted artwork: 'convert' (keep the appearance) or 'numbers' (keep the color numbers). */
export function pasteAction(app, doc) {
  const cs = colorSettings(app);
  const policy = doc.root.colorMode === 'CMYK' ? cs.policyCmyk : cs.policyRgb;
  return policy === 'off' || policy === 'preserveNumbers' ? 'numbers' : 'convert';
}

/** Ask how to paste artwork from a document with other profiles. Resolves to 'convert', 'numbers' or null (cancel). */
export function askPaste(app, doc, from) {
  const cmyk = doc.root.colorMode === 'CMYK';
  const src = cmyk ? from.cmyk : from.rgb;
  const dst = documentProfiles(app, doc)[cmyk ? 'cmyk' : 'rgb'];
  return askPolicy(app, {
    title: 'Paste Profile Mismatch',
    message: `The artwork comes from a document using ${profileName(src)}; this document uses ${profileName(dst)}.`,
    options: [['convert', 'Convert the colors (keep their appearance)'], ['numbers', 'Don’t convert (keep the color numbers)']],
    value: pasteAction(app, doc),
    cancel: true,
  });
}
