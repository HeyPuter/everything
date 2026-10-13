/**
 * Generative Recolor: describe a mood, get color palettes from Puter AI
 * chat (JSON), preview each on the selected artwork and apply one through
 * the Recolor Artwork machinery (or open it in Recolor Artwork to refine).
 */
import { h, announce } from '../../lib/dom.js';
import { clamp, hexToRgb, rgbToHex, rgbToHsb, hsbToRgb } from '../../lib/color.js';
import { openDialog } from '../../ui/dialogs/dialog.js';
import { icon } from '../../ui/icons.js';
import { UserError } from '../../lib/errors.js';
import { colorTargets, colorPatches, collectColors, recolorFn } from '../paint/edit-colors.js';
import { recolorDialog } from '../paint/edit-colors-ui.js';
import { clusterColors, hexToLab } from '../panels/color-harmony.js';
import { palettePrompt, normalizePalettes, RECOLOR_IDEAS, cleanPrompt } from './prompts.js';
import { requireAI, askChat, parseJsonReply, isAbort, aiErrorMessage } from './ai.js';
import { progressBlock } from './ui.js';

const hsb = (hex) => rgbToHsb(hexToRgb(hex));
const fromHsb = (h, s, v) => rgbToHex(hsbToRgb({ h, s: clamp(s, 0, 100), v: clamp(v, 0, 100) }));

/**
 * Recolor map from the artwork's colors ([{ color, count }]) onto a palette:
 * the art's colors are grouped into as many clusters as the palette has
 * colors, clusters and palette colors are both ranked by lightness and
 * matched rank for rank (so light stays light and dark stays dark), and
 * each color keeps its brightness offset from its cluster.
 */
export function paletteRecolorMap(colors, palette) {
  if (!colors.length || !palette.length) return {};
  const k = Math.min(palette.length, colors.length);
  const { centers, assign } = clusterColors(colors, k);
  const L = (hex) => hexToLab(hex).l;
  const clusterRank = centers.map((c, i) => ({ i, l: L(c) })).sort((a, b) => a.l - b.l);
  // Use the most dominant palette colors when the art has fewer clusters.
  const targets = palette.slice(0, centers.length).map((c) => ({ c, l: L(c) })).sort((a, b) => a.l - b.l);
  const targetOf = new Map(clusterRank.map((r, rank) => [r.i, targets[rank].c]));
  const out = {};
  for (const { color } of colors) {
    const hex = color.toLowerCase();
    const ci = assign.get(hex);
    const t = targetOf.get(ci);
    if (!t) continue;
    const center = centers[ci];
    const th = hsb(t);
    const dv = hsb(hex).v - hsb(center).v;
    out[hex] = hex === center ? t.toLowerCase() : fromHsb(th.h, th.s, th.v + dv * 0.8);
  }
  return out;
}

/** Palettes for a prompt from the chat model: [{ name, colors }]. */
export async function generatePalettes(client, prompt, { count = 4, colors = 5, current = [], signal } = {}) {
  const reply = await askChat(client, palettePrompt(prompt, { count, colors, current }), { signal });
  const list = normalizePalettes(parseJsonReply(reply, 'array'));
  if (!list.length) throw new UserError('No usable palettes came back. Try another description.');
  return list;
}

function selectionColorNodes(editor) {
  return colorTargets(editor.doc, editor.topSelection());
}

/** Selection colors as [{ color, count }]. */
export function selectionColors(editor) {
  return collectColors(selectionColorNodes(editor));
}

/** Apply a palette to the selection as one undo step. Returns the number of changed objects. */
export function applyPalette(editor, palette, label = 'Generative Recolor') {
  const nodes = selectionColorNodes(editor);
  const map = paletteRecolorMap(collectColors(nodes), palette);
  const patches = colorPatches(nodes, recolorFn(map));
  if (!patches.size) return 0;
  editor.doc.transact(label, () => {
    for (const [id, p] of patches) editor.doc.update(id, p);
  });
  return patches.size;
}

function paletteChips(colors) {
  return h('span.gen-chips', { 'aria-hidden': 'true' }, colors.map((c) => h('span.gen-chip', { style: { background: c } })));
}

/**
 * Edit > Edit Colors > Generative Recolor (also Object > Generative): the
 * dialog. Resolves to true when a palette was applied.
 */
export async function generativeRecolorDialog(app, { prompt: initialPrompt = '', palettes: initialPalettes = null } = {}) {
  const ed = app.editor;
  const doc = ed.doc;
  const nodes = selectionColorNodes(ed);
  const colors = collectColors(nodes);
  if (!colors.length) throw new UserError('Select artwork with colors to recolor.');
  const originals = new Map(nodes.map((n) => [n.id, n]));
  let tx = null;
  let palettes = initialPalettes || [];
  let chosen = -1;
  let controller = null;

  const restore = () => {
    for (const n of originals.values()) doc.update(n.id, { fill: n.fill, stroke: n.stroke, ...(n.type === 'text' ? { runs: n.runs } : {}) });
  };
  const mapFor = (i) => paletteRecolorMap(colors, palettes[i].colors);
  const preview = () => {
    if (chosen < 0) return;
    if (!tx) tx = doc.begin('Generative Recolor');
    restore();
    for (const [id, p] of colorPatches([...originals.values()], recolorFn(mapFor(chosen)))) doc.update(id, p);
  };

  const promptBox = h('textarea.gen-prompt', { rows: 2, maxlength: 600, placeholder: 'Describe a mood, place or theme, like "sunset over a lavender field"', 'aria-label': 'Describe the colors' }, initialPrompt);
  const ideas = h('div.gen-ideas', { role: 'group', 'aria-label': 'Ideas' }, RECOLOR_IDEAS.slice().sort(() => Math.random() - 0.5).slice(0, 4).map((idea) => h('button.gen-idea', { type: 'button', onclick: () => {
    promptBox.value = idea;
    promptBox.focus();
  } }, idea)));
  const countSel = h('select.select', { 'aria-label': 'Colors per palette' }, [3, 4, 5, 6, 7, 8].map((n) => h('option', { value: n, selected: n === clamp(colors.length, 3, 6) }, `${n} colors`)));
  const genBtn = h('button.btn.primary.gen-go', { type: 'button' }, icon('sparkles', 14), h('span', 'Generate'));
  const progress = progressBlock({ label: 'Generating palettes', onCancel: () => controller?.abort() });
  const status = h('p.gen-status', { role: 'status' });
  const list = h('div.gen-palettes', { role: 'radiogroup', 'aria-label': 'Palettes' });
  const current = h('div.gen-current', h('span.gen-current-label', 'Current colors'), paletteChips(colors.slice(0, 16).map((c) => c.color)));

  const renderList = () => {
    list.replaceChildren(
      ...palettes.map((p, i) => {
        const b = h('button.gen-palette', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(i === chosen),
          tabIndex: i === chosen || (chosen < 0 && i === 0) ? 0 : -1,
          'aria-label': `${p.name}: ${p.colors.join(', ')}`,
          onclick: () => choose(i),
          onkeydown: (e) => {
            const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const j = (i + d + palettes.length) % palettes.length;
            choose(j);
            list.children[j]?.focus();
          },
        }, h('span.gen-palette-name', p.name), paletteChips(p.colors));
        return b;
      }),
    );
  };
  const choose = (i) => {
    chosen = i;
    renderList();
    preview();
    announce(`${palettes[i].name} previewed`);
  };

  const run = async () => {
    if (controller) return;
    const text = cleanPrompt(promptBox.value);
    if (!text) {
      status.textContent = 'Describe the colors you want first.';
      promptBox.focus();
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
    genBtn.disabled = true;
    progress.start();
    status.textContent = '';
    try {
      palettes = await generatePalettes(client, text, { count: 4, colors: Number(countSel.value), current: colors.map((c) => c.color), signal: controller.signal });
      chosen = -1;
      renderList();
      choose(0);
      status.textContent = `${palettes.length} palettes. Choose one to preview it on the artwork.`;
      app.generativeHistory?.add({ kind: 'recolor', prompt: text, settings: { colors: Number(countSel.value) }, items: palettes.map((p) => ({ name: p.name, colors: p.colors })) });
    } catch (err) {
      status.textContent = isAbort(err) ? 'Cancelled.' : aiErrorMessage(err);
    } finally {
      controller = null;
      genBtn.disabled = false;
      progress.stop();
    }
  };
  genBtn.addEventListener('click', run);
  promptBox.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      run();
    }
  });

  const body = h(
    'div.form.gen-recolor',
    current,
    h('label.gen-label', 'Prompt'),
    promptBox,
    ideas,
    h('div.gen-row', countSel, genBtn),
    progress.el,
    status,
    list,
  );
  if (palettes.length) {
    renderList();
    queueMicrotask(() => choose(0));
  }

  let result;
  try {
    result = await openDialog({
      title: 'Generative Recolor',
      body,
      className: 'gen-dialog',
      initialFocus: () => promptBox,
      buttons: [
        { label: 'Edit in Recolor Artwork', left: true, value: () => (chosen >= 0 ? { edit: true, map: mapFor(chosen) } : null) },
        { label: 'Cancel', value: null },
        { label: 'Apply', primary: true, value: () => (chosen >= 0 ? { map: mapFor(chosen) } : null) },
      ],
    });
  } finally {
    controller?.abort();
  }
  if (!result || result.edit) {
    tx?.cancel();
    if (result?.edit) return recolorDialog(app, { map: result.map, title: 'Recolor Artwork' });
    return false;
  }
  if (!tx) tx = doc.begin('Generative Recolor');
  restore();
  for (const [id, p] of colorPatches([...originals.values()], recolorFn(result.map))) doc.update(id, p);
  tx.commit();
  return true;
}
