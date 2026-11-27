// PropertyManager panels and dialogs of assemblies: Insert Components, Mate,
// Move and Rotate Component, Explode Step, Interference Detection, Bill of
// Materials and the assembly's Mass Properties.

import type { MeshData } from '../../kernel/protocol';
import type { AsmMassResult, InterferencePair } from '../../kernel/assembly';
import { type Vec3, add, normalize, qAxisAngle, qMul, scale } from '../../math/vec';
import { allocateId, newDocument, parseDocument, serializeDocument } from '../../model/document';
import { defaultName } from '../../model/features';
import { BASE_PLANE_NAMES } from '../../model/planes';
import type { Id, Param, PartDocument } from '../../model/types';
import { UNIT_SYSTEMS } from '../../model/units';
import {
  type AssemblyDocument, type ExplodeStep, type Mate, type MateRef, type MateType, type MechanicalMateType, type PartSource, type Placement, MATE_LABELS, MECHANICAL_MATES, assemblyBom, bomCsv, instanceName,
  isAssembly, isMechanical, newPartBlobId, nextAsmId, nextPartColor, parseAnyDocument,
} from '../../model/assembly';
import { type Geo, fittingMates, initialMateSettings, mateProblem, placeGeo, relativePlacement } from '../../assembly/solver';
import {
  EXT, acceptList, cloudVersion, download, isSolidWorksFile, isStepFile, listParts, loadPart, locationLabel, pickCloudFile, pickDeviceFile, readIndexEntry, safeName, sameLocation, versionChanged,
  type FileEntry, type FileVersion, type Location,
} from '../../platform/files';
import { cloudAvailable, puter, storageError } from '../../platform/puter';
import { h } from '../../ui/dom';
import { icon } from '../../ui/icons';
import { showDialog, toast } from '../../ui/overlay';
import type { App } from '../app';
import { formatGroup } from '../dialogs';
import { type PickFilter, type SelBoxItem, PropertyPanel, SelectionBox, checkbox, numberField, section, segmented, selectField } from '../pm';
import type { SelItem } from '../selection';
import type { AssemblyMode } from './mode';

// ---------- Insert Components ----------

interface PickedPart {
  doc: PartDocument;
  source: PartSource | null;
  version: FileVersion | null;
  /** Another instance of a part the assembly already has. */
  partId?: Id;
}

/** Version of a part file to compare with later (cloud: its time and size; this browser: its listing). */
export function localVersion(loc: Location): FileVersion | null {
  if (loc.type !== 'local') return null;
  const e = readIndexEntry(loc.id);
  return e ? { modified: e.modified, size: e.size } : null;
}

/** Reads a part file's text as a part (an assembly or another file is refused with why). */
function partFrom(text: string, name: string): PartDocument | null {
  let doc;
  try {
    doc = parseAnyDocument(text);
  } catch (e) {
    toast({ kind: 'error', title: 'Could not insert the part', message: (e as Error).message });
    return null;
  }
  if (isAssembly(doc)) {
    toast({ kind: 'error', title: 'Could not insert the part', message: `${name} is an assembly. Insert its parts instead: assemblies inside assemblies are not supported yet.` });
    return null;
  }
  return doc;
}

/**
 * Asks which part to insert: parts in the cloud or this browser (as the Open
 * dialog lists them), a file from the device (a part, or a STEP model, which
 * becomes a part kept inside the assembly) or one picked in Puter.
 */
export async function pickPart(app: App): Promise<PickedPart | null> {
  const signal = app.documentSignal;
  let cloudError = '';
  const entries = (await listParts((e) => { cloudError = storageError(e); })).filter((e) => !sameLocation(e.location, app.location));
  if (signal.aborted) return null;
  const list = h('div', { class: 'file-list', role: 'list' });
  let chosen: FileEntry | null = null;
  let close: ((v: string | null) => void) | null = null;
  if (!entries.length) list.replaceChildren(h('p', {}, 'No saved parts yet. Save a part first, or insert a part or STEP file from this device.'));
  for (const e of entries) {
    const b = h('button', { class: 'file-item', type: 'button' },
      h('span', { 'aria-hidden': 'true', style: { color: e.location.type === 'cloud' ? 'var(--accent)' : 'var(--text-3)' } }, icon(e.location.type === 'cloud' ? 'cloud' : 'device', 18)),
      h('span', { class: 'txt' }, h('span', { class: 'n' }, e.name), h('span', { class: 'meta' }, `${locationLabel(e.location)}  ${e.modified ? new Date(e.modified).toLocaleString() : ''}`)));
    b.addEventListener('click', () => { chosen = e; close?.('pick'); });
    list.append(h('div', { class: 'file-row', role: 'listitem' }, b));
  }
  const body = h('div', {}, h('p', { class: 'field-label' }, 'Choose a part to place in the assembly. The assembly keeps a copy, and picks up changes to the part file when it is opened.'),
    cloudError ? h('p', { role: 'alert' }, `Your cloud parts could not be listed: ${cloudError}`) : null, list);
  const buttons: { label: string; value: string; left?: boolean }[] = [{ label: 'From device...', value: 'device', left: true }];
  if (cloudAvailable() && puter()?.ui?.showOpenFilePicker) buttons.push({ label: 'Browse Puter...', value: 'browse', left: true });
  buttons.push({ label: 'Cancel', value: 'cancel' });
  const v = await showDialog({ title: 'Insert Components', signal, body, buttons, wide: true, onReady: (c) => { close = c; } });
  if (signal.aborted) return null;
  if (v === 'pick' && chosen) {
    const e = chosen as FileEntry;
    try {
      const read = await loadPart(e.location);
      const doc = partFrom(read.text, e.name);
      if (!doc || signal.aborted) return null;
      if (e.location.type === 'cloud') doc.name = e.name;
      return { doc, source: e.location, version: read.version ?? localVersion(e.location) ?? (e.modified ? { modified: e.modified, size: e.size ?? null } : null) };
    } catch (err) {
      toast({ kind: 'error', title: 'Could not insert the part', message: storageError(err) });
      return null;
    }
  }
  if (v === 'browse') {
    const r = await pickCloudFile().catch((err) => { toast({ kind: 'error', message: storageError(err) }); return null; });
    if (!r || signal.aborted) return null;
    return fromFile(app, r.blob, r.fileName, r.location, r.version);
  }
  if (v === 'device') {
    const file = await pickDeviceFile(acceptList([EXT, '.json', '.step', '.stp', '.sldprt']));
    if (!file || signal.aborted) return null;
    return fromFile(app, file, file.name, null, null);
  }
  return null;
}

async function fromFile(app: App, blob: Blob, fileName: string, loc: Location | null, version: FileVersion | null): Promise<PickedPart | null> {
  const base = safeName(fileName.replace(/\.[^.]+$/, ''));
  if (isStepFile(fileName) || isSolidWorksFile(fileName)) {
    if (/\.(sldasm|slddrw)$/i.test(fileName)) { toast({ kind: 'error', message: `${fileName} is not a SolidWorks part. Insert parts (.sldprt) one by one.` }); return null; }
    let step: string;
    try {
      step = isStepFile(fileName) ? await blob.text() : (await app.kernel.convertSolidWorks(new Uint8Array(await blob.arrayBuffer()), fileName)).step;
    } catch (e) {
      toast({ kind: 'error', title: 'Could not insert the file', message: (e as Error).message });
      return null;
    }
    const err = step.trim() ? await app.kernel.checkImport(step).catch((e) => (e as Error).message) : `${fileName} is empty.`;
    if (err) { toast({ kind: 'error', title: 'Could not insert the file', message: err }); return null; }
    // A model file becomes a part kept inside the assembly, its solid as an imported body.
    const doc = newDocument(base || 'Part', app.settings.defaultUnits);
    const blobId = `b${Math.random().toString(36).slice(2, 10)}`;
    doc.blobs[blobId] = step;
    doc.features.push({ id: allocateId(doc), name: defaultName(doc, 'import'), type: 'import', format: 'step', blob: blobId, fileName });
    return { doc, source: null, version: null };
  }
  const doc = partFrom(await blob.text(), fileName);
  if (!doc) return null;
  if (loc) doc.name = base;
  return { doc, source: loc, version };
}

/** Embeds the part (once) and places a new component of it. */
export function insertComponent(mode: AssemblyMode, picked: PickedPart) {
  const app = mode.app;
  const doc = mode.doc;
  let part = picked.partId ? doc.parts.find((p) => p.id === picked.partId)
    : picked.source ? doc.parts.find((p) => p.source && sameLocation(p.source as Location, picked.source as Location)) : undefined;
  const text = picked.partId ? '' : serializeDocument(picked.doc);
  let blob: Id | null = null;
  if (!part || (!picked.partId && doc.blobs[part.blob] !== text)) {
    blob = newPartBlobId(doc);
    // Copies are kept out of undo history (like imported files): set before the change that uses it.
    doc.blobs[blob] = text;
  }
  const b = app.bbox;
  const gap = b ? Math.max(20, 0.25 * Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])) : 0;
  let compId = '';
  mode.commit('Insert component', (d) => {
    if (!part) {
      part = { id: nextAsmId(d, 'p'), name: picked.doc.name, source: picked.source, version: picked.version, blob: blob!, color: nextPartColor(d) };
      d.parts.push(part);
    } else if (blob) {
      const p = d.parts.find((x) => x.id === part!.id)!;
      p.blob = blob;
      p.version = picked.version;
    }
    compId = nextAsmId(d, 'c');
    const first = !d.components.length;
    d.components.push({
      id: compId, name: instanceName(d, part.name), part: part.id,
      placement: { p: first || !b ? [0, 0, 0] : [b.max[0] + gap, 0, 0], q: [0, 0, 0, 1] },
      fixed: first,
    });
  }, false);
  app.selection.set([{ kind: 'feature', id: compId }]);
  // The new component is placed beside the others: show them all.
  mode.fitPending = true;
  const c = mode.component(compId);
  app.setStatus(c?.fixed ? `${c.name} is fixed at the origin. Insert more components and mate them to it.` : `Inserted ${c?.name}. Drag it into place, or add mates (Mate).`, true);
}

// ---------- Mate ----------

const STANDARD_MATES: MateType[] = ['coincident', 'parallel', 'perpendicular', 'distance', 'angle', 'concentric', 'tangent', 'lock'];

/** The selection boxes of a mechanical mate: their labels, what each takes, and how many entities. */
const MECH_BOXES: Record<MechanicalMateType, { label: string; placeholder: string; count: number; filter: PickFilter }[]> = {
  hinge: [
    { label: 'Concentric selections', placeholder: 'Select the pin and its hole (round faces or edges)', count: 2, filter: { face: true, edge: true } },
    { label: 'Coincident selections', placeholder: 'Select two planar faces that touch', count: 2, filter: { face: true, plane: true } },
  ],
  gear: [{ label: 'Gears', placeholder: 'Select a round face or edge of each gear', count: 2, filter: { face: true, edge: true } }],
  rackPinion: [{ label: 'Rack and pinion', placeholder: 'Select a straight edge of the rack and a round face or edge of the pinion', count: 2, filter: { face: true, edge: true } }],
  screw: [{ label: 'Screw selections', placeholder: 'Select a round face or edge of the screw and of the nut', count: 2, filter: { face: true, edge: true } }],
  width: [
    { label: 'Width selections', placeholder: 'Select the two faces of the groove', count: 2, filter: { face: true, plane: true } },
    { label: 'Tab selections', placeholder: 'Select the two faces of the tab', count: 2, filter: { face: true } },
  ],
  slot: [
    { label: 'Slot ends', placeholder: 'Select the two round ends of the slot', count: 2, filter: { face: true, edge: true } },
    { label: 'Pin', placeholder: 'Select the pin (a round face or edge)', count: 1, filter: { face: true, edge: true } },
  ],
};

export class MatePanel extends PropertyPanel {
  title = 'Mate';
  icon = 'mate';
  private box!: SelectionBox;
  private refs: MateRef[] = [];
  /** The second selection box of hinge, width and slot mates. */
  private refs2: MateRef[] = [];
  private type: MateType | null = null;
  private aligned = true;
  private aligned2 = false;
  private flip = false;
  private value: Param = 10;
  private value2: Param = 20;
  private limitOn = false;
  private min: Param = 0;
  private max: Param = 10;
  private by: 'ratio' | 'revolution' | null = null;
  private reverse = false;
  private auto = true;
  private result = h('div', { class: 'pm-msg', role: 'status' });

  constructor(private mode: AssemblyMode, private existing: Mate | null = null) {
    super();
    this.helpText = 'Select two faces, edges or planes of different components (or of a component and the assembly). Mates keep them together as you move things. Mechanical mates (hinge, gear, rack and pinion, screw, width, slot) are in the list of mate types.';
    if (existing) {
      this.editingId = existing.id;
      this.type = existing.type;
      this.aligned = existing.aligned;
      this.aligned2 = !!existing.aligned2;
      this.flip = !!existing.flip;
      this.value = existing.value ?? (existing.type === 'angle' ? 90 : 10);
      this.value2 = existing.value2 ?? 20;
      this.limitOn = !!existing.limit;
      if (existing.limit) { this.min = existing.limit.min; this.max = existing.limit.max; }
      this.by = existing.by ?? null;
      this.reverse = !!existing.reverse;
      this.auto = false;
      this.title = `Mate: ${existing.name}`;
      const t = existing.type;
      if (t === 'width' || t === 'slot') { this.refs = [existing.a, existing.a2!]; this.refs2 = [existing.b, ...(existing.b2 ? [existing.b2] : [])]; }
      else if (t === 'hinge') { this.refs = [existing.a, existing.b]; this.refs2 = [existing.a2!, existing.b2!]; }
      else this.refs = [existing.a, existing.b];
    } else {
      const pre = mode.app.selection.items.map((it) => mode.refOf(it)).filter((r): r is MateRef => !!r).slice(0, 2);
      if (pre.length) { this.refs = pre; this.pickDefaults(); }
    }
  }

  private geo(r: MateRef): Geo | null {
    const e = this.mode.entity(r);
    if (typeof e === 'string') return null;
    const comp = e.body ? this.mode.solved.get(e.body) ?? null : null;
    return placeGeo(e.geo, comp);
  }

  private label(r: MateRef): string {
    if ('plane' in r) return BASE_PLANE_NAMES[r.plane];
    const c = this.mode.component(r.comp)?.name ?? '?';
    if ('face' in r) return `Face (${r.face.sig.type}) of ${c}`;
    if ('edge' in r) return `Edge (${r.edge.sig.type}) of ${c}`;
    return c;
  }

  private get mech(): MechanicalMateType | null {
    return this.type && isMechanical(this.type) ? this.type : null;
  }

  /** The type, alignment, side and values that fit the entities where they are. */
  private pickDefaults() {
    const mech = this.mech;
    if (mech) { this.mechDefaults(mech); return; }
    if (this.refs.length < 2) return;
    const [a, b] = this.refs.map((r) => this.geo(r));
    if (!a || !b) return;
    const fits = fittingMates(a, b);
    if (this.auto || !this.type || !fits.includes(this.type)) this.type = fits[0] ?? 'coincident';
    const st = initialMateSettings(this.type, a, b);
    this.aligned = st.aligned;
    this.flip = st.flip;
    if (this.type === 'distance') this.value = Math.round(st.value * 1000) / 1000;
    if (this.type === 'angle') this.value = Math.round(st.value * 100) / 100;
    if (this.limitOn && typeof this.value === 'number') this.limitAround(this.value);
  }

  /** Limits around the value a mate has where its entities are. */
  private limitAround(v: number) {
    if (this.type === 'angle') { this.min = Math.max(0, Math.round(v - 30)); this.max = Math.min(180, Math.round(v + 30)); }
    else if (this.type === 'hinge') { this.min = -45; this.max = 45; }
    else { this.min = Math.max(0, Math.round((v - 10) * 1000) / 1000); this.max = Math.round((v + 10) * 1000) / 1000; }
  }

  private mechDefaults(t: MechanicalMateType) {
    const g = this.refs.map((r) => this.geo(r));
    const round = (x: Geo | null | undefined) => (x && x.kind === 'axis' && x.r > 0 ? Math.round(2 * x.r * 1000) / 1000 : null);
    if (g.length === 2 && g[0] && g[1]) {
      if (t === 'hinge' || t === 'screw') this.aligned = initialMateSettings('concentric', g[0], g[1]).aligned;
      if (t === 'gear' && this.by !== 'ratio') { this.value = round(g[0]) ?? 20; this.value2 = round(g[1]) ?? 20; }
      if (t === 'rackPinion') {
        // The pinion first: the round one.
        if (g[0].kind === 'line' && g[1].kind === 'axis') this.refs = [this.refs[1], this.refs[0]];
        if (this.by !== 'revolution') this.value = round(this.geo(this.refs[0])) ?? 20;
      }
    }
    if (t === 'hinge' && this.refs2.length === 2) {
      const [a2, b2] = this.hingeFaces();
      const ga = a2 && this.geo(a2), gb = b2 && this.geo(b2);
      if (ga && gb) this.aligned2 = initialMateSettings('coincident', ga, gb).aligned;
    }
    if (t === 'screw' && typeof this.value === 'number' && this.value === 10 && !this.existing) this.value = 1;
  }

  /** A hinge's two faces, the one on the first round entity's component first. */
  private hingeFaces(): [MateRef | undefined, MateRef | undefined] {
    const [f, g] = this.refs2;
    const comp = this.refs[0] && 'comp' in this.refs[0] ? this.refs[0].comp : null;
    return f && g && 'comp' in g && g.comp === comp ? [g, f] : [f, g];
  }

  render(): HTMLElement[] {
    const app = this.mode.app;
    const ctx = app.unitContext();
    const mech = this.mech;
    const sections: HTMLElement[] = [];
    if (mech) {
      const boxes = MECH_BOXES[mech];
      const made: SelectionBox[] = [];
      boxes.forEach((spec, i) => {
        const box = new SelectionBox(this, spec.label, spec.filter, (it) => this.convert(it), (items) => {
          if (items.length > spec.count) { box.setItems(items.slice(-spec.count)); return; }
          const refs = items.map((x) => x.data as MateRef);
          if (i === 0) this.refs = refs; else this.refs2 = refs;
          this.mechDefaults(mech);
          // A full box hands the picks on to the next one.
          const next = made[i + 1];
          if (refs.length === spec.count && next && next.items.length < boxes[i + 1].count) this.activate(next);
          this.mode.app.refreshPanel();
          this.update();
        }, { placeholder: spec.placeholder, icon: 'mate', single: spec.count === 1 });
        box.setItems((i === 0 ? this.refs : this.refs2).map((r) => ({ item: this.mode.itemOf(r), data: r, label: this.label(r) })));
        made.push(box);
      });
      this.box = made[0];
      sections.push(section('Mate Selections', made.map((b) => b.el)));
    } else {
      this.box = new SelectionBox(this, 'Entities to mate', { face: true, edge: true, plane: true, feature: true }, (it) => this.convert(it), (items) => {
        if (items.length > 2) { this.box.setItems(items.slice(-2)); return; }
        this.refs = items.map((x) => x.data as MateRef);
        if (!this.existing) this.pickDefaults();
        this.mode.app.refreshPanel();
        this.update();
      }, { placeholder: 'Select two faces, edges or planes', icon: 'mate' });
      this.box.setItems(this.refs.map((r) => ({ item: this.mode.itemOf(r), data: r, label: this.label(r) })));
      sections.push(section('Mate Selections', [this.box.el]));
    }
    const geos = !mech && this.refs.length === 2 ? this.refs.map((r) => this.geo(r)) : null;
    const fits = geos && geos[0] && geos[1] ? STANDARD_MATES.filter((t) => t === 'lock' || !mateProblem(t, geos[0]!, geos[1]!)) : STANDARD_MATES;
    const type = this.type ?? 'coincident';
    const typeSel = selectField<MateType>('Mate type', type, [...fits, ...MECHANICAL_MATES].map((t) => ({ value: t, label: MATE_LABELS[t] })), (v) => this.setType(v), `mate:${type}`);
    // The two kinds of mates in groups of their own.
    const sel = typeSel.querySelector('select')!;
    const group = (label: string, types: readonly MateType[]) => {
      const g = h('optgroup', { label });
      for (const o of [...sel.options]) if (types.includes(o.value as MateType)) g.append(o);
      return g;
    };
    sel.append(group('Standard', STANDARD_MATES), group('Mechanical', MECHANICAL_MATES));
    sel.value = type;
    sections.push(section('Mate Type', [typeSel]));
    const extra = mech ? this.mechOptions(mech, ctx) : this.standardOptions(type, ctx);
    if (extra.length) sections.push(section('Options', extra));
    sections.push(h('section', { class: 'pm-section' }, this.result));
    queueMicrotask(() => this.update());
    return sections;
  }

  private setType(v: MateType) {
    const was = this.mech;
    this.type = v;
    this.auto = false;
    const now = this.mech;
    // Entities picked for one kind of mate carry over as far as they fit the other.
    // Whole components (picked in the tree) make no mechanical mate.
    if (!was && now) { this.refs2 = []; this.refs = this.refs.filter((r) => !('comp' in r) || 'face' in r || 'edge' in r).slice(0, 2); }
    if (was && !now) this.refs = this.refs.slice(0, 2);
    if (now === 'gear' && this.by === 'revolution') this.by = null;
    if (now === 'rackPinion' && this.by === 'ratio') this.by = null;
    if (!now && this.by) this.by = null;
    if (this.limitOn && v !== 'distance' && v !== 'angle' && v !== 'hinge') this.limitOn = false;
    this.pickDefaults();
    this.mode.app.refreshPanel();
    this.update();
  }

  private standardOptions(type: MateType, ctx: ReturnType<App['unitContext']>): HTMLElement[] {
    const extra: HTMLElement[] = [];
    const kind = type === 'distance' ? 'length' : 'angle';
    if (type === 'distance' || type === 'angle') {
      extra.push(checkbox(type === 'distance' ? 'Limit the distance (between two values)' : 'Limit the angle (between two values)', this.limitOn, (v) => {
        this.limitOn = v;
        if (v) {
          const [a, b] = this.refs.map((r) => this.geo(r));
          const now = a && b ? initialMateSettings(type, a, b).value : typeof this.value === 'number' ? this.value : 10;
          this.limitAround(now);
        }
        this.mode.app.refreshPanel();
        this.update();
      }));
      if (this.limitOn) extra.push(...this.limitFields(kind, ctx));
      else extra.push(numberField({
        label: type === 'distance' ? 'Distance' : 'Angle', icon: type === 'distance' ? 'smartDimension' : 'angle', value: this.value, kind, ctx, min: 0, max: type === 'angle' ? 180 : undefined,
        onChange: (v) => { this.value = v; this.update(); },
      }));
    }
    if (type === 'distance' || type === 'tangent') extra.push(checkbox('Flip dimension (other side)', this.flip, (v) => { this.flip = v; this.update(); }));
    if (type !== 'perpendicular' && type !== 'lock' && type !== 'tangent') extra.push(...this.alignment());
    return extra;
  }

  private alignment(): HTMLElement[] {
    return [h('div', { class: 'field-label' }, 'Mate alignment'), segmented('Mate alignment', this.aligned ? 'aligned' : 'anti', [
      { value: 'aligned', label: 'Aligned' }, { value: 'anti', label: 'Anti-Aligned' },
    ], (v) => { this.aligned = v === 'aligned'; this.update(); })];
  }

  private limitFields(kind: 'length' | 'angle', ctx: ReturnType<App['unitContext']>): HTMLElement[] {
    const angle = kind === 'angle' && this.type === 'angle';
    return [
      numberField({ label: 'Maximum', icon: kind === 'length' ? 'smartDimension' : 'angle', value: this.max, kind, ctx, min: angle ? 0 : undefined, max: angle ? 180 : undefined, onChange: (v) => { this.max = v; this.update(); } }),
      numberField({ label: 'Minimum', icon: kind === 'length' ? 'smartDimension' : 'angle', value: this.min, kind, ctx, min: angle ? 0 : undefined, max: angle ? 180 : undefined, onChange: (v) => { this.min = v; this.update(); } }),
    ];
  }

  private mechOptions(t: MechanicalMateType, ctx: ReturnType<App['unitContext']>): HTMLElement[] {
    const out: HTMLElement[] = [];
    const reverse = (label: string) => checkbox(label, this.reverse, (v) => { this.reverse = v; this.update(); });
    switch (t) {
      case 'hinge':
        out.push(...this.alignment(), checkbox('Limit the angle (from where it is now)', this.limitOn, (v) => {
          this.limitOn = v;
          if (v) this.limitAround(0);
          this.mode.app.refreshPanel();
          this.update();
        }));
        if (this.limitOn) out.push(...this.limitFields('angle', ctx));
        break;
      case 'gear': {
        const teeth = this.by === 'ratio';
        out.push(h('div', { class: 'field-label' }, 'Ratio from'), segmented('Ratio from', teeth ? 'ratio' : 'diameter', [{ value: 'diameter', label: 'Pitch diameters' }, { value: 'ratio', label: 'Teeth' }], (v) => {
          this.by = v === 'ratio' ? 'ratio' : null;
          if (v === 'ratio') { this.value = 20; this.value2 = 40; } else this.mechDefaults('gear');
          this.mode.app.refreshPanel();
          this.update();
        }));
        const kind = teeth ? 'count' : 'length';
        out.push(
          numberField({ label: teeth ? 'Teeth of the first gear' : 'Pitch diameter of the first gear', value: this.value, kind, ctx, min: teeth ? 1 : 0, onChange: (v) => { this.value = v; this.update(); } }),
          numberField({ label: teeth ? 'Teeth of the second gear' : 'Pitch diameter of the second gear', value: this.value2, kind, ctx, min: teeth ? 1 : 0, onChange: (v) => { this.value2 = v; this.update(); } }),
          reverse('Reverse (an internal gear: both turn the same way)'),
        );
        break;
      }
      case 'rackPinion': {
        const per = this.by === 'revolution';
        out.push(h('div', { class: 'field-label' }, 'Rack travel from'), segmented('Rack travel from', per ? 'revolution' : 'diameter', [{ value: 'diameter', label: 'Pitch diameter' }, { value: 'revolution', label: 'Travel per turn' }], (v) => {
          this.by = v === 'revolution' ? 'revolution' : null;
          if (typeof this.value === 'number') this.value = Math.round((v === 'revolution' ? this.value * Math.PI : this.value / Math.PI) * 1000) / 1000;
          this.mode.app.refreshPanel();
          this.update();
        }));
        out.push(
          numberField({ label: per ? 'Rack travel per turn of the pinion' : 'Pinion pitch diameter', icon: 'smartDimension', value: this.value, kind: 'length', ctx, min: 0, onChange: (v) => { this.value = v; this.update(); } }),
          reverse('Reverse the direction'),
        );
        break;
      }
      case 'screw':
        out.push(
          numberField({ label: 'Pitch (travel per turn)', icon: 'smartDimension', value: this.value, kind: 'length', ctx, min: 0, onChange: (v) => { this.value = v; this.update(); } }),
          h('div', { class: 'field-label' }, 'Thread'), segmented('Thread', this.reverse ? 'left' : 'right', [{ value: 'right', label: 'Right-hand' }, { value: 'left', label: 'Left-hand' }], (v) => { this.reverse = v === 'left'; this.update(); }),
          ...this.alignment(),
        );
        break;
      default:
        break;
    }
    return out;
  }

  private convert(it: SelItem): SelBoxItem | null {
    const r = this.mode.refOf(it);
    if (!r) return null;
    if ('comp' in r && !('face' in r) && !('edge' in r)) {
      // A component picked in the tree only takes a lock mate.
      if (this.mech) return null;
      if (this.type !== 'lock') { this.type = 'lock'; this.auto = false; }
    }
    return { item: it, data: r, label: this.label(r) };
  }

  /** Where b sits in a's frame now (lock mates, and hinges measuring their angle). */
  private relNow(a: MateRef, b: MateRef): Placement | undefined {
    const doc = this.mode.doc;
    const at = (r: MateRef): Placement | undefined => ('comp' in r ? this.mode.solved.get(r.comp) ?? doc.components.find((c) => c.id === (r as { comp: Id }).comp)?.placement : { p: [0, 0, 0], q: [0, 0, 0, 1] });
    const pa = at(a), pb = at(b);
    return pa && pb ? relativePlacement(pa, pb) : undefined;
  }

  /** The mate as it would be added. */
  private mate(): Mate | null {
    if (!this.type) return null;
    const base = { id: this.existing?.id ?? '', name: this.existing?.name ?? '', type: this.type, aligned: this.aligned, ...(this.existing?.suppressed ? { suppressed: true } : {}) };
    const mech = this.mech;
    if (mech) return this.mechMate(mech, base);
    if (this.refs.length !== 2) return null;
    let [a, b] = this.refs;
    if (this.type === 'lock') {
      a = 'comp' in a ? { comp: a.comp } : a;
      b = 'comp' in b ? { comp: b.comp } : b;
    }
    const limited = this.limitOn && (this.type === 'distance' || this.type === 'angle');
    const m: Mate = {
      ...base, a, b,
      ...(this.type === 'distance' || this.type === 'angle' ? { value: this.value } : {}),
      ...(limited ? { limit: { min: this.min, max: this.max } } : {}),
      ...(this.flip && (this.type === 'distance' || this.type === 'tangent') ? { flip: true } : {}),
    };
    if (this.type === 'lock') m.rel = this.relNow(a, b);
    return m;
  }

  private mechMate(t: MechanicalMateType, base: Omit<Mate, 'a' | 'b'>): Mate | null {
    const counts = MECH_BOXES[t].map((x) => x.count);
    if (this.refs.length !== counts[0] || (counts[1] && this.refs2.length !== counts[1])) return null;
    const [r0, r1] = this.refs;
    switch (t) {
      case 'hinge': {
        const [a2, b2] = this.hingeFaces();
        const keep = this.existing?.type === 'hinge' && this.existing.rel && JSON.stringify([this.existing.a, this.existing.b]) === JSON.stringify([r0, r1]);
        const rel = this.limitOn ? (keep ? this.existing!.rel : this.relNow(r0, r1)) : undefined;
        return { ...base, a: r0, b: r1, a2, b2, aligned2: this.aligned2, ...(this.limitOn ? { limit: { min: this.min, max: this.max } } : {}), ...(rel ? { rel } : {}) };
      }
      case 'gear': return { ...base, a: r0, b: r1, value: this.value, value2: this.value2, ...(this.by === 'ratio' ? { by: 'ratio' } : {}), ...(this.reverse ? { reverse: true } : {}) };
      case 'rackPinion': return { ...base, a: r0, b: r1, value: this.value, ...(this.by === 'revolution' ? { by: 'revolution' } : {}), ...(this.reverse ? { reverse: true } : {}) };
      case 'screw': return { ...base, a: r0, b: r1, value: this.value, ...(this.reverse ? { reverse: true } : {}) };
      case 'width': return { ...base, a: r0, a2: r1, b: this.refs2[0], b2: this.refs2[1] };
      case 'slot': return { ...base, a: r0, a2: r1, b: this.refs2[0] };
    }
  }

  private withMate(d: AssemblyDocument, m: Mate) {
    if (this.existing) d.mates = d.mates.map((x) => (x.id === m.id ? m : x));
    else {
      m.id = nextAsmId(d, 'm');
      // Limit mates are named for what they limit, as in "LimitDistance1".
      const kind = m.limit && m.type !== 'hinge' ? `Limit${MATE_LABELS[m.type]}` : MATE_LABELS[m.type];
      const n = d.mates.filter((x) => x.type === m.type && !!x.limit === !!m.limit).length + 1;
      let name = `${kind}${n}`;
      for (let k = n + 1; d.mates.some((x) => x.name === name); k++) name = `${kind}${k}`;
      m.name = name;
      d.mates.push(m);
    }
  }

  /** Shows where the components go with the mate, and whether it holds. */
  private update() {
    const m = this.mate();
    const mode = this.mode;
    if (!m) {
      const mech = this.mech;
      this.result.textContent = mech ? `Select ${MECH_BOXES[mech].map((b) => b.label.toLowerCase()).join(' and ')}.` : this.refs.length < 2 ? 'Select two entities to mate.' : '';
      this.result.className = 'pm-msg';
      mode.previewPlacements(null);
      return;
    }
    const d = structuredClone({ ...mode.doc, blobs: {} }) as AssemblyDocument;
    this.withMate(d, m);
    const r = mode.solveDoc(d);
    const id = this.existing?.id ?? d.mates[d.mates.length - 1].id;
    const problem = r.invalid.get(id) ?? (r.conflicts.has(id) ? 'This mate cannot hold with the existing mates (over defined). Change it, or delete or suppress a mate it conflicts with.' : null);
    if (problem) {
      this.result.className = 'pm-msg error';
      this.result.textContent = problem;
    } else {
      this.result.className = 'pm-msg info';
      this.result.textContent = r.status === 'full' ? 'The assembly is fully defined.' : `The mate holds. ${r.dof} degrees of freedom are left.`;
    }
    mode.previewPlacements(r.placements);
  }

  ok(): boolean {
    const m = this.mate();
    if (!m) { this.setMessage('error', this.mech ? `Select ${MECH_BOXES[this.mech].map((b) => b.label.toLowerCase()).join(' and ')}.` : 'Select two entities to mate.'); return false; }
    const d = structuredClone({ ...this.mode.doc, blobs: {} }) as AssemblyDocument;
    this.withMate(d, m);
    const r = this.mode.solveDoc(d);
    const id = this.existing?.id ?? d.mates[d.mates.length - 1].id;
    const problem = r.invalid.get(id);
    if (problem) { this.setMessage('error', problem); return false; }
    this.mode.previewPlacements(null);
    this.mode.commit(this.existing ? `Edit ${m.name}` : 'Add mate', (doc) => this.withMate(doc, m));
    return true;
  }

  cancel() {
    this.mode.previewPlacements(null);
  }

  get edited(): boolean {
    return (this.refs.length > 0 || this.refs2.length > 0) && !this.existing;
  }
}

// ---------- Move / Rotate Component ----------

export class MovePanel extends PropertyPanel {
  icon: string;
  title: string;
  confirm = false;
  private axis: 'x' | 'y' | 'z' = 'y';
  private delta: Vec3 = [0, 0, 0];
  private angle = 90;

  constructor(private mode: AssemblyMode, private rotate: boolean) {
    super();
    this.title = rotate ? 'Rotate Component' : 'Move Component';
    this.icon = rotate ? 'rotateComponent' : 'moveComponent';
    mode.rotateMode = rotate;
    this.helpText = rotate
      ? 'Drag a component to turn it; mates are kept (a component on a hinge turns about it). Fixed components do not move. Outside this command, Alt+drag turns a component too.'
      : 'Drag a component to move it; mates are kept, so a mated component slides or turns only as its mates allow. Fixed components do not move. Alt+drag turns a component.';
  }

  render(): HTMLElement[] {
    const app = this.mode.app;
    const ctx = app.unitContext();
    const sel = this.target();
    const apply = h('button', { class: 'btn small', type: 'button', disabled: !sel }, this.rotate ? 'Rotate' : 'Move');
    apply.addEventListener('click', () => this.apply());
    const fields = this.rotate
      ? [selectField('About axis', this.axis, [{ value: 'x', label: 'Assembly X' }, { value: 'y', label: 'Assembly Y' }, { value: 'z', label: 'Assembly Z' }], (v) => { this.axis = v; }),
        numberField({ label: 'Angle', icon: 'angle', value: this.angle, kind: 'angle', ctx, allowExpr: false, onChange: (v) => { this.angle = Number(v); } })]
      : (['X', 'Y', 'Z'] as const).map((k, i) => numberField({ label: `Delta ${k}`, value: this.delta[i], kind: 'length', ctx, allowExpr: false, onChange: (v) => { this.delta[i] = Number(v); } }));
    return [
      section(this.rotate ? 'Rotate by' : 'Move by', [
        h('p', { class: 'field-label' }, sel ? `Selected: ${sel.name}` : 'Select a floating component (a face of it, or its row in the tree) to move it by exact amounts.'),
        ...fields, apply,
      ]),
    ];
  }

  private target() {
    const it = this.mode.app.selection.items[0];
    const c = it?.kind === 'feature' ? this.mode.component(it.id) : it?.kind === 'face' ? this.mode.faceComponent(it.index) : it?.kind === 'edge' ? this.mode.edgeComponent(it.index) : undefined;
    return c && !c.fixed && !c.suppressed ? c : null;
  }

  private apply() {
    const c = this.target();
    if (!c) return;
    const mode = this.mode;
    const pl = mode.solved.get(c.id) ?? c.placement;
    const g = mode.geometryOf(c.part)?.bbox;
    const center: Vec3 = g ? scale(add(g.min, g.max), 0.5) : [0, 0, 0];
    let result;
    if (this.rotate) {
      const axis: Vec3 = this.axis === 'x' ? [1, 0, 0] : this.axis === 'y' ? [0, 1, 0] : [0, 0, 1];
      result = mode.dragSolve({ kind: 'rotate', body: c.id, q: qMul(qAxisAngle(axis, (this.angle * Math.PI) / 180), pl.q) }, mode.solved);
    } else {
      const target = add(add(pl.p, rotateLocal(pl.q, center)), this.delta);
      result = mode.dragSolve({ kind: 'move', body: c.id, local: center, target }, mode.solved);
    }
    mode.commitPlacements(this.rotate ? 'Rotate component' : 'Move component', result);
  }

  onPick(item: SelItem): boolean {
    this.mode.app.selection.set([item]);
    this.mode.app.refreshPanel();
    return true;
  }

  filter() {
    return { face: true, edge: true };
  }

  ok() { return true; }

  dispose() {
    this.mode.rotateMode = false;
  }
}

function rotateLocal(q: [number, number, number, number], v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

// ---------- Exploded view ----------

export class ExplodePanel extends PropertyPanel {
  title = 'Explode Step';
  icon = 'explode';
  private comps: Id[] = [];
  private dirKind: 'x' | 'y' | 'z' | 'pick' = 'y';
  private picked: Vec3 | null = null;
  private pickedLabel = '';
  private distance: Param = 50;
  private reverse = false;

  constructor(private mode: AssemblyMode, private existing: ExplodeStep | null = null) {
    super();
    this.helpText = 'Select the components to move, a direction (an assembly axis, or a face or straight edge) and how far. Explode/Collapse switches between the exploded and assembled views.';
    if (existing) {
      this.editingId = existing.id;
      this.title = `Explode Step: ${existing.name}`;
      this.comps = [...existing.comps];
      this.distance = existing.distance;
      const d = existing.dir;
      const axis = (['x', 'y', 'z'] as const).find((_, i) => Math.abs(Math.abs(d[i]) - 1) < 1e-9);
      if (axis) { this.dirKind = axis; this.reverse = d[['x', 'y', 'z'].indexOf(axis)] < 0; } else { this.dirKind = 'pick'; this.picked = d; this.pickedLabel = 'Direction of the step'; }
    } else {
      const sel = mode.app.selection.items.map((it) => this.compOf(it)).filter((x): x is Id => !!x);
      this.comps = [...new Set(sel)];
    }
  }

  private compOf(it: SelItem): Id | null {
    if (it.kind === 'feature' && this.mode.component(it.id)) return it.id;
    if (it.kind === 'face') return this.mode.faceComponent(it.index)?.id ?? null;
    if (it.kind === 'edge') return this.mode.edgeComponent(it.index)?.id ?? null;
    return null;
  }

  render(): HTMLElement[] {
    const ctx = this.mode.app.unitContext();
    const box = new SelectionBox(this, 'Components to explode', { face: true, feature: true }, (it) => {
      const id = this.compOf(it);
      return id ? { item: { kind: 'feature', id }, data: id, label: this.mode.component(id)!.name } : null;
    }, (items) => { this.comps = items.map((x) => x.data as Id); this.showStep(); }, { placeholder: 'Select components', icon: 'part' });
    box.setItems(this.comps.map((id) => ({ item: { kind: 'feature', id }, data: id, label: this.mode.component(id)?.name ?? id })));
    const dirBox = new SelectionBox(this, 'Direction from a face or edge', { face: true, edge: true }, (it) => {
      const f = it.kind === 'face' ? this.mode.app.faces[it.index] : null;
      const e = it.kind === 'edge' ? this.mode.app.edges[it.index] : null;
      const d = f?.normal ?? f?.axis?.d ?? e?.dir ?? e?.axis;
      if (!d) return null;
      return { item: it, data: d, label: f ? `Face (${f.type})` : `Edge (${e!.type})` };
    }, (items) => {
      const it = items[0];
      this.picked = it ? it.data as Vec3 : null;
      this.pickedLabel = it?.label ?? '';
      if (it) this.dirKind = 'pick';
      this.showStep();
      this.mode.app.refreshPanel();
    }, { single: true, placeholder: 'Optional: select a face or edge', icon: 'axis' });
    if (this.picked && this.dirKind === 'pick') dirBox.setItems([{ item: null, data: this.picked, label: this.pickedLabel }]);
    queueMicrotask(() => this.showStep());
    return [
      section('Components', [box.el]),
      section('Direction', [
        selectField('Explode direction', this.dirKind, [
          { value: 'x', label: 'Along X' }, { value: 'y', label: 'Along Y' }, { value: 'z', label: 'Along Z' }, { value: 'pick', label: 'Along the selected face or edge' },
        ], (v) => { this.dirKind = v; this.showStep(); }, 'axis'),
        dirBox.el,
        checkbox('Reverse direction', this.reverse, (v) => { this.reverse = v; this.showStep(); }),
        numberField({ label: 'Distance', icon: 'smartDimension', value: this.distance, kind: 'length', ctx, onChange: (v) => { this.distance = v; this.showStep(); } }),
      ]),
    ];
  }

  private dir(): Vec3 | null {
    const base: Vec3 | null = this.dirKind === 'x' ? [1, 0, 0] : this.dirKind === 'y' ? [0, 1, 0] : this.dirKind === 'z' ? [0, 0, 1] : this.picked;
    return base ? scale(normalize(base), this.reverse ? -1 : 1) : null;
  }

  private step(): ExplodeStep | null {
    const dir = this.dir();
    if (!dir || !this.comps.length) return null;
    return { id: this.existing?.id ?? '', name: this.existing?.name ?? '', comps: [...this.comps], dir, distance: this.distance };
  }

  private showStep() {
    this.mode.previewExplode(this.step(), this.existing?.id ?? null);
  }

  ok(): boolean {
    const s = this.step();
    if (!s) { this.setMessage('error', this.comps.length ? 'Choose a direction: select a face or edge, or an axis.' : 'Select the components to explode.'); return false; }
    this.mode.previewExplode(null, null);
    this.mode.commit(this.existing ? `Edit ${s.name}` : 'Add explode step', (d) => {
      if (this.existing) d.explode = d.explode.map((x) => (x.id === s.id ? s : x));
      else {
        s.id = nextAsmId(d, 'x');
        // The next number no step has (a step deleted before it leaves a gap).
        let k = d.explode.length + 1;
        while (d.explode.some((x) => x.name.toLowerCase() === `explode step${k}`)) k++;
        s.name = `Explode Step${k}`;
        d.explode.push(s);
      }
      d.exploded = true;
    }, false);
    return true;
  }

  cancel() {
    this.mode.previewExplode(null, null);
  }
}

// ---------- Interference ----------

export class InterferencePanel extends PropertyPanel {
  title = 'Interference Detection';
  icon = 'interference';
  confirm = false;
  private out = h('div', { class: 'sec-body' });
  private seq = 0;

  constructor(private mode: AssemblyMode) {
    super();
    this.helpText = 'Overlapping volumes are shown in red. Click a result to select its components.';
  }

  render(): HTMLElement[] {
    const again = h('button', { class: 'btn small', type: 'button' }, icon('rebuild', 14), 'Calculate again');
    again.addEventListener('click', () => void this.run());
    queueMicrotask(() => void this.run());
    return [section('Results', [this.out, again])];
  }

  async run() {
    const app = this.mode.app;
    const seq = ++this.seq;
    this.out.replaceChildren(h('div', { class: 'field-label', role: 'status' }, 'Calculating...'));
    await app.whenBuilt();
    if (seq !== this.seq) return;
    this.checked = this.key();
    let pairs: InterferencePair[];
    try {
      pairs = await app.kernel.assembly<InterferencePair[]>({ op: 'interference' });
    } catch (e) {
      if (seq !== this.seq) return;
      this.out.replaceChildren(h('div', { class: 'pm-msg error', role: 'alert' }, (e as Error).message));
      return;
    }
    if (seq !== this.seq || app.panel !== this) return;
    // The pairs are numbered as the worker's scene is.
    const comps = this.mode.sceneComps;
    const name = (i: number) => this.mode.component(comps[i])?.name ?? '?';
    const u = UNIT_SYSTEMS[app.store.doc.units];
    const vol = (v: number) => `${formatGroup([v / u.scale ** 3], Math.max(2, app.store.doc.decimals))[0]} ${u.length}³`;
    app.renderer.setPreview(mergeMeshes(pairs.map((p) => p.mesh)), 'tool', true);
    // Checked where the components are shown: exploded, they are apart.
    const exploded = this.mode.doc.exploded ? h('div', { class: 'pm-msg warn' }, 'The exploded view is shown: collapse it (Explode/Collapse) to check the assembled position.') : null;
    // Pairs whose overlap could not be computed are not called clear.
    const failed = pairs.filter((p) => p.failed);
    const found = pairs.filter((p) => !p.failed);
    const unchecked = failed.length
      ? h('div', { class: 'pm-msg error', role: 'alert' }, `Could not check ${failed.map((p) => `${name(p.a)} / ${name(p.b)}`).join(', ')}: the overlap could not be computed.`)
      : null;
    // Only solids are checked: say so when a part has surface bodies, so they are not taken as clear.
    const parts = new Set((this.mode.model?.comps ?? []).map((id) => this.mode.component(id)?.part));
    const surfaced = [...parts].some((p) => !!p && !!this.mode.geometryOf(p)?.faces.some((f) => f.body));
    const surfaces = surfaced ? h('div', { class: 'pm-msg info' }, 'Surface bodies are not checked: interference is found between solids only.') : null;
    const notes = [...(unchecked ? [unchecked] : []), ...(surfaces ? [surfaces] : []), ...(exploded ? [exploded] : [])];
    if (!found.length) {
      this.out.replaceChildren(...(failed.length ? [] : [h('div', { class: 'pm-msg info', role: 'status' }, 'No interference: no two components overlap.')]), ...notes);
      return;
    }
    const list = h('div', { class: 'file-list', role: 'list', 'aria-label': 'Interferences' });
    for (const p of found) {
      const b = h('button', { class: 'file-item', type: 'button' }, h('span', { 'aria-hidden': 'true', style: { color: 'var(--danger)' } }, icon('interference', 16)),
        h('span', { class: 'txt' }, h('span', { class: 'n' }, `${name(p.a)} and ${name(p.b)}`), h('span', { class: 'meta' }, `Interference volume ${vol(p.volume)}`)));
      b.addEventListener('click', () => app.selection.set([{ kind: 'feature', id: comps[p.a] }, { kind: 'feature', id: comps[p.b] }]));
      list.append(h('div', { class: 'file-row', role: 'listitem' }, b));
    }
    this.out.replaceChildren(h('div', { class: 'pm-msg warn', role: 'status' }, `${found.length} ${found.length === 1 ? 'interference' : 'interferences'} found.`), list, ...notes);
  }

  private timer = 0;
  private checked = '';

  /** The assembly changed under the panel: check it again (once it stops changing, a drag say). */
  private key(): string {
    return JSON.stringify([...this.mode.model?.comps ?? []].map((id) => [id, this.mode.shownPlacement(id)]));
  }

  onBuild() {
    if (this.key() === this.checked) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.run(), 400);
  }

  ok() { return true; }

  dispose() {
    clearTimeout(this.timer);
    this.seq++;
    this.mode.app.renderer.setPreview(null);
  }
}

function mergeMeshes(list: (MeshData | null)[]): MeshData | null {
  const ms = list.filter((m): m is MeshData => !!m && m.indices.length > 0);
  if (!ms.length) return null;
  const nv = ms.reduce((s, m) => s + m.positions.length, 0), ni = ms.reduce((s, m) => s + m.indices.length, 0);
  const positions = new Float32Array(nv), normals = new Float32Array(nv), indices = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const m of ms) {
    positions.set(m.positions, ov);
    normals.set(m.normals, ov);
    for (let k = 0; k < m.indices.length; k++) indices[oi + k] = m.indices[k] + ov / 3;
    ov += m.positions.length;
    oi += m.indices.length;
  }
  return { positions, normals, indices, vertexFace: new Float32Array(nv / 3), edgePositions: new Float32Array(0), edgeIds: new Float32Array(0), vertices: new Float32Array(0) };
}

// ---------- Bill of materials ----------

export async function bomDialog(mode: AssemblyMode) {
  const doc = mode.doc;
  const rows = assemblyBom(doc, (id) => mode.partDoc(id));
  const csv = bomCsv(rows);
  const table = rows.length
    ? h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['Item No.', 'Part Name', 'Quantity', 'Material'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, h('td', { class: 'num' }, String(r.item)), h('td', {}, r.name), h('td', { class: 'num' }, String(r.quantity)), h('td', {}, r.material || '—')))))
    : h('p', {}, 'The assembly has no components yet.');
  const v = await showDialog({
    title: 'Bill of Materials', wide: true, signal: mode.app.documentSignal,
    body: [h('p', { class: 'field-label' }, `${doc.name}: ${rows.reduce((s, r) => s + r.quantity, 0)} components of ${rows.length} ${rows.length === 1 ? 'part' : 'parts'} (suppressed components are not counted).`), table],
    buttons: [{ label: 'Copy', value: 'copy', left: true, disabled: !rows.length }, { label: 'Download CSV', value: 'csv', left: true, disabled: !rows.length }, { label: 'Close', value: 'close', primary: true }],
    onAction: async (value) => {
      if (value === 'copy') {
        try {
          // Tab-separated, as spreadsheets paste it (a comma in a part name stays in its cell).
          await navigator.clipboard.writeText(bomCsv(rows, '\t'));
          toast({ message: 'Copied to the clipboard', timeout: 1800 });
        } catch {
          toast({ kind: 'error', message: 'Could not copy to the clipboard.' });
        }
        return false;
      }
      return true;
    },
  });
  if (v === 'csv') download(csv, `${safeName(doc.name)} BOM.csv`, 'text/csv');
}

// ---------- Mass properties ----------

export async function assemblyMassDialog(mode: AssemblyMode) {
  const app = mode.app;
  await app.whenBuilt();
  // Hidden components weigh as much as shown ones (suppressed ones are left out).
  const comps = mode.sceneComps;
  if (!comps.length) { toast({ kind: 'warning', message: 'There is no solid body yet.' }); return; }
  const densities = comps.map((id) => mode.partDoc(mode.component(id)!.part)?.material?.density ?? 1000);
  let r: AsmMassResult | null;
  try {
    r = await app.kernel.assembly<AsmMassResult | null>({ op: 'mass', densities });
  } catch (e) {
    toast({ kind: 'error', message: (e as Error).message });
    return;
  }
  if (!r) { toast({ kind: 'warning', message: 'There is no solid body yet.' }); return; }
  const doc = app.store.doc;
  const u = UNIT_SYSTEMS[doc.units];
  const dec = Math.max(2, doc.decimals);
  const s = u.scale;
  const fmt = (v: number) => formatGroup([v], dec)[0];
  const unspecified = comps.filter((id) => !mode.partDoc(mode.component(id)!.part)?.material).map((id) => mode.component(id)!.name);
  // kg·mm² to mass units·length².
  const k = 1 / u.massScale / (s * s);
  const tensor = formatGroup(r.inertia.map((x) => x * k), 3);
  const rows: [string, string][] = [
    ['Mass', `${fmt(r.mass / u.massScale)} ${u.mass}`],
    ['Volume', `${fmt(r.volume / s ** 3)} ${u.length}³`],
    ['Surface area', `${fmt(r.area / s ** 2)} ${u.length}²`],
    ['Center of mass', `${formatGroup(r.center.map((c) => c / s), dec).join(', ')} ${u.length}`],
    ['Principal moments', formatGroup(r.principal.moments.map((x) => x * k), 3).join(', ')],
  ];
  await showDialog({
    title: 'Mass Properties', wide: true, signal: app.documentSignal,
    body: [
      ...(unspecified.length ? [h('p', { class: 'pm-msg warn' }, `No material on ${unspecified.join(', ')}: 1000 kg/m³ is used for ${unspecified.length === 1 ? 'it' : 'them'}.`)] : []),
      ...(r.open.length ? [h('p', { class: 'pm-msg warn' }, `${r.open.join(', ')} ${r.open.length === 1 ? 'has' : 'have'} no closed solid and ${r.open.length === 1 ? 'is' : 'are'} left out.`)] : []),
      h('p', { class: 'field-label' }, `Mass properties of ${doc.name}, every component with its part's material (hidden components count; suppressed ones do not).`),
      h('table', { class: 'table' }, h('tbody', {}, rows.map(([a, b]) => h('tr', {}, h('th', {}, a), h('td', { class: 'num' }, b))))),
      h('div', { class: 'field-label' }, `Moments of inertia about the center of mass, assembly axes (${u.mass}·${u.length}²)`),
      h('table', { class: 'table' }, h('tbody', {}, [0, 1, 2].map((row) => h('tr', {}, [0, 1, 2].map((c) => h('td', { class: 'num' }, `I${'xyz'[row]}${'xyz'[c]} = ${tensor[row * 3 + c]}`)))))),
    ],
    buttons: [{ label: 'Close', value: 'ok', primary: true }],
  });
}

// ---------- updating embedded parts ----------

/**
 * Reads the part files of the assembly again and takes the copies of those
 * saved since the assembly took its copy (`force`: every one that can be read).
 * Returns the names of the updated parts.
 */
export async function updateParts(mode: AssemblyMode, force = false): Promise<{ updated: string[]; missing: string[] }> {
  const app = mode.app;
  const signal = app.documentSignal;
  const doc = mode.doc;
  const updates: { id: Id; blob: Id; text: string; version: FileVersion | null; name: string }[] = [];
  const missing: string[] = [];
  const missingIds = new Set<Id>();
  for (const p of doc.parts) {
    const src = p.source as Location | null;
    if (!src) continue;
    let newer = force;
    if (!force) {
      if (src.type === 'cloud') {
        const now = await cloudVersion(src.path);
        if (now === null) { missing.push(p.name); missingIds.add(p.id); continue; }
        newer = !!now && (!p.version || versionChanged(now, p.version));
      } else {
        const e = readIndexEntry(src.id);
        if (!e) { missing.push(p.name); missingIds.add(p.id); continue; }
        newer = !p.version || e.modified > p.version.modified;
      }
    }
    if (!newer) continue;
    try {
      const read = await loadPart(src);
      if (signal.aborted) return { updated: [], missing };
      const pd = parseDocument(read.text);
      const text = serializeDocument(pd);
      if (text === doc.blobs[p.blob]) continue;
      updates.push({ id: p.id, blob: newPartBlobId(doc), text, version: read.version ?? localVersion(src), name: src.type === 'cloud' ? (src.path.split('/').pop() ?? p.name).replace(/\.(parametric|json)$/i, '') : pd.name });
    } catch {
      missing.push(p.name);
      missingIds.add(p.id);
    }
  }
  if (signal.aborted || app.assembly !== mode) return { updated: [], missing };
  mode.missingParts = missingIds;
  if (updates.length) {
    for (const u of updates) mode.doc.blobs[u.blob] = u.text;
    mode.commit('Update parts', (d) => {
      for (const u of updates) {
        const p = d.parts.find((x) => x.id === u.id);
        if (p) { p.blob = u.blob; p.version = u.version; p.name = u.name || p.name; }
      }
    });
  } else app.renderTrees();
  return { updated: updates.map((u) => u.name), missing };
}
