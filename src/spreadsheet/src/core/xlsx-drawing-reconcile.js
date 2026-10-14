/** Reconcile native drawing edits with the richer model saved by this application. */
import { xmlTag } from './xlsx-export-styles.js';

const CREATION_URI = '{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}';
const CREATION_NS = 'http://schemas.microsoft.com/office/drawing/2014/main';
const GUID = /^\{[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\}$/i;
const child = (node, name) => node?.children?.find(c => c.name === name);

export function drawingIdentity(node) {
  const nv = node?.children?.find(c => ['nvSpPr', 'nvCxnSpPr', 'nvGrpSpPr', 'nvPicPr', 'nvGraphicFramePr'].includes(c.name));
  const props = child(nv, 'cNvPr');
  const ext = child(props, 'extLst')?.children.find(c => c.name === 'ext' && c.attrs.uri?.toUpperCase() === CREATION_URI);
  const key = child(ext, 'creationId')?.attrs.id;
  return { key: GUID.test(key || '') ? key.toUpperCase() : null, name: props?.attrs.name || '', description: props?.attrs.descr,
    ...(['1', 'true'].includes(props?.attrs.hidden) ? { hidden: true } : {}) };
}

/** MS-ODRAWXML CT_CreationId survives Office's renumbering of cNvPr IDs.
 * https://learn.microsoft.com/en-us/openspecs/office_standards/ms-odrawxml/7b70d634-1469-4275-bc1f-f77375d39641
 */
export function identifyDrawing(xml) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  const hex = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
  const key = `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
  const ext = xmlTag('a:ext', { uri: CREATION_URI }, xmlTag('a16:creationId', { 'xmlns:a16': CREATION_NS, id: key }));
  xml = xml.replace(/<xdr:cNvPr\b[^>]*?(?:\/>|>[\s\S]*?<\/xdr:cNvPr>)/, props => {
    if (props.endsWith('/>')) return props.slice(0, -2) + '>' + xmlTag('a:extLst', {}, ext) + '</xdr:cNvPr>';
    if (props.includes('</a:extLst>')) return props.replace('</a:extLst>', ext + '</a:extLst>');
    return props.replace('</xdr:cNvPr>', xmlTag('a:extLst', {}, ext) + '</xdr:cNvPr>');
  });
  return { xml, key };
}

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const canonical = value => JSON.stringify(value, (_, v) => record(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
async function stamp(value) {
  const json = canonical(value);
  if (!record(value) && !Array.isArray(value) && typeof value !== 'string') return { value: json };
  const input = new TextEncoder().encode(json);
  // Non-secure browser contexts lack SubtleCrypto. Use the same SHA-256 in
  // both environments so unchanged properties never become false edits.
  const bytes = globalThis.crypto?.subtle ? await crypto.subtle.digest('SHA-256', input)
    : (await import('@noble/hashes/sha2.js')).sha256(input);
  return { hash: Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('') };
}
export async function drawingBaseline(value) {
  if (!record(value)) return stamp(value);
  const props = Object.create(null);
  for (const [key, v] of Object.entries(value)) if (key !== 'xlsxDrawingIdentity' && key !== 'id' && v !== undefined) {
    // An affine shape tree is one representation: merging a native wrapper's
    // children into the original unwrapped node would create invalid geometry.
    props[key] = key === 'nativeDrawing' ? await stamp(v) : await drawingBaseline(v);
  }
  return { props };
}
async function merge(saved, baseline, current) {
  if (record(baseline?.props) && record(current)) {
    // An absent model object can mean "use authored defaults". Recursively
    // merging unchanged native fields into {} invents an object and can switch
    // rendering modes. If native content changed, adopt its complete object;
    // partial native defaults have no corresponding saved model to merge into.
    if (!record(saved)) return canonical(await drawingBaseline(current)) === canonical(baseline) ? saved : current;
    const out = record(saved) ? { ...saved } : {};
    for (const key of new Set([...Object.keys(baseline.props), ...Object.keys(current)])) {
      if (key === 'xlsxDrawingIdentity' || key === 'id' || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      if (!Object.hasOwn(current, key) || current[key] === undefined) { if (Object.hasOwn(baseline.props, key)) delete out[key]; }
      else if (!Object.hasOwn(baseline.props, key)) out[key] = current[key];
      else out[key] = await merge(out[key], baseline.props[key], current[key]);
    }
    return out;
  }
  const now = baseline?.value !== undefined ? { value: canonical(current) } : await stamp(current);
  return baseline && (baseline.hash ? baseline.hash === now.hash : baseline.value === now.value) ? saved : current;
}

const unique = (items, key) => {
  const map = new Map();
  for (const item of items) { const k = key(item); if (k) map.set(k, map.has(k) ? null : item); }
  return map;
};
const geometryKeys = ['cellAnchor', 'anchor', 'anchorMode', 'dx', 'dy', 'w', 'h', 'rotation', 'flipH', 'flipV', 'decorative', 'description'];

export async function reconcileDrawings(saved, native, inventory = []) {
  if (!Array.isArray(saved?.charts)) return native;
  saved = { ...saved, charts: saved.charts.filter(record) };
  const manifest = Array.isArray(saved.nativeDrawings) ? saved.nativeDrawings.filter(r => GUID.test(r?.key || '') && typeof r.id === 'string' && record(r.baseline)) : null;
  const models = unique(saved.charts, c => c.id), current = unique(native, c => c.xlsxDrawingIdentity?.key);
  if (manifest) {
    const byKey = unique(manifest, r => r.key), present = new Set(inventory.map(i => i.key)), used = new Set();
    const result = [];
    for (const obj of native) {
      if (obj.xlsxDrawingIdentity?.parentKey) used.add(obj.xlsxDrawingIdentity.parentKey);
      const key = obj.xlsxDrawingIdentity?.key, entry = current.get(key) === obj && byKey.get(key), model = entry && models.get(entry.id);
      if (!model) { result.push(obj); continue; }
      used.add(key);
      const typeChanged = await merge(model.type, entry.baseline.props?.type, obj.type) !== model.type;
      let representationChanged = false;
      if (model.type !== obj.type) {
        // A native picture may be an editable chart's preview, or a text box
        // may require the richer DrawingML representation after external edits.
        // Once that representation changes, its native content is authoritative.
        const fields = props => Object.fromEntries(Object.entries(props || {}).filter(([k]) => !geometryKeys.includes(k) && k !== 'type' && k !== 'title'));
        representationChanged = canonical(fields((await drawingBaseline(obj)).props)) !== canonical(fields(entry.baseline.props));
      }
      const restored = typeChanged || representationChanged ? { ...obj, id: model.id } : { ...await merge(model, entry.baseline, obj), id: model.id };
      // A chart exported as a picture has its accessible description in the
      // native image's title field. External alt-text edits must not overwrite
      // the editable chart's visible title or discard its data representation.
      if (!typeChanged && !representationChanged && model.type !== 'image' && obj.type === 'image') {
        restored.title = model.title;
        restored.description = obj.decorative && obj.xlsxDrawingIdentity?.description === undefined ? model.description
          : await merge(model.description, entry.baseline.props?.title, obj.xlsxDrawingIdentity?.description);
      }
      result.push(restored);
    }
    // An existing but unreadable object is not a deletion. Retain its model
    // rather than silently losing it because an external feature is unsupported.
    for (const entry of manifest) if (!used.has(entry.key) && !current.has(entry.key) && present.has(entry.key) && models.get(entry.id)) result.push(models.get(entry.id));
    return result;
  }
  // Older exports have no baseline or stable key. Match only unambiguous native
  // names, never positions/order: Office may renumber IDs or reorder anchors.
  // Early application versions stored drawings only in metadata. Without a
  // native baseline, an empty drawing inventory cannot prove deletion.
  if (!native.length) return saved.charts;
  const named = unique(saved.charts.map((model, i) => ({ model, name: model.type === 'text' ? `Text ${i + 1}`
    : model.title || (model.nativeDrawing ? 'Shape' : model.type === 'image' || ['histogram', 'waterfall'].includes(model.type) || model.pareto ? `Picture ${i + 1}` : `Chart ${i + 1}`) })), x => x.name);
  const nativeNames = unique(native, c => c.xlsxDrawingIdentity?.name);
  const result = native.map(obj => {
    const name = obj.xlsxDrawingIdentity?.name, old = nativeNames.get(name) === obj && named.get(name)?.model;
    if (!old) return obj;
    // Images/shapes have a complete native representation. Legacy charts may
    // be raster previews, so retain their editable data while reading placement.
    if (old.type === 'image') return { ...obj, id: old.id, ...(obj.decorative ? { title: old.title } : {}) };
    const result = { ...old };
    for (const key of geometryKeys) { if (Object.hasOwn(obj, key)) result[key] = obj[key]; else delete result[key]; }
    return result;
  });
  for (const identity of inventory) {
    const old = named.get(identity.name)?.model;
    if (old && !nativeNames.has(identity.name) && !result.includes(old)) result.push(old);
  }
  return result;
}

