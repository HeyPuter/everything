/** App-specific state in ODF's standard application settings container. */
import { odsNamespaceLookup } from './ods-validation.js';
const CONFIG = 'urn:oasis:names:tc:opendocument:xmlns:config:1.0';
const OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';

export function writeOdsSettings(meta, escape, view = null) {
  const views = writeOdsViewSettings(view, escape);
  if (!meta && !views) return '';
  const state = meta ? `<config:config-item-set config:name="puter-spreadsheet"><config:config-item config:name="document-state" config:type="string">${escape(JSON.stringify(meta))}</config:config-item></config:config-item-set>` : '';
  return `<office:settings xmlns:office="${OFFICE}" xmlns:config="${CONFIG}">${state}${views}</office:settings>`;
}

/**
 * The view settings LibreOffice keeps for each sheet (ooo:view-settings): its frozen rows and columns, its tab
 * colour, gridlines and zoom, and the sheet the book opens on. `view` is { active, sheets: { [name]: { frozenRows,
 * frozenCols, tabColor, gridlines, zoom } } }; '' when there is nothing to say.
 */
function writeOdsViewSettings(view, escape) {
  if (!view?.sheets) return '';
  const item = (name, type, value) => `<config:config-item config:name="${name}" config:type="${type}">${escape(String(value))}</config:config-item>`;
  const tables = Object.entries(view.sheets).map(([name, s]) => {
    const items = [];
    const rows = Math.max(0, Math.trunc(Number(s?.frozenRows) || 0)), cols = Math.max(0, Math.trunc(Number(s?.frozenCols) || 0));
    // 2 is a frozen split; the position counts the frozen columns or rows, and the scrolled pane starts after them.
    if (cols) items.push(item('HorizontalSplitMode', 'short', 2), item('HorizontalSplitPosition', 'int', cols), item('PositionLeft', 'int', 0), item('PositionRight', 'int', cols));
    if (rows) items.push(item('VerticalSplitMode', 'short', 2), item('VerticalSplitPosition', 'int', rows), item('PositionTop', 'int', 0), item('PositionBottom', 'int', rows));
    // The pane the cursor is in: bottom-right with both frozen, bottom-left with rows only, top-right with columns only.
    if (rows || cols) items.push(item('ActiveSplitRange', 'short', rows && cols ? 3 : rows ? 2 : 1));
    if (typeof s?.tabColor === 'string' && /^#[\da-f]{6}$/i.test(s.tabColor)) items.push(item('TabColor', 'int', parseInt(s.tabColor.slice(1), 16)));
    if (s?.gridlines === false) items.push(item('ShowGrid', 'boolean', 'false'));
    // ZoomType 0 is a zoom by the value given, in percent.
    if (Number.isFinite(s?.zoom) && s.zoom >= 0.1 && s.zoom <= 4 && s.zoom !== 1) items.push(item('ZoomType', 'short', 0), item('ZoomValue', 'int', Math.round(s.zoom * 100)));
    return items.length ? `<config:config-item-map-entry config:name="${escape(name)}">${items.join('')}</config:config-item-map-entry>` : '';
  }).join('');
  if (!tables && !view.active) return '';
  return `<config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry>${item('ViewId', 'string', 'view1')}`
    + `${tables ? `<config:config-item-map-named config:name="Tables">${tables}</config:config-item-map-named>` : ''}${view.active ? item('ActiveTable', 'string', view.active) : ''}`
    + '</config:config-item-map-entry></config:config-item-map-indexed></config:config-item-set>';
}

/**
 * The first view's settings as LibreOffice writes them: { active, sheets: { [name]: { frozenRows, frozenCols,
 * tabColor, gridlines, zoom } } } for the sheets with any, or null. Only a frozen split (mode 2) counts rows and columns.
 */
export function readOdsViewSettings(xml, decode) {
  if (!xml || !xml.includes('ooo:view-settings')) return null;
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  const set = /<(\w+):config-item-set\b[^>]*\bconfig:name="ooo:view-settings"[^>]*>([\s\S]*?)<\/\1:config-item-set>/.exec(xml)?.[2];
  const views = set && /<(\w+):config-item-map-indexed\b[^>]*\bconfig:name="Views"[^>]*>/.exec(set);
  if (!views) return null;
  // The first view is the first entry of the Views map; the sheets' entries nest inside it.
  let body = null, depth = 0, start = -1;
  const entries = /<(\/?)\w+:config-item-map-entry\b[^>]*?(\/?)>/g;
  entries.lastIndex = views.index + views[0].length;
  for (let m; (m = entries.exec(set));) {
    if (m[2]) continue;
    if (!m[1]) { if (depth++ === 0) start = m.index + m[0].length; continue; }
    if (--depth === 0) { body = set.slice(start, m.index); break; }
    if (depth < 0) break;
  }
  if (body == null) return null;
  const items = (text) => {
    const out = {};
    for (const m of text.matchAll(/<(\w+):config-item\b[^>]*\bconfig:name="([^"]*)"[^>]*>([^<]*)<\/\1:config-item>/g)) out[decode(m[2])] = decode(m[3]);
    return out;
  };
  const sheets = {};
  const tables = /<(\w+):config-item-map-named\b[^>]*\bconfig:name="Tables"[^>]*>([\s\S]*?)<\/\1:config-item-map-named>/.exec(body);
  if (tables) {
    for (const m of tables[2].matchAll(/<(\w+):config-item-map-entry\b[^>]*\bconfig:name="([^"]*)"[^>]*>([\s\S]*?)<\/\1:config-item-map-entry>/g)) {
      const s = items(m[3]), out = {};
      const count = (mode, position) => (s[mode] === '2' && /^\d+$/.test(s[position] || '') ? Math.min(Number(s[position]), 10000) : 0);
      const cols = count('HorizontalSplitMode', 'HorizontalSplitPosition'), rows = count('VerticalSplitMode', 'VerticalSplitPosition');
      if (cols) out.frozenCols = cols;
      if (rows) out.frozenRows = rows;
      const color = Number(s.TabColor);
      // -1 is LibreOffice's automatic (no) tab colour.
      if (/^\d+$/.test(s.TabColor || '') && color >= 0 && color <= 0xffffff) out.tabColor = `#${color.toString(16).padStart(6, '0')}`;
      if (s.ShowGrid === 'false') out.gridlines = false;
      const zoom = Number(s.ZoomValue);
      // ZoomType 0 is a zoom by value; the others fit the page or its width, which a sheet view does not keep.
      if ((s.ZoomType ?? '0') === '0' && /^\d+$/.test(s.ZoomValue || '') && zoom >= 10 && zoom <= 400 && zoom !== 100) out.zoom = zoom / 100;
      if (Object.keys(out).length) sheets[decode(m[2])] = out;
    }
    body = body.replace(tables[0], '');
  }
  const active = items(body).ActiveTable;
  return Object.keys(sheets).length || active ? { ...(active ? { active } : {}), sheets } : null;
}

export function readOdsSettings(xml, decode) {
  if (!xml || !xml.includes('document-state')) return null;
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  const readers = new Map();
  const tags = /<([\w.-]+):config-item\b((?:[^>"']|"[^"]*"|'[^']*')*)>([^<]*)<\/\1:config-item\s*>/g;
  let match;
  while ((match = tags.exec(xml))) {
    const bindings = new Map();
    const namespace = prefix => {
      if (!bindings.has(prefix)) {
        if (!readers.has(prefix)) readers.set(prefix, odsNamespaceLookup(xml, decode));
        bindings.set(prefix, readers.get(prefix)(match.index, prefix));
      }
      return bindings.get(prefix);
    };
    if (namespace(match[1]) !== CONFIG) continue;
    const attrs = {};
    for (const attr of match[2].matchAll(/([\w.-]+):([\w.-]+)\s*=\s*(["'])(.*?)\3/gs)) {
      if (namespace(attr[1]) === CONFIG) attrs[attr[2]] = decode(attr[4]);
    }
    if (attrs.name !== 'document-state' || attrs.type !== 'string') continue;
    try {
      const meta = JSON.parse(decode(match[3]));
      if (meta?.format === 'puter-spreadsheet' && meta.v === 1 && meta.sheets && typeof meta.sheets === 'object' && !Array.isArray(meta.sheets)) return meta;
    } catch { /* Unrecognized or damaged settings must not prevent opening cells. */ }
  }
  return null;
}
