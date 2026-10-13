// Image > Variables > Define…, Data Sets…, Apply Data Set… and
// File > Import > Variable Data Sets….

import type { Editor } from '../../editor';
import { escapeXML } from '../../model/assets';
import { allLayers, findLayer, type Layer, type PhotoDocument, type Rect } from '../../model/document';
import { gridDocBounds } from '../../model/tiles';
import {
  captureDataSet,
  dataSetsFromText,
  nextSetName,
  validVariableName,
  variableKindsFor,
  variablesOf,
  type DataSet,
  type DocumentVariables,
  type LayerVariables,
  type PixelMethod,
  type PixelVariable,
  type VariableInfo,
} from '../../model/variables';
import { information } from '../../ui/dialog';
import { pickLocalFiles } from '../embedded/convert';
import { chooseImageFolder, documentWithSet, imageFolderLabel, imageNames, reportMissing, setImageFiles } from './apply';

const esc = (s: string) => escapeXML(s);

// A dialog with free-form content whose buttons the caller handles (the
// shared modal resolves once; these stay open to report errors).
function openDialog(className: string, title: string, body: string, actions: string): HTMLDialogElement {
  const dialog = document.createElement('dialog');
  dialog.className = `files-dialog var-dialog ${className}`;
  dialog.setAttribute('aria-label', title);
  dialog.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${body}<p class="var-error" role="alert"></p><div class="dialog-actions">${actions}</div></form>`;
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
  return dialog;
}
const showError = (dialog: HTMLDialogElement, msg: string) => {
  dialog.querySelector('.var-error')!.textContent = msg;
};

// ------------------------------------------------------------ define

const METHODS: [PixelMethod, string][] = [['fit', 'Fit'], ['fill', 'Fill'], ['as-is', 'As Is'], ['conform', 'Conform']];
const ALIGN: [0 | 0.5 | 1, 0 | 0.5 | 1, string][] = [];
for (const y of [0, 0.5, 1] as const) for (const x of [0, 0.5, 1] as const) ALIGN.push([x, y, `${['Top', 'Middle', 'Bottom'][y * 2]} ${['left', 'center', 'right'][x * 2]}`]);

// Document bounds of a layer's content (where replacement images go).
function layerBounds(doc: PhotoDocument, l: Layer): Rect {
  const b = l.kind === 'pixel' && l.pixels ? gridDocBounds(l.pixels) : l.transform;
  return b && b.width > 0 && b.height > 0 ? { x: b.x, y: b.y, width: b.width, height: b.height } : { x: 0, y: 0, width: doc.width, height: doc.height };
}

// Unique default names from a layer name: "Big Sale Banner" + "Image" ->
// "bigSaleBannerImage", then "bigSaleBannerImage2", ...
function freshName(base: string, used: Set<string>, suffix = '') {
  const words = base.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 3);
  const camel = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
  let stem = (camel.replace(/^[^\p{L}_]+/u, '') || 'layer').slice(0, 40) + suffix;
  if (!validVariableName(stem)) stem = `variable${suffix}`;
  let name = stem;
  for (let i = 2; used.has(name); i++) name = `${stem}${i}`;
  return name;
}

export async function defineVariables(e: Editor) {
  const doc = e.doc;
  const layers = allLayers(doc.layers).slice().reverse(); // top first, as in the Layers panel
  if (!layers.length) return;
  // Definitions of deleted (merged, flattened) layers are left out: their
  // names are free again.
  const ids = new Set(layers.map((l) => l.id));
  const draft: Record<string, LayerVariables> = structuredClone(Object.fromEntries(Object.entries(doc.variables?.layers ?? {}).filter(([id]) => ids.has(id))));
  let current = (e.selected && findLayer(doc.layers, e.selected)) ? e.selected : layers[0].id;
  const depth = (id: string) => {
    let d = 0;
    const walk = (ls: Layer[], k: number): boolean => ls.some((l) => (l.id === id ? ((d = k), true) : walk(l.children, k + 1)));
    walk(doc.layers, 0);
    return d;
  };
  const options = () =>
    layers.map((l) => `<option value="${escapeXML(l.id)}" ${l.id === current ? 'selected' : ''}>${'  '.repeat(depth(l.id))}${esc(l.name)}${draft[l.id] && Object.keys(draft[l.id]).length ? ' •' : ''}</option>`).join('');
  const body = `<div class="var-layer-row"><button type="button" class="icon-button" data-step="-1" aria-label="Previous layer" title="Previous layer">‹</button><label class="dialog-field">Layer<select name="layer" autofocus>${options()}</select></label><button type="button" class="icon-button" data-step="1" aria-label="Next layer" title="Next layer">›</button></div>
<div class="var-kinds"></div>`;
  const dialog = openDialog('var-define', 'Define Variables', body, '<button type="button" data-act="cancel">Cancel</button><button type="submit" class="primary">OK</button>');
  const form = dialog.querySelector('form')!;
  const kindsEl = dialog.querySelector<HTMLElement>('.var-kinds')!;
  const used = () => {
    const s = new Set<string>();
    for (const [id, lv] of Object.entries(draft)) if (id !== current) for (const n of [lv.visibility, lv.text, lv.pixel?.name]) if (n) s.add(n);
    return s;
  };

  const render = () => {
    const l = layers.find((x) => x.id === current)!;
    const lv = draft[current] ?? {};
    const kinds = variableKindsFor(l);
    const u = used();
    const base = l.name;
    const px: PixelVariable = lv.pixel ?? { name: freshName(base, u, 'Image'), method: 'fit', alignX: 0.5, alignY: 0.5, clip: true, bounds: layerBounds(doc, l) };
    const visibility = `<fieldset class="var-kind"><legend><label class="checkbox-field"><input type="checkbox" name="vis-on" ${lv.visibility ? 'checked' : ''}> Visibility</label></legend>
  <label class="dialog-field">Name<input type="text" name="vis-name" value="${esc(lv.visibility ?? freshName(base, u, 'Visible'))}" spellcheck="false"></label>
  <p>Shows or hides the layer (values: true or false).</p></fieldset>`;
    const text = `<fieldset class="var-kind"><legend><label class="checkbox-field"><input type="checkbox" name="text-on" ${lv.text ? 'checked' : ''}> Text Replacement</label></legend>
  <label class="dialog-field">Name<input type="text" name="text-name" value="${esc(lv.text ?? freshName(base, u))}" spellcheck="false"></label>
  <p>Replaces the text, keeping its formatting.</p></fieldset>`;
    const pixel = `<fieldset class="var-kind"><legend><label class="checkbox-field"><input type="checkbox" name="px-on" ${lv.pixel ? 'checked' : ''}> Pixel Replacement</label></legend>
  <label class="dialog-field">Name<input type="text" name="px-name" value="${esc(px.name)}" spellcheck="false"></label>
  <div class="var-pixel-row">
    <label class="dialog-field">Method<select name="px-method">${METHODS.map(([v, t]) => `<option value="${v}" ${v === px.method ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <fieldset class="var-align" aria-label="Alignment"><legend>Alignment</legend><div class="var-align-grid">${ALIGN.map(([x, y, t]) => `<label title="${t}"><input type="radio" name="px-align" value="${x},${y}" aria-label="${t}" ${x === px.alignX && y === px.alignY ? 'checked' : ''}><span></span></label>`).join('')}</div></fieldset>
  </div>
  <label class="checkbox-field"><input type="checkbox" name="px-clip" ${px.clip ? 'checked' : ''}> Clip to the layer's bounds</label>
  <p>Replaces the pixels with an image file, placed in ${Math.round(px.bounds.width)} × ${Math.round(px.bounds.height)} px at ${Math.round(px.bounds.x)}, ${Math.round(px.bounds.y)}.</p></fieldset>`;
    // Only what this kind of layer can take.
    kindsEl.innerHTML = [visibility, kinds.includes('text') ? text : '', kinds.includes('pixel') ? pixel : '', kinds.length === 1 ? '<p class="var-note">Text layers can also take text replacement; pixel layers and embedded objects take pixel replacement.</p>' : ''].join('');
    sync();
  };
  const sync = () => {
    for (const fs of kindsEl.querySelectorAll<HTMLFieldSetElement>('.var-kind')) {
      const on = fs.querySelector<HTMLInputElement>('legend input')!.checked;
      for (const el of fs.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input:not(legend input), select')) el.disabled = !on;
    }
  };
  // Saves the form into the draft for the current layer.
  const save = () => {
    const l = layers.find((x) => x.id === current)!;
    const v = (n: string) => (form.elements.namedItem(n) as HTMLInputElement | null);
    const lv: LayerVariables = {};
    if (v('vis-on')?.checked) lv.visibility = v('vis-name')!.value.trim();
    if (v('text-on')?.checked && l.kind === 'text') lv.text = v('text-name')!.value.trim();
    if (v('px-on')?.checked && (l.kind === 'pixel' || l.kind === 'image')) {
      const [ax, ay] = (form.querySelector<HTMLInputElement>('[name=px-align]:checked')?.value ?? '0.5,0.5').split(',').map(Number) as [0 | 0.5 | 1, 0 | 0.5 | 1];
      lv.pixel = {
        name: v('px-name')!.value.trim(),
        method: (form.elements.namedItem('px-method') as HTMLSelectElement).value as PixelMethod,
        alignX: ax,
        alignY: ay,
        clip: !!v('px-clip')?.checked,
        bounds: draft[current]?.pixel?.bounds ?? layerBounds(doc, l),
      };
    }
    if (Object.keys(lv).length) draft[current] = lv;
    else delete draft[current];
  };
  const go = (id: string) => {
    save();
    current = id;
    (form.elements.namedItem('layer') as HTMLSelectElement).innerHTML = options();
    render();
  };
  form.addEventListener('change', (ev) => {
    const t = ev.target as HTMLElement;
    if ((t as HTMLSelectElement).name === 'layer') go((t as HTMLSelectElement).value);
    else sync();
  });
  for (const b of dialog.querySelectorAll<HTMLButtonElement>('[data-step]'))
    b.addEventListener('click', () => {
      const i = layers.findIndex((l) => l.id === current);
      go(layers[(i + Number(b.dataset.step) + layers.length) % layers.length].id);
    });
  dialog.querySelector('[data-act=cancel]')!.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    save();
    const err = checkNames(draft);
    if (err) return showError(dialog, err);
    dialog.close();
    commitDefinitions(e, draft);
  });
  render();
}

// Every name valid and used once across the document.
function checkNames(draft: Record<string, LayerVariables>): string | undefined {
  const seen = new Set<string>();
  for (const lv of Object.values(draft))
    for (const n of [lv.visibility, lv.text, lv.pixel?.name]) {
      if (n === undefined) continue;
      if (!validVariableName(n)) return `"${n}" is not a valid name: start with a letter or underscore, then letters, digits, _ . or - (up to 64).`;
      if (seen.has(n)) return `The name "${n}" is used more than once.`;
      seen.add(n);
    }
}

function commitDefinitions(e: Editor, draft: Record<string, LayerVariables>) {
  const before = e.doc.variables;
  // Definitions of layers deleted since are dropped.
  const ids = new Set(allLayers(e.doc.layers).map((l) => l.id));
  const layers = Object.fromEntries(Object.entries(draft).filter(([id]) => ids.has(id)));
  // Renamed variables carry their values in the data sets; removed ones drop them.
  const renames = new Map<string, string>();
  const old = before?.layers ?? {};
  for (const [id, lv] of Object.entries(old)) {
    const nv = layers[id] ?? {};
    if (lv.visibility && nv.visibility) renames.set(lv.visibility, nv.visibility);
    if (lv.text && nv.text) renames.set(lv.text, nv.text);
    if (lv.pixel && nv.pixel) renames.set(lv.pixel.name, nv.pixel.name);
  }
  const names = new Set(Object.values(layers).flatMap((lv) => [lv.visibility, lv.text, lv.pixel?.name].filter((n): n is string => !!n)));
  const sets = (before?.sets ?? []).map((s) => {
    const values: DataSet['values'] = {};
    for (const [k, v] of Object.entries(s.values)) {
      const n = renames.get(k) ?? k;
      if (names.has(n)) values[n] = v;
    }
    return { name: s.name, values };
  });
  const empty = !Object.keys(layers).length && !sets.length;
  e.command('Define Variables', (d) => {
    if (empty) delete d.variables;
    else d.variables = { layers: structuredClone(layers), sets, ...(before?.current !== undefined && before.current < sets.length ? { current: before.current } : {}) };
  });
  e.update();
}

// ------------------------------------------------------------ data sets

const kindLabel = { visibility: 'Visibility', text: 'Text', pixel: 'Image' } as const;

function cellHtml(info: VariableInfo, v: DataSet['values'][string] | undefined, row: number) {
  const id = `ds-${row}-${info.name}`;
  if (info.kind === 'visibility') return `<input type="checkbox" data-var="${esc(info.name)}" id="${id}" aria-label="${esc(info.name)}" ${v !== false ? 'checked' : ''}>`;
  if (info.kind === 'text') return `<textarea rows="1" data-var="${esc(info.name)}" id="${id}" aria-label="${esc(info.name)}" spellcheck="false">${esc(String(v ?? ''))}</textarea>`;
  return `<input type="text" list="ds-images" data-var="${esc(info.name)}" id="${id}" aria-label="${esc(info.name)}" value="${esc(String(v ?? ''))}" placeholder="file name" spellcheck="false">`;
}

export async function dataSetsDialog(e: Editor) {
  const vars = variablesOf(e.doc);
  if (!vars.length) {
    information('Data Sets', '<p>Define variables first: choose Image › Variables › Define… and bind layers to variables. Data sets then give each variable a value.</p>');
    return;
  }
  const base = e.doc;
  const v0 = base.variables!;
  let sets: DataSet[] = structuredClone(v0.sets);
  if (!sets.length) sets.push(captureDataSet(base, nextSetName(sets)));
  let current = Math.min(v0.current ?? 0, sets.length - 1);
  const hasPixel = vars.some((v) => v.kind === 'pixel');
  const body = `<div class="ds-toolbar">
  <button type="button" data-act="new" title="Add a data set with the document's current values">New</button>
  <button type="button" data-act="dup">Duplicate</button>
  <button type="button" data-act="delete">Delete</button>
  <span class="ds-spacer"></span>
  <button type="button" data-act="import" title="Read data sets from a CSV or tab-separated file whose first row names the variables">Import…</button>
  ${hasPixel ? '<button type="button" data-act="folder" title="Choose the folder that contains the replacement images">Image Folder…</button>' : ''}
</div>
<div class="ds-table-wrap" tabindex="-1"><table class="ds-table"><thead><tr><th scope="col">Data Set</th>${vars.map((v) => `<th scope="col">${esc(v.name)}<small>${kindLabel[v.kind]}</small></th>`).join('')}</tr></thead><tbody></tbody></table></div>
<datalist id="ds-images"></datalist>
<div class="ds-footer"><label class="checkbox-field"><input type="checkbox" name="preview" checked> Preview the selected data set</label><span class="ds-folder muted"></span></div>`;
  const dialog = openDialog('ds-dialog', 'Data Sets', body, '<button type="button" data-act="cancel">Cancel</button><button type="submit" class="primary">OK</button>');
  const form = dialog.querySelector('form')!;
  const tbody = dialog.querySelector('tbody')!;
  const preview = () => (form.elements.namedItem('preview') as HTMLInputElement).checked;

  const renderRows = () => {
    tbody.innerHTML = sets
      .map((s, i) => `<tr data-row="${i}" class="${i === current ? 'selected' : ''}" aria-selected="${i === current}"><th scope="row"><input type="text" data-name aria-label="Data set name" value="${esc(s.name)}"></th>${vars.map((v) => `<td>${cellHtml(v, s.values[v.name], i)}</td>`).join('')}</tr>`)
      .join('');
    dialog.querySelector('[data-act=delete]')!.toggleAttribute('disabled', sets.length <= 1);
  };
  const renderFolder = () => {
    const label = imageFolderLabel();
    const el = dialog.querySelector('.ds-folder')!;
    el.textContent = hasPixel ? (label ? `Images: ${label}` : 'No image folder chosen') : '';
    dialog.querySelector('#ds-images')!.innerHTML = imageNames().map((n) => `<option value="${esc(n)}"></option>`).join('');
  };
  let token = 0;
  const showPreview = async () => {
    const t = ++token;
    if (!preview()) {
      e.preview(base);
      return;
    }
    const r = await documentWithSet(e, base, sets[current]);
    if (t !== token || !dialog.open) return;
    e.preview(r.doc);
    showError(dialog, r.missing.length ? (imageFolderLabel() ? `Not in the image folder: ${[...new Set(r.missing)].join(', ')}` : 'Choose the image folder to preview pixel replacement.') : '');
  };
  const select = (i: number) => {
    if (i === current) return;
    current = i;
    for (const tr of tbody.querySelectorAll<HTMLElement>('tr')) {
      const on = Number(tr.dataset.row) === i;
      tr.classList.toggle('selected', on);
      tr.setAttribute('aria-selected', String(on));
    }
    void showPreview();
  };
  tbody.addEventListener('focusin', (ev) => {
    const tr = (ev.target as HTMLElement).closest<HTMLElement>('tr');
    if (tr) select(Number(tr.dataset.row));
  });
  tbody.addEventListener('click', (ev) => {
    const tr = (ev.target as HTMLElement).closest<HTMLElement>('tr');
    if (tr) select(Number(tr.dataset.row));
  });
  // Edits write straight into the working sets.
  tbody.addEventListener('input', (ev) => {
    const el = ev.target as HTMLInputElement;
    const row = Number(el.closest<HTMLElement>('tr')!.dataset.row);
    if (el.dataset.name !== undefined) sets[row].name = el.value;
    else if (el.dataset.var) sets[row].values[el.dataset.var] = el.type === 'checkbox' ? el.checked : el.value;
    if (row === current) void showPreview();
  });
  tbody.addEventListener('keydown', (ev) => {
    // Up and down move between data sets from any cell.
    if ((ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') || (ev.target as HTMLElement).tagName === 'TEXTAREA') return;
    const el = ev.target as HTMLElement;
    const td = el.closest('td,th')!;
    const col = [...td.parentElement!.children].indexOf(td);
    const row = current + (ev.key === 'ArrowDown' ? 1 : -1);
    const next = tbody.querySelector<HTMLElement>(`tr[data-row="${row}"]`)?.children[col]?.querySelector<HTMLElement>('input,textarea');
    if (next) {
      ev.preventDefault();
      next.focus();
    }
  });
  const act = (name: string, fn: () => void | Promise<void>) => dialog.querySelector(`[data-act=${name}]`)?.addEventListener('click', () => void fn());
  act('new', () => {
    sets.push(captureDataSet(base, nextSetName(sets), sets[current]));
    current = sets.length - 1;
    renderRows();
    void showPreview();
  });
  act('dup', () => {
    const copy = structuredClone(sets[current]);
    copy.name = `${copy.name} copy`;
    sets.splice(current + 1, 0, copy);
    current++;
    renderRows();
    void showPreview();
  });
  act('delete', () => {
    if (sets.length <= 1) return;
    sets.splice(current, 1);
    current = Math.min(current, sets.length - 1);
    renderRows();
    void showPreview();
  });
  act('import', async () => {
    const r = await readDataSetFile(vars, sets.length);
    if (!r) return;
    if (r.errors.length) return showError(dialog, r.errors.join(' '));
    sets = [...sets, ...r.sets];
    current = sets.length - r.sets.length;
    renderRows();
    void showPreview();
  });
  act('folder', async () => {
    const files = await chooseImageFolder();
    if (!files.length) return;
    setImageFiles(files);
    renderFolder();
    void showPreview();
  });
  form.querySelector('[name=preview]')!.addEventListener('change', () => void showPreview());
  act('cancel', () => {
    token++;
    e.preview(base);
    dialog.close();
  });
  dialog.addEventListener('cancel', () => {
    token++;
    e.preview(base);
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (sets.some((s) => !s.name.trim())) return showError(dialog, 'Every data set needs a name.');
    token++;
    const applied = preview() ? await documentWithSet(e, base, sets[current]) : undefined;
    dialog.close();
    e.preview(base);
    if (e.doc !== base) return;
    const out = sets.map((s) => ({ name: s.name.trim(), values: s.values }));
    e.command('Edit Data Sets', (d) => {
      d.variables = { ...(d.variables as DocumentVariables), sets: out, current };
      if (applied) {
        d.layers = structuredClone(applied.doc.layers);
        if (applied.doc.embeds) d.embeds = structuredClone(applied.doc.embeds);
      }
    });
    e.update();
    if (applied) reportMissing(e, applied);
  });
  renderRows();
  renderFolder();
  void showPreview();
}

// ------------------------------------------------------------ apply

export async function applyDataSetDialog(e: Editor) {
  const v = e.doc.variables;
  if (!v?.sets.length) return;
  const base = e.doc;
  let current = Math.min(v.current ?? 0, v.sets.length - 1);
  const hasPixel = variablesOf(base).some((x) => x.kind === 'pixel');
  const body = `<label class="dialog-field">Data set<select name="set" size="${Math.min(8, Math.max(3, v.sets.length))}">${v.sets.map((s, i) => `<option value="${i}" ${i === current ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
<div class="ds-footer"><label class="checkbox-field"><input type="checkbox" name="preview" checked> Preview</label>${hasPixel ? '<button type="button" data-act="folder">Image Folder…</button>' : ''}<span class="ds-folder muted"></span></div>`;
  const dialog = openDialog('ds-apply', 'Apply Data Set', body, '<button type="button" data-act="cancel">Cancel</button><button type="submit" class="primary">Apply</button>');
  const form = dialog.querySelector('form')!;
  const folder = () => (dialog.querySelector('.ds-folder')!.textContent = hasPixel ? imageFolderLabel() || 'No image folder chosen' : '');
  let token = 0;
  const show = async () => {
    const t = ++token;
    if (!(form.elements.namedItem('preview') as HTMLInputElement).checked) return e.preview(base);
    const r = await documentWithSet(e, base, v.sets[current]);
    if (t === token && dialog.open) e.preview(r.doc);
  };
  form.querySelector('[name=set]')!.addEventListener('change', (ev) => {
    current = Number((ev.target as HTMLSelectElement).value);
    void show();
  });
  form.querySelector('[name=preview]')!.addEventListener('change', () => void show());
  dialog.querySelector('[data-act=folder]')?.addEventListener('click', async () => {
    const files = await chooseImageFolder();
    if (files.length) setImageFiles(files);
    folder();
    void show();
  });
  const cancel = () => {
    token++;
    e.preview(base);
  };
  dialog.querySelector('[data-act=cancel]')!.addEventListener('click', () => {
    cancel();
    dialog.close();
  });
  dialog.addEventListener('cancel', cancel);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    token++;
    dialog.close();
    e.preview(base);
    const { applySet } = await import('./apply');
    await applySet(e, current);
    e.update();
  });
  folder();
  void show();
}

// ------------------------------------------------------------ import

async function readDataSetFile(vars: VariableInfo[], start: number) {
  const [file] = await pickLocalFiles('.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain');
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return { sets: [], errors: ['The file is larger than 20 MB.'], name: file.name };
  return { ...dataSetsFromText(await file.text(), vars, start), name: file.name };
}

/** File > Import > Variable Data Sets…: sets from a CSV or tab-separated file. */
export async function importDataSets(e: Editor, file?: File) {
  const vars = variablesOf(e.doc);
  if (!vars.length) {
    information('Import Data Sets', '<p>This document has no variables yet. Choose Image › Variables › Define… to bind layers to variables named like the columns of your file, then import again.</p>');
    return;
  }
  const existing = e.doc.variables?.sets ?? [];
  const r = file ? { ...dataSetsFromText(await file.text(), vars, existing.length), name: file.name } : await readDataSetFile(vars, existing.length);
  if (!r) return;
  if (r.errors.length || !r.sets.length) {
    information('Import Data Sets', `<p>${esc(r.name)} could not be imported.</p><ul class="ds-errors">${(r.errors.length ? r.errors : ['The file has no data rows.']).slice(0, 12).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);
    return;
  }
  const hasPixel = vars.some((v) => v.kind === 'pixel' && r.sets.some((s) => String(s.values[v.name] ?? '').trim()));
  const cols = [...new Set(r.sets.flatMap((s) => Object.keys(s.values)))];
  const body = `<p>${r.sets.length} data set${r.sets.length === 1 ? '' : 's'} with ${cols.map((c) => `<b>${esc(c)}</b>`).join(', ')} from ${esc(r.name)}.</p>
${existing.length ? `<fieldset class="var-kind"><legend>Existing data sets (${existing.length})</legend><label class="checkbox-field"><input type="radio" name="mode" value="replace" checked> Replace them</label><label class="checkbox-field"><input type="radio" name="mode" value="append"> Add after them</label></fieldset>` : ''}
<label class="checkbox-field"><input type="checkbox" name="apply" checked> Apply the first imported data set</label>
${hasPixel ? `<div class="ds-footer"><button type="button" data-act="folder">Image Folder…</button><span class="ds-folder muted">${esc(imageFolderLabel() || 'Choose the folder with the images the file names')}</span></div>` : ''}`;
  const dialog = openDialog('ds-import', 'Import Data Sets', body, '<button type="button" data-act="cancel">Cancel</button><button type="submit" class="primary">Import</button>');
  const form = dialog.querySelector('form')!;
  dialog.querySelector('[data-act=cancel]')!.addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-act=folder]')?.addEventListener('click', async () => {
    const files = await chooseImageFolder();
    if (files.length) setImageFiles(files);
    dialog.querySelector('.ds-folder')!.textContent = imageFolderLabel() || 'Choose the folder with the images the file names';
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const replace = (form.querySelector<HTMLInputElement>('[name=mode]:checked')?.value ?? 'replace') === 'replace';
    const apply = (form.elements.namedItem('apply') as HTMLInputElement).checked;
    dialog.close();
    const sets = replace ? r.sets.map((s, i) => ({ ...s, name: `Data Set ${i + 1}` })) : [...existing, ...r.sets];
    const first = replace ? 0 : existing.length;
    const base = e.doc;
    const applied = apply ? await documentWithSet(e, base, sets[first]) : undefined;
    if (e.doc !== base) return;
    e.command('Import Data Sets', (d) => {
      d.variables = { ...(d.variables as DocumentVariables), sets, current: first };
      if (applied) {
        d.layers = structuredClone(applied.doc.layers);
        if (applied.doc.embeds) d.embeds = structuredClone(applied.doc.embeds);
      }
    });
    e.update();
    if (applied) reportMissing(e, applied);
    e.message(`Imported ${r.sets.length} data set${r.sets.length === 1 ? '' : 's'}.`);
  });
}
