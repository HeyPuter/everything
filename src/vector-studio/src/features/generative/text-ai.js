/**
 * Text with Puter AI chat, on selected type (or the selected characters
 * while editing type): Generate Text, Rewrite (tone and length), Proofread,
 * Translate and Fit Text to the frame. Results are previewed where a choice
 * is involved and applied as one undo step, keeping character styles.
 */
import { h, announce } from '../../lib/dom.js';
import { UserError } from '../../lib/errors.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { icon } from '../../ui/icons.js';
import { createText } from '../../model/nodes.js';
import { replaceRange } from '../../model/text-runs.js';
import { layoutText } from '../../model/text-layout.js';
import { session, typeDefaults } from '../type/type-ops.js';
import { selectedTextNodes } from '../type/outlines.js';
import { loremWords } from '../type/lorem.js';
import { withTraceProgress } from '../trace/trace-commands.js';
import { TONES, LENGTHS, TEXT_KINDS, LANGUAGES, generateTextPrompt, rewritePrompt, proofreadPrompt, translatePrompt, fitPrompt, cleanPrompt } from './prompts.js';
import { requireAI, askChat, parseJsonReply, plainReply, isAbort, aiErrorMessage, abortable } from './ai.js';
import { progressBlock, selectField, nextId } from './ui.js';

// ---- targets ----

/**
 * The text the commands work on: [{ id, start, end }]. While editing type,
 * the selected characters (or the whole story when nothing is selected);
 * otherwise each selected type object (the first frame of a threaded story).
 */
export function textTargets(app) {
  const s = session(app);
  if (s) {
    const n = s.node();
    if (!n) return [];
    const [a, b] = s.range();
    return b > a ? [{ id: n.id, start: a, end: b }] : [{ id: n.id, start: 0, end: n.text.length }];
  }
  if (!app.editor) return [];
  return selectedTextNodes(app.editor)
    .filter((n) => !n.threadPrev)
    .map((n) => ({ id: n.id, start: 0, end: n.text.length }));
}

export function targetText(doc, t) {
  const n = doc.get(t.id);
  return n ? n.text.slice(t.start, t.end) : '';
}

/** Replace each target's text (one undo step), keeping the styles around it. */
export function applyTexts(app, targets, texts, label) {
  const doc = app.editor.doc;
  let changed = 0;
  doc.transact(label, () => {
    targets.forEach((t, i) => {
      const n = doc.get(t.id);
      const text = texts[i];
      if (!n || text == null || n.text.slice(t.start, t.end) === text) return;
      doc.update(n.id, replaceRange(n, t.start, Math.min(t.end, n.text.length), text));
      changed++;
    });
  });
  const s = session(app);
  if (s && targets.length === 1 && targets[0].id === s.id && texts[0] != null) s.setSelection(targets[0].start, targets[0].start + texts[0].length);
  return changed;
}

const hasTargets = (app) => textTargets(app).some((t) => t.end > t.start);

// ---- word diff (proofreading preview) ----

/** Word-level difference of two texts: [{ type: 'same' | 'del' | 'ins', text }]. */
export function wordDiff(a, b) {
  const A = String(a).match(/\s+|[^\s]+/g) || [];
  const B = String(b).match(/\s+|[^\s]+/g) || [];
  // Long texts: compare as a whole rather than spend quadratic time.
  if (A.length * B.length > 4_000_000) return a === b ? [{ type: 'same', text: a }] : [{ type: 'del', text: a }, { type: 'ins', text: b }];
  const m = A.length;
  const n = B.length;
  const L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      push('same', A[i]);
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) push('del', A[i++]);
    else push('ins', B[j++]);
  }
  while (i < m) push('del', A[i++]);
  while (j < n) push('ins', B[j++]);
  return out;
}

function diffView(a, b) {
  return h('p.gen-diff', wordDiff(a, b).map((p) => (p.type === 'same' ? p.text : h(p.type === 'del' ? 'del' : 'ins', p.text))));
}

// ---- fitting text to its frame ----

/**
 * How many characters an area type frame holds with its current styles:
 * { length, capacity, overflow }. Overflowing frames report what shows;
 * others are filled with filler words to measure the free room.
 */
export function frameCapacity(node) {
  const len = node.text.length;
  const lay = layoutText(node);
  if (lay.overflow) return { length: len, capacity: lay.visibleEnd, overflow: true };
  const fits = (k) => !layoutText({ ...node, ...replaceRange(node, len, len, ` ${loremWords(k)}`) }).overflow;
  if (!fits(1)) return { length: len, capacity: len, overflow: false };
  let k = 1;
  while (k < 4000 && fits(k * 2)) k *= 2;
  let lo = k;
  let hi = k * 2;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return { length: len, capacity: len + 1 + loremWords(lo).length, overflow: false };
}

/** Ask for text that fits a frame: up to three tries, each aimed shorter when the last overflowed. */
export async function fitTextToFrame(client, node, { signal } = {}) {
  const cap = frameCapacity(node);
  if (!cap.overflow && cap.capacity - cap.length <= Math.max(4, cap.capacity * 0.06)) return { text: node.text, fits: true, unchanged: true };
  let target = Math.max(1, Math.round(cap.capacity * 0.93));
  let best = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = plainReply(await askChat(client, fitPrompt(node.text, target), { signal }));
    if (!text) continue;
    const fits = !layoutText({ ...node, ...replaceRange(node, 0, node.text.length, text) }).overflow;
    if (fits) return { text, fits: true };
    if (!best || text.length < best.length) best = text;
    target = Math.max(1, Math.round(target * Math.min(0.9, target / text.length)));
  }
  if (!best) throw new UserError('No usable text came back. Try again.');
  return { text: best, fits: false };
}

// ---- dialogs and commands ----

function footerButton(footer, label) {
  return [...footer.querySelectorAll('button')].find((b) => b.textContent === label);
}

/** Type > ... > Generate Text: write new text into the selected type or a new text frame. */
export async function generateTextDialog(app) {
  const ed = app.editor;
  if (!ed) return false;
  const targets = textTargets(app);
  const doc = ed.doc;
  let controller = null;
  let footer = null;
  const pid = nextId('gen-tp');
  const prompt = h('textarea.gen-prompt', { id: pid, rows: 3, maxlength: 600, placeholder: 'What should the text say? Like "opening hours for a bakery, Monday to Saturday"' });
  const kind = selectField('Kind', TEXT_KINDS, 'paragraph');
  const tone = selectField('Tone', TONES, 'friendly');
  const go = h('button.btn.primary.gen-go', { type: 'button' }, icon('sparkles', 14), h('span', 'Generate'));
  const progress = progressBlock({ label: 'Writing', onCancel: () => controller?.abort() });
  const status = h('p.gen-status', { role: 'status' });
  const rid = nextId('gen-tr');
  const result = h('textarea.gen-result', { id: rid, rows: 6 });
  const resultRow = h('div.gen-field', { hidden: true }, h('label.gen-label', { for: rid }, 'Result (you can edit it)'), result);
  const where = h('p.gen-target', targets.length ? (session(app) && targets[0].end - targets[0].start < doc.get(targets[0].id).text.length ? 'Replaces the selected characters.' : 'Replaces the text of the selected type.') : 'Adds a new text frame to the artboard.');
  const run = async () => {
    if (controller) return;
    const p = cleanPrompt(prompt.value);
    if (!p) {
      status.textContent = 'Describe the text first.';
      prompt.focus();
      return;
    }
    let client;
    try {
      client = await requireAI(app);
    } catch (err) {
      status.textContent = aiErrorMessage(err);
      return;
    }
    if (!client) return;
    controller = new AbortController();
    go.disabled = true;
    progress.start();
    status.textContent = '';
    try {
      const text = plainReply(await askChat(client, generateTextPrompt({ prompt: p, kind: kind.sel.value, tone: tone.sel.value }), { signal: controller.signal }));
      if (!text) throw new UserError('No text came back. Try again.');
      result.value = text;
      resultRow.hidden = false;
      if (footer) footerButton(footer, 'Insert').disabled = false;
      app.generativeHistory?.add({ kind: 'text', prompt: p, settings: { action: 'generate', kind: kind.sel.value, tone: tone.sel.value }, items: [{ text, action: 'generate' }] });
      announce('Text ready');
    } catch (err) {
      status.textContent = isAbort(err) ? 'Cancelled.' : aiErrorMessage(err);
    } finally {
      controller = null;
      go.disabled = false;
      progress.stop();
    }
  };
  go.addEventListener('click', run);
  const body = h('div.form.gen-text-dialog', h('div.gen-field', h('label.gen-label', { for: pid }, 'Describe the text'), prompt), h('div.gen-row', kind.el, tone.el), where, go, progress.el, status, resultRow);
  let out;
  try {
    out = await openDialog({
      title: 'Generate Text',
      body,
      className: 'gen-dialog',
      initialFocus: () => prompt,
      onOpen: ({ footer: f }) => (footer = f),
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Insert', primary: true, disabled: true, value: () => result.value },
      ],
    });
  } finally {
    controller?.abort();
  }
  if (!out || !out.trim()) return false;
  insertGeneratedText(app, out, kind.sel.value, targets);
  return true;
}

/** Put generated text into the targets, or into a new area text frame on the artboard. */
export function insertGeneratedText(app, text, kind = 'paragraph', targets = textTargets(app)) {
  const ed = app.editor;
  const doc = ed.doc;
  if (targets.length) {
    applyTexts(app, [targets[0]], [text], 'Generate Text');
    return targets[0].id;
  }
  if (!ed.canDrawInTarget()) throw new UserError('The target layer is locked or hidden.');
  const a = ed.artboard() || { x: 0, y: 0, w: 612, h: 792 };
  const d = typeDefaults(app);
  const size = { headline: 36, tagline: 20, cta: 18 }[kind] || d.char.fontSize || 12;
  const width = Math.min(a.w * 0.7, kind === 'paragraph' || kind === 'list' ? 360 : 520);
  const lines = Math.max(1, Math.ceil((text.length * size * 0.55) / width) + (text.match(/\n/g) || []).length);
  const height = Math.min(a.h * 0.8, lines * size * 1.3 + size);
  const node = createText(text, a.x + (a.w - width) / 2, a.y + (a.h - height) / 2, { kind: 'area', width, height, char: { ...d.char, fontSize: size }, para: { ...d.para }, fill: d.fill, stroke: d.stroke, strokeWidth: d.strokeWidth });
  doc.transact('Generate Text', () => doc.insert(node, ed.targetLayer().id));
  ed.select([node.id]);
  return node.id;
}

/** Rewrite the selected text in another tone or length, choosing among alternatives. */
export async function rewriteDialog(app) {
  const targets = textTargets(app).filter((t) => t.end > t.start);
  if (!targets.length) throw new UserError('Select type to rewrite.');
  const t = targets[0];
  const original = targetText(app.editor.doc, t);
  let controller = null;
  let footer = null;
  let options = [];
  let chosen = -1;
  const tone = selectField('Tone', TONES, app.prefs.get('generativeTone') || 'friendly');
  const length = selectField('Length', LENGTHS, 'same');
  const iid = nextId('gen-ri');
  const instruction = h('input', { type: 'text', id: iid, maxlength: 200, placeholder: 'Optional, like "mention free delivery"' });
  const go = h('button.btn.primary.gen-go', { type: 'button' }, icon('sparkles', 14), h('span', 'Rewrite'));
  const progress = progressBlock({ label: 'Rewriting', onCancel: () => controller?.abort() });
  const status = h('p.gen-status', { role: 'status' });
  const list = h('div.gen-options', { role: 'radiogroup', 'aria-label': 'Rewrites' });
  const render = () => {
    list.replaceChildren(
      ...options.map((o, i) =>
        h('button.gen-option', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(i === chosen),
          tabIndex: i === chosen || (chosen < 0 && i === 0) ? 0 : -1,
          onclick: () => pick(i),
          onkeydown: (e) => {
            const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const j = (i + d + options.length) % options.length;
            pick(j);
            list.children[j]?.focus();
          },
        }, o),
      ),
    );
  };
  const pick = (i) => {
    chosen = i;
    render();
    if (footer) footerButton(footer, 'Apply').disabled = false;
  };
  const run = async () => {
    if (controller) return;
    let client;
    try {
      client = await requireAI(app);
    } catch (err) {
      status.textContent = aiErrorMessage(err);
      return;
    }
    if (!client) return;
    app.prefs.set('generativeTone', tone.sel.value);
    controller = new AbortController();
    go.disabled = true;
    progress.start();
    status.textContent = '';
    try {
      const reply = await askChat(client, rewritePrompt(original, { tone: tone.sel.value, length: length.sel.value, instruction: instruction.value, count: 3 }), { signal: controller.signal });
      options = parseJsonReply(reply, 'array').map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 5);
      if (!options.length) throw new UserError('No rewrites came back. Try again.');
      chosen = -1;
      render();
      pick(0);
      app.generativeHistory?.add({ kind: 'text', prompt: original.slice(0, 200), settings: { action: 'rewrite', tone: tone.sel.value, length: length.sel.value }, items: options.map((text) => ({ text, action: 'rewrite' })) });
      status.textContent = `${options.length} rewrites. Choose one and Apply.`;
    } catch (err) {
      status.textContent = isAbort(err) ? 'Cancelled.' : aiErrorMessage(err);
    } finally {
      controller = null;
      go.disabled = false;
      progress.stop();
    }
  };
  go.addEventListener('click', run);
  const excerpt = original.length > 400 ? `${original.slice(0, 399)}…` : original;
  const body = h(
    'div.form.gen-text-dialog',
    h('div.gen-field', h('span.gen-label', 'Original'), h('blockquote.gen-original', excerpt)),
    targets.length > 1 ? h('p.gen-target', 'Rewrites the first selected text object.') : null,
    h('div.gen-row', tone.el, length.el),
    h('div.gen-field', h('label.gen-label', { for: iid }, 'Also'), instruction),
    go,
    progress.el,
    status,
    list,
  );
  let out;
  try {
    out = await openDialog({
      title: 'Rewrite',
      body,
      className: 'gen-dialog',
      onOpen: ({ footer: f }) => (footer = f),
      initialFocus: () => go,
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Apply', primary: true, disabled: true, value: () => options[chosen] ?? null },
      ],
    });
  } finally {
    controller?.abort();
  }
  if (out == null) return false;
  applyTexts(app, [t], [out], 'Rewrite');
  return true;
}

/** Run chat requests over each target with a cancellable progress pill. */
async function eachTarget(app, label, targets, fn) {
  const doc = app.editor.doc;
  return withTraceProgress(app, label, async (onProgress, signal) => {
    onProgress(0.05);
    const out = [];
    for (let i = 0; i < targets.length; i++) {
      out.push(await abortable(fn(targetText(doc, targets[i]), signal, i), signal));
      onProgress((i + 1) / targets.length);
    }
    return out;
  }, { delay: 0 });
}

/** Proofread the selected type: shows the corrections, then applies them. */
export async function proofread(app) {
  const targets = textTargets(app).filter((t) => t.end > t.start);
  if (!targets.length) throw new UserError('Select type to proofread.');
  const client = await requireAI(app);
  if (!client) return false;
  const doc = app.editor.doc;
  const originals = targets.map((t) => targetText(doc, t));
  let results;
  try {
    results = await eachTarget(app, 'Proofreading', targets, async (text, signal) => {
      const r = parseJsonReply(await askChat(client, proofreadPrompt(text), { signal }), 'object');
      return { text: typeof r.text === 'string' && r.text.trim() ? r.text : text, changes: Array.isArray(r.changes) ? r.changes : [] };
    });
  } catch (err) {
    throw new UserError(aiErrorMessage(err));
  }
  if (!results) return false;
  // Keep the original's trailing line break habits: models tend to trim.
  const fixed = results.map((r, i) => (originals[i].endsWith('\n') && !r.text.endsWith('\n') ? `${r.text}\n` : r.text));
  const changed = fixed.map((t, i) => t !== originals[i]);
  if (!changed.some(Boolean)) {
    app.notify('No corrections needed.', { polite: false });
    return false;
  }
  const rows = [];
  results.forEach((r, i) => {
    if (!changed[i]) return;
    const notes = r.changes.filter((c) => c && (c.from || c.to)).slice(0, 12);
    rows.push(
      h('section.gen-proof',
        diffView(originals[i], fixed[i]),
        notes.length ? h('ul.gen-proof-notes', notes.map((c) => h('li', h('span.gen-from', String(c.from ?? '')), ' → ', h('span.gen-to', String(c.to ?? '')), c.why ? h('span.gen-why', ` (${String(c.why).slice(0, 60)})`) : null))) : null,
      ),
    );
  });
  const n = changed.filter(Boolean).length;
  const ok = await openDialog({
    title: 'Proofread',
    className: 'gen-dialog',
    body: h('div.form.gen-text-dialog', h('p.gen-target', n === 1 ? 'Suggested corrections:' : `Suggested corrections in ${n} text objects:`), rows),
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Apply Corrections', primary: true, value: true },
    ],
  });
  if (!ok) return false;
  applyTexts(app, targets, fixed.map((t, i) => (changed[i] ? t : null)), 'Proofread');
  return true;
}

/** Translate the selected type into a language (one undo step). */
export async function translate(app) {
  const targets = textTargets(app).filter((t) => t.end > t.start);
  if (!targets.length) throw new UserError('Select type to translate.');
  const last = app.prefs.get('generativeLanguage');
  const v = await app.dialogs.form({
    title: 'Translate',
    description: targets.length > 1 ? `Translates ${targets.length} text objects. Character styles stay as they are.` : 'Character styles stay as they are.',
    okLabel: 'Translate',
    fields: [{ key: 'language', type: 'select', label: 'Into', value: LANGUAGES.includes(last) ? last : 'Spanish', options: LANGUAGES.map((l) => ({ value: l, label: l })) }],
  });
  if (!v) return false;
  app.prefs.set('generativeLanguage', v.language);
  const client = await requireAI(app);
  if (!client) return false;
  let texts;
  try {
    texts = await eachTarget(app, `Translating into ${v.language}`, targets, async (text, signal) => {
      const out = plainReply(await askChat(client, translatePrompt(text, v.language), { signal }));
      return text.endsWith('\n') && !out.endsWith('\n') ? `${out}\n` : out;
    });
  } catch (err) {
    throw new UserError(aiErrorMessage(err));
  }
  if (!texts) return false;
  applyTexts(app, targets, texts.map((t) => t || null), `Translate into ${v.language}`);
  app.notify(`Translated into ${v.language}.`, { polite: true });
  return true;
}

/** Area type whose text Fit Text can rewrite. */
export function fitTargets(app) {
  const s = session(app);
  const nodes = s ? [s.node()].filter(Boolean) : app.editor ? selectedTextNodes(app.editor) : [];
  return nodes.filter((n) => n.kind === 'area' && !n.threadPrev && !n.threadNext && n.text.trim());
}

/** Rewrite area type so it fills its frame without overflowing. */
export async function fitText(app) {
  const nodes = fitTargets(app);
  if (!nodes.length) throw new UserError('Select area type to fit its text to the frame.');
  const client = await requireAI(app);
  if (!client) return false;
  let results;
  try {
    results = await withTraceProgress(app, 'Fitting text', async (onProgress, signal) => {
      onProgress(0.05);
      const out = [];
      for (let i = 0; i < nodes.length; i++) {
        out.push(await fitTextToFrame(client, nodes[i], { signal }));
        onProgress((i + 1) / nodes.length);
      }
      return out;
    }, { delay: 0 });
  } catch (err) {
    throw new UserError(isAbort(err) ? 'Cancelled.' : aiErrorMessage(err));
  }
  if (!results) return false;
  if (results.every((r) => r.unchanged)) {
    app.notify('The text already fits its frame.');
    return false;
  }
  applyTexts(app, nodes.map((n) => ({ id: n.id, start: 0, end: n.text.length })), results.map((r) => (r.unchanged ? null : r.text)), 'Fit Text');
  if (results.some((r) => !r.fits)) app.notify('The text was shortened but still overflows. Try again or enlarge the frame.');
  return true;
}

export { hasTargets };
