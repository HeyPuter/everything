/**
 * Color management policies (Edit > Color Settings) applied when a
 * document opens: a document whose own profile differs from the working
 * space keeps it, is converted to the working space, or has the profile
 * discarded, by policy or after asking; a document without a profile can
 * be asked about too.
 */
import { h } from '../../lib/dom.js';
import { hexToRgb, rgbToHex } from '../../lib/color.js';
import { colorSettings, convertRgb, separate, RGB_SPACES, CMYK_PROFILES } from './color-management.js';

/** The policy's action for a profile mismatch: 'keep' | 'convert' | 'discard'. */
export function mismatchAction(policy) {
  if (policy === 'convert') return 'convert';
  if (policy === 'off' || policy === 'preserveNumbers') return 'discard';
  return 'keep';
}

/** Rewrite every paint color of the document (fills, strokes, gradient stops, styled type). */
export function mapDocumentColors(doc, fn) {
  const mapPaint = (p) => {
    if (!p) return p;
    if (p.type === 'solid') {
      const next = fn(p);
      return next ? { ...p, ...next } : p;
    }
    if (p.stops) return { ...p, stops: p.stops.map((s) => ({ ...s, ...(fn({ type: 'solid', color: s.color }) || {}) })) };
    return p;
  };
  let n = 0;
  for (const node of doc.nodes.values()) {
    if (node.type !== 'path' && node.type !== 'compound' && node.type !== 'text') continue;
    const patch = {};
    for (const key of ['fill', 'stroke']) if (node[key]) patch[key] = mapPaint(node[key]);
    if (node.type === 'text' && node.runs) patch.runs = node.runs.map((r) => ({ ...r, ...(r.fill ? { fill: mapPaint(r.fill) } : {}), ...(r.stroke ? { stroke: mapPaint(r.stroke) } : {}) }));
    if (Object.keys(patch).every((k) => JSON.stringify(patch[k]) === JSON.stringify(node[k]))) continue;
    doc.update(node.id, patch);
    n++;
  }
  const swatches = doc.root.swatches;
  if (swatches) doc.updateRoot({ swatches: swatches.map((s) => (s.paint ? { ...s, paint: mapPaint(s.paint) } : s)) });
  return n;
}

/** Convert a document from its profile to the working space (one undo step). */
export function convertDocumentProfile(app, doc) {
  const cs = colorSettings(app);
  const from = doc.root.colorProfile;
  const cmyk = doc.root.colorMode === 'CMYK';
  doc.transact('Convert to Working Space', () => {
    if (!cmyk && RGB_SPACES[from]) {
      mapDocumentColors(doc, (p) => {
        const { r, g, b } = hexToRgb(p.color);
        const out = convertRgb([r / 255, g / 255, b / 255], from, cs.rgb);
        return { color: rgbToHex({ r: out[0] * 255, g: out[1] * 255, b: out[2] * 255 }) };
      });
    } else if (cmyk && CMYK_PROFILES[from]) {
      // The colors keep their look; their ink numbers come from the working press.
      mapDocumentColors(doc, (p) => {
        if (!p.cmyk) return null;
        const { r, g, b } = hexToRgb(p.color);
        const c = separate([r / 255, g / 255, b / 255], cs.cmyk);
        return { cmyk: { c: Math.round(c.c), m: Math.round(c.m), y: Math.round(c.y), k: Math.round(c.k) } };
      });
    }
    doc.updateRoot({ colorProfile: undefined });
  });
}

function profileName(id, cmyk) {
  return (cmyk ? CMYK_PROFILES[id] : RGB_SPACES[id])?.label || id;
}

/** Ask what to do with a mismatched or missing profile. Resolves to an action or null. */
function askPolicy(app, { title, message, options, value }) {
  const name = `pp-policy-${Date.now()}`;
  const radios = options.map(([v, label]) => {
    const input = h('input', { type: 'radio', name, value: v, checked: v === value });
    return { input, el: h('label.radio', input, label) };
  });
  return app.dialogs.open({
    title,
    className: 'pp-dialog',
    body: h('div.form', h('p.form-description', message), h('div.pp-radios', { role: 'radiogroup', 'aria-label': title }, radios.map((r) => r.el))),
    buttons: [{ label: 'OK', primary: true, value: () => radios.find((r) => r.input.checked)?.input.value || value }],
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
  if (!own) {
    if (!cs.askMissing || policy === 'off') return null;
    const choice = await askPolicy(app, {
      title: 'Missing Profile',
      message: `“${editor.name || doc.name || 'This document'}” has no ${kind} profile of its own.`,
      options: [['leave', 'Leave as is (use the working space while it is open)'], ['assign', `Assign the working ${kind} profile: ${profileName(working, cmyk)}`]],
      value: 'leave',
    });
    if (choice === 'assign') doc.transact('Assign Profile', () => doc.updateRoot({ colorProfile: working }));
    return choice;
  }
  if (own === 'none' || own === working || !(cmyk ? CMYK_PROFILES[own] : RGB_SPACES[own])) return null;
  let action = mismatchAction(policy);
  if (cs.askOpen) {
    action = await askPolicy(app, {
      title: 'Profile Mismatch',
      message: `“${editor.name || doc.name || 'This document'}” uses ${profileName(own, cmyk)}, which differs from the working ${kind} space (${profileName(working, cmyk)}).`,
      options: [['keep', 'Use the document’s profile'], ['convert', 'Convert the colors to the working space'], ['discard', 'Discard the profile (keep the color numbers)']],
      value: action,
    });
  }
  if (action === 'convert') convertDocumentProfile(app, doc);
  else if (action === 'discard') doc.transact('Discard Profile', () => doc.updateRoot({ colorProfile: undefined }));
  return action;
}
