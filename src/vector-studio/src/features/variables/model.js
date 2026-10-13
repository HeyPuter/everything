/**
 * Variables for data-driven artwork. A document defines variables and
 * binds objects to them; data sets hold one value per variable and
 * applying a data set updates every bound object.
 *
 *   root.variables  [{ id, name, type: 'text' | 'visibility' | 'image' | 'graph' }]
 *   root.dataSets   [{ id, name, values: { [variableId]: string | boolean } }]
 *   root.dataSet    id of the data set last applied (or null)
 *   node.bindings   { text?, visibility?, image?, graph?: variableId }
 *
 * Text variables replace a text object's content; visibility variables
 * show or hide any object; linked file variables swap a placed image for
 * the file at a URL or Puter path; graph data variables replace a graph's
 * data (tab-separated rows). Everything is stored in the document, so it
 * is saved with it and undoable. In CSV headers a leading # marks a
 * visibility variable, @ a linked file and % graph data.
 */
import { uid } from '../../lib/ids.js';

export const VARIABLE_TYPES = { text: 'Text', visibility: 'Visibility', image: 'Linked File', graph: 'Graph Data' };

/** CSV header prefixes of the variable types other than text. */
const PREFIX = { visibility: '#', image: '@', graph: '%' };

/** Graph data cells as tab-separated rows, and back. */
export function cellsToText(cells) {
  return (cells || []).map((r) => (r || []).map((c) => String(c ?? '').replace(/[\t\n]/g, ' ')).join('\t')).join('\n');
}

export function textToCells(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.split('\t'));
}

export function variablesOf(doc) {
  return doc.root.variables || [];
}

export function dataSetsOf(doc) {
  return doc.root.dataSets || [];
}

/** Objects bound to a variable: [{ node, slot }]. */
export function boundTo(doc, varId) {
  const out = [];
  doc.walk((n) => {
    for (const [slot, v] of Object.entries(n.bindings || {})) if (v === varId) out.push({ node: n, slot });
    return true;
  });
  return out;
}

/** A unique variable name like "Variable3". */
export function nextName(doc, base = 'Variable') {
  const used = new Set(variablesOf(doc).map((v) => v.name));
  for (let i = 1; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

/** Make a name usable as a variable name (letters, digits, _ and -; not starting with a digit). */
export function cleanName(name) {
  let s = String(name || '').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_\-]/g, '');
  if (!s || /^[0-9-]/.test(s)) s = `v_${s}`;
  return s.slice(0, 64);
}

/** Add a variable (inside a transaction). Returns it. */
export function addVariable(doc, type, name = null) {
  const base = { visibility: 'Visibility', image: 'Image', graph: 'Graph' }[type] || 'Variable';
  const v = { id: uid('var'), name: cleanName(name || nextName(doc, base)), type };
  if (variablesOf(doc).some((x) => x.name === v.name)) v.name = nextName(doc, v.name);
  doc.updateRoot({ variables: [...variablesOf(doc), v] });
  return v;
}

/** Remove variables and their bindings and data set values (inside a transaction). */
export function removeVariables(doc, ids) {
  const drop = new Set(ids);
  doc.updateRoot({
    variables: variablesOf(doc).filter((v) => !drop.has(v.id)),
    dataSets: dataSetsOf(doc).map((ds) => ({ ...ds, values: Object.fromEntries(Object.entries(ds.values).filter(([k]) => !drop.has(k))) })),
  });
  doc.walk((n) => {
    if (!n.bindings) return true;
    const kept = Object.fromEntries(Object.entries(n.bindings).filter(([, v]) => !drop.has(v)));
    if (Object.keys(kept).length !== Object.keys(n.bindings).length) doc.update(n.id, { bindings: Object.keys(kept).length ? kept : undefined });
    return true;
  });
}

/** Bind an object slot to a variable (inside a transaction). */
export function bind(doc, nodeId, slot, varId) {
  const n = doc.get(nodeId);
  if (!n) return;
  const bindings = { ...(n.bindings || {}) };
  if (varId) bindings[slot] = varId;
  else delete bindings[slot];
  doc.update(nodeId, { bindings: Object.keys(bindings).length ? bindings : undefined });
}

/** The current value of a variable read from its first bound object. */
export function currentValue(doc, v) {
  const b = boundTo(doc, v.id)[0];
  if (!b) return v.type === 'visibility' ? true : '';
  if (v.type === 'text') return b.node.text ?? '';
  if (v.type === 'image') return b.node.link?.path || b.node.link?.url || '';
  if (v.type === 'graph') return cellsToText(b.node.live?.data);
  return !b.node.hidden;
}

/** Capture the current values of all variables as a new data set (inside a transaction). */
export function captureDataSet(doc, name = null) {
  const sets = dataSetsOf(doc);
  const values = {};
  for (const v of variablesOf(doc)) values[v.id] = currentValue(doc, v);
  const ds = { id: uid('ds'), name: name || `Data Set ${sets.length + 1}`, values };
  doc.updateRoot({ dataSets: [...sets, ds], dataSet: ds.id });
  return ds;
}

/** Update a data set with the current values (inside a transaction). */
export function updateDataSet(doc, id) {
  const values = {};
  for (const v of variablesOf(doc)) values[v.id] = currentValue(doc, v);
  doc.updateRoot({ dataSets: dataSetsOf(doc).map((ds) => (ds.id === id ? { ...ds, values } : ds)) });
}

/** The linked-file values a data set needs loaded before it applies (non-empty and different from now). */
export function imageSources(doc, id) {
  const ds = dataSetsOf(doc).find((d) => d.id === id);
  const out = new Set();
  if (!ds) return out;
  for (const v of variablesOf(doc)) {
    if (v.type !== 'image' || !(v.id in ds.values)) continue;
    const src = String(ds.values[v.id] ?? '').trim();
    if (src && boundTo(doc, v.id).some(({ node }) => node.type === 'image' && (node.link?.path || node.link?.url) !== src)) out.add(src);
  }
  return out;
}

/**
 * Apply a data set to the bound objects (inside a transaction).
 * `setText(doc, node, text)` replaces a text object's content (the type module
 * keeps its character runs consistent); `setImage(doc, node, source)` swaps
 * a placed image (its file must be loaded already) and `setGraph(doc, node,
 * cells)` replaces a graph's data.
 */
export function applyDataSet(doc, id, setText, { setImage = null, setGraph = null } = {}) {
  const ds = dataSetsOf(doc).find((d) => d.id === id);
  if (!ds) return false;
  for (const v of variablesOf(doc)) {
    if (!(v.id in ds.values)) continue;
    const value = ds.values[v.id];
    for (const { node, slot } of boundTo(doc, v.id)) {
      if (slot === 'text' && node.type === 'text' && v.type === 'text') {
        const text = String(value ?? '');
        if (node.text !== text) setText(doc, doc.get(node.id), text);
      } else if (slot === 'visibility' && v.type === 'visibility') {
        const hidden = !toBool(value);
        if (Boolean(node.hidden) !== hidden) doc.update(node.id, { hidden });
      } else if (slot === 'image' && v.type === 'image' && node.type === 'image' && setImage) {
        const src = String(value ?? '').trim();
        if (src && (node.link?.path || node.link?.url) !== src) setImage(doc, doc.get(node.id), src);
      } else if (slot === 'graph' && v.type === 'graph' && node.live?.kind === 'graph') {
        const cells = textToCells(value);
        if (cellsToText(node.live.data) !== cellsToText(cells)) {
          if (setGraph) setGraph(doc, node.id, cells);
          else doc.update(node.id, { live: { ...node.live, data: cells } });
        }
      }
    }
  }
  doc.updateRoot({ dataSet: ds.id });
  return true;
}

export function toBool(v) {
  if (typeof v === 'boolean') return v;
  return !/^(false|0|no|off|hidden|)$/i.test(String(v ?? '').trim());
}

// ---- CSV ----

/** Parse CSV text (RFC 4180 quoting) into rows of cells. */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

const csvCell = (v) => {
  const s = typeof v === 'boolean' ? String(v) : String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV of the data sets: a header of variable names (visibility ones prefixed with #), one row per data set. */
export function toCSV(doc) {
  const vars = variablesOf(doc);
  const lines = [vars.map((v) => csvCell(`${PREFIX[v.type] || ''}${v.name}`)).join(',')];
  for (const ds of dataSetsOf(doc)) lines.push(vars.map((v) => csvCell(ds.values[v.id] ?? '')).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Import CSV (header row of variable names; a leading # marks a visibility
 * variable) as data sets, adding missing variables (inside a transaction).
 * Returns the number of data sets added.
 */
export function importCSV(doc, text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('The file needs a header row of variable names and at least one row of values.');
  const header = rows[0].map((h) => h.trim());
  const ids = header.map((h) => {
    const type = Object.keys(PREFIX).find((t) => h.startsWith(PREFIX[t])) || 'text';
    const name = cleanName(type === 'text' ? h : h.slice(1));
    const existing = variablesOf(doc).find((v) => v.name === name);
    return existing ? existing.id : addVariable(doc, type, name).id;
  });
  const types = new Map(variablesOf(doc).map((v) => [v.id, v.type]));
  const sets = [...dataSetsOf(doc)];
  rows.slice(1).forEach((r) => {
    const values = {};
    ids.forEach((id, c) => {
      const raw = r[c] ?? '';
      values[id] = types.get(id) === 'visibility' ? toBool(raw) : raw;
    });
    sets.push({ id: uid('ds'), name: `Data Set ${sets.length + 1}`, values });
  });
  doc.updateRoot({ dataSets: sets });
  return rows.length - 1;
}
