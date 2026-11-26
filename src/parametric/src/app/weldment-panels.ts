// Weldments: the Weldments tab's commands, the PropertyManager panels of
// Structural Member, Trim/Extend, End Cap and Gusset, and the cut list.

import type {
  CornerTreatment, EdgeRef, EndCapFeature, FaceRef, Feature, GussetFeature, MemberRef, SegmentRef, SketchFeature, StructuralMemberFeature,
  TrimExtendFeature, WeldBeadFeature,
} from '../model/types';
import { defaultName } from '../model/features';
import { MATERIALS } from '../model/materials';
import { PIERCE_POINTS, WELD_STANDARDS, WELD_TYPES, profileSizes, type WeldProfileType, type WeldStandard } from '../model/weldment-profiles';
import {
  type CutList, cutListCsv, cutListRows, memberKey, memberOfFace, newEndCap, newGusset, newStructuralMember, newTrimExtend, newWeldBead,
  sameMember, weldmentCutList,
} from '../model/weldments';
import { download, safeName } from '../platform/files';
import { h } from '../ui/dom';
import { icon } from '../ui/icons';
import { showDialog, toast } from '../ui/overlay';
import type { App } from './app';
import type { Command } from './commands';
import { FeaturePanel } from './panels';
import { type PropertyPanel, SelectionBox, type SelBoxItem, checkbox, numberField, section, segmented, selectField } from './pm';
import { type SelItem, edgeRef, faceRef } from './selection';
import type { RibbonTab } from './shell';

// ---------- labels and picks ----------

/** "Line 3 of Sketch1": lines and arcs numbered in their sketch's drawing order. */
function segmentLabel(app: App, s: SegmentRef): string {
  const sk = app.store.feature(s.sketch);
  if (sk?.type !== 'sketch') return 'Missing segment';
  const e = sk.entities.find((x) => x.id === s.entity);
  if (!e || (e.t !== 'line' && e.t !== 'arc')) return `Missing segment of ${sk.name}`;
  const n = sk.entities.filter((x) => x.t === e.t).indexOf(e) + 1;
  return `${e.t === 'arc' ? 'Arc' : 'Line'} ${n} of ${sk.name}`;
}

/** The lines and arcs of a sketch (member paths). */
function sketchSegments(sk: SketchFeature): SegmentRef[] {
  return sk.entities.filter((e) => e.t === 'line' || e.t === 'arc').map((e) => ({ sketch: sk.id, entity: e.id }));
}

function memberLabel(app: App, r: MemberRef): string {
  const f = app.store.feature(r.feature);
  const [sketch, entity] = r.member.split('/');
  return `${f?.name ?? 'Member'}: ${segmentLabel(app, { sketch, entity })}`;
}

/** A member in a selection box, its faces highlighted in the graphics area. */
function memberItem(app: App, m: MemberRef): SelBoxItem {
  return {
    item: null, data: m, label: memberLabel(app, m),
    highlights: () => app.faces.flatMap((f, index) => {
      const r = memberOfFace(f.name);
      return r && sameMember(r, m) ? [{ kind: 'face' as const, index, name: f.name }] : [];
    }),
  };
}

/** A face of a structural member, as the member. */
const toMember = (app: App) => (it: SelItem): SelBoxItem | null => {
  if (it.kind !== 'face') return null;
  const f = app.faces[it.index];
  const m = f ? memberOfFace(f.name) : null;
  return m ? memberItem(app, m) : null;
};

/** A planar face, labelled with the feature (and member) it belongs to. */
const toPlanarFace = (app: App, membersOnly = false) => (it: SelItem): SelBoxItem | null => {
  if (it.kind !== 'face') return null;
  const f = app.faces[it.index];
  if (!f || f.type !== 'plane') return null;
  const m = memberOfFace(f.name);
  if (membersOnly && !m) return null;
  const owner = app.store.feature(f.feature);
  return { item: it, data: faceRef(f), label: m ? `Face of ${memberLabel(app, m)}` : `Face <${it.index + 1}>${owner ? ` of ${owner.name}` : ''}` };
};

function faceItems(app: App, refs: FaceRef[]): SelBoxItem[] {
  return refs.map((r) => {
    const m = memberOfFace(r.name);
    return { item: { kind: 'face', index: app.faces.findIndex((f) => f.name === r.name), name: r.name }, data: r, label: m ? `Face of ${memberLabel(app, m)}` : 'Face' };
  });
}

/** Default profile for the part's units: inch parts get ANSI sizes. */
function defaultProfile(app: App): Pick<StructuralMemberFeature, 'standard' | 'profile' | 'size'> {
  return app.store.doc.units === 'IPS' ? { standard: 'ansi', profile: 'squareTube', size: '2x2x1/8' } : { standard: 'iso', profile: 'squareTube', size: '40x40x3' };
}

// ---------- structural member ----------

export class StructuralMemberPanel extends FeaturePanel<StructuralMemberFeature> {
  private groupBoxes: SelectionBox[] = [];
  private groupsEl: HTMLElement = h('div');

  constructor(app: App, f: StructuralMemberFeature, editing: boolean) {
    super(app, f, editing);
    this.helpText = 'Select sketch lines and arcs for each group. Members of a group meet at the corner treatment; later groups are trimmed to earlier ones.';
  }

  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    if (!f.groups.length) f.groups.push({ segments: [] });
    // Standard, type and size: the size list follows the other two.
    const sizeWrap = h('div');
    const fillSizes = () => {
      const sizes = profileSizes(f.standard as WeldStandard, f.profile as WeldProfileType);
      if (!sizes.some((s) => s.id === f.size)) f.size = sizes[Math.min(sizes.length - 1, Math.floor(sizes.length / 3))]?.id ?? '';
      sizeWrap.replaceChildren(selectField('Size', f.size, sizes.map((s) => ({ value: s.id, label: s.label })), (v) => { f.size = v; this.changed(); }));
    };
    fillSizes();
    const profile = section('Selections', [
      selectField('Standard', f.standard as WeldStandard, WELD_STANDARDS, (v) => { f.standard = v; fillSizes(); this.changed(); }),
      selectField('Type', f.profile as WeldProfileType, WELD_TYPES, (v) => { f.profile = v; fillSizes(); this.changed(); }),
      sizeWrap,
    ], { icon: 'structuralMember' });
    this.groupBoxes = [];
    this.groupsEl = h('div', { class: 'weld-groups' });
    f.groups.forEach((_, i) => this.groupsEl.append(this.groupEl(i)));
    const newGroup = h('button', { class: 'btn small', type: 'button' }, icon('plus', 14), 'New Group');
    newGroup.addEventListener('click', () => {
      f.groups.push({ segments: [] });
      this.groupsEl.append(this.groupEl(f.groups.length - 1));
      this.activate(this.groupBoxes[this.groupBoxes.length - 1]);
      this.changed();
    });
    const gap = numberField({ label: 'Gap', icon: 'ruler', value: f.gap, kind: 'length', ctx, min: 0, onChange: (v) => { f.gap = v; this.changed(); } });
    const gap2 = numberField({ label: 'Gap between groups', icon: 'ruler', value: f.gap2, kind: 'length', ctx, min: 0, onChange: (v) => { f.gap2 = v; this.changed(); } });
    gap2.hidden = !f.trimGroups;
    const corners: { value: CornerTreatment; label: string }[] = [
      { value: 'miter', label: 'End miter' }, { value: 'butt1', label: 'End butt 1' }, { value: 'butt2', label: 'End butt 2' },
    ];
    return [
      profile,
      section('Groups', [this.groupsEl, h('div', { class: 'row' }, newGroup)]),
      section('Corner Treatment', [
        segmented('Corner treatment', f.corner, corners, (v) => { f.corner = v; this.changed(); }),
        h('p', { class: 'field-label' }, 'At corners within a group. End butt 1: the arriving member runs through; End butt 2: the next one does.'),
        gap,
        checkbox('Trim and extend members between groups', f.trimGroups, (v) => { f.trimGroups = v; gap2.hidden = !v; this.changed(); }),
        gap2,
      ]),
      section('Profile Placement', [
        numberField({ label: 'Rotation angle', icon: 'reset', value: f.rotation, kind: 'angle', ctx, onChange: (v) => { f.rotation = v; this.changed(); } }),
        checkbox('Mirror profile', f.mirror, (v) => { f.mirror = v; this.changed(); }),
        selectField('Pierce point', f.pierce as (typeof PIERCE_POINTS)[number]['value'], PIERCE_POINTS, (v) => { f.pierce = v; this.changed(); }),
      ]),
    ];
  }

  private groupEl(i: number): HTMLElement {
    const f = this.f;
    const box = new SelectionBox(this, `Group ${i + 1}`, { sketchSegment: true, feature: true, sketch: true }, (it) => this.toSegment(it), (items) => {
      f.groups[this.groupBoxes.indexOf(box)].segments = items.map((x) => x.data as SegmentRef);
      this.changed();
    }, { placeholder: 'Select sketch lines and arcs', icon: 'line' });
    box.setItems(f.groups[i].segments.map((s) => ({ item: { kind: 'skseg', sketch: s.sketch, entity: s.entity }, data: s, label: segmentLabel(this.app, s) })));
    this.groupBoxes.push(box);
    const remove = h('button', { class: 'icon-btn weld-group-rm', type: 'button', 'aria-label': `Remove group ${i + 1}` }, icon('trash', 14));
    // In the group's heading, beside its name.
    box.el.firstElementChild?.append(remove);
    const wrap = h('div', { class: 'weld-group' }, box.el);
    remove.addEventListener('click', () => {
      const k = this.groupBoxes.indexOf(box);
      if (f.groups.length === 1) { box.setItems([], true); return; }
      f.groups.splice(k, 1);
      this.groupBoxes.splice(k, 1);
      this.boxes.splice(this.boxes.indexOf(box), 1);
      wrap.remove();
      // The other groups are numbered again.
      this.groupBoxes.forEach((b, j) => {
        const label = b.el.querySelector('.field-label');
        if (label) label.textContent = `Group ${j + 1}`;
        b.el.querySelector('.weld-group-rm')?.setAttribute('aria-label', `Remove group ${j + 1}`);
        b.el.querySelector('.selbox')?.setAttribute('aria-label', `Group ${j + 1}`);
      });
      if (this.activeBox === box) this.activate(this.groupBoxes[Math.max(0, k - 1)]);
      this.changed();
    });
    return wrap;
  }

  private toSegment(it: SelItem): SelBoxItem | null {
    if (it.kind !== 'skseg') return null;
    const s: SegmentRef = { sketch: it.sketch, entity: it.entity };
    // A segment belongs to one group: picked for another, it moves there.
    this.takeFromOtherGroups([s]);
    return { item: it, data: s, label: segmentLabel(this.app, s) };
  }

  private takeFromOtherGroups(segs: SegmentRef[], keep = this.activeBox) {
    const keys = new Set(segs.map(memberKey));
    for (const b of this.groupBoxes) {
      if (b === keep) continue;
      const left = b.items.filter((x) => !keys.has(memberKey(x.data as SegmentRef)));
      if (left.length !== b.items.length) b.setItems(left, true);
    }
  }

  onPick(item: SelItem, additive: boolean): boolean {
    // A sketch picked in the tree adds all its lines and arcs to the active group.
    if (item.kind === 'feature' && this.activeBox && this.groupBoxes.includes(this.activeBox)) {
      const sk = this.app.store.feature(item.id);
      if (sk?.type !== 'sketch') return false;
      const box = this.activeBox;
      const have = new Set(box.items.map((x) => memberKey(x.data as SegmentRef)));
      const add = sketchSegments(sk).filter((s) => !have.has(memberKey(s)));
      if (!add.length) return true;
      this.takeFromOtherGroups(add, box);
      box.setItems([...box.items, ...add.map((s) => ({ item: { kind: 'skseg', sketch: s.sketch, entity: s.entity } as SelItem, data: s, label: segmentLabel(this.app, s) }))], true);
      return true;
    }
    return super.onPick(item, additive);
  }

  protected validate() {
    return this.f.groups.some((g) => g.segments.length) ? null : 'Select sketch lines or arcs for the members';
  }

  preview() {
    return this.f.groups.some((g) => g.segments.length) ? this.f : null;
  }

  ok(): boolean {
    const doc = this.app.store.doc;
    const steel = MATERIALS.find((m) => m.name === 'Plain Carbon Steel');
    // The first member of a part without a material makes it steel (one undo step with the member).
    if (this.editingId || doc.material || !steel || doc.features.some((x) => x.type === 'structuralMember') || this.validate()) return super.ok();
    const f = this.f;
    this.app.store.change(`Add ${f.name}`, (d) => {
      const at = d.rollback == null ? d.features.length : d.rollback;
      d.features.splice(at, 0, f);
      if (d.rollback != null) d.rollback = at + 1;
      d.material = { ...steel };
    });
    toast({ kind: 'info', message: `Material set to ${steel.name} for the weldment. Change it with Edit Material.`, timeout: 4000 });
    return true;
  }
}

// ---------- trim / extend ----------

export class TrimExtendPanel extends FeaturePanel<TrimExtendFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    const members = new SelectionBox(this, 'Bodies to be trimmed', { face: true }, toMember(this.app), (items) => {
      f.members = dedupe(items.map((x) => x.data as MemberRef));
      this.changed();
    }, { placeholder: 'Select faces of the members to trim', icon: 'structuralMember' });
    members.setItems(f.members.map((m) => memberItem(this.app, m)));
    const faces = new SelectionBox(this, 'Face/Plane', { face: true, planarOnly: true }, toPlanarFace(this.app), (items) => { f.faces = items.map((x) => x.data as FaceRef); this.changed(); }, { placeholder: 'Select a planar face to trim to', icon: 'plane' });
    faces.setItems(faceItems(this.app, f.faces));
    const bounds = new SelectionBox(this, 'Bodies', { face: true }, toMember(this.app), (items) => {
      f.boundaryMembers = dedupe(items.map((x) => x.data as MemberRef));
      this.changed();
    }, { placeholder: 'Select faces of the members to trim to', icon: 'structuralMember' });
    bounds.setItems(f.boundaryMembers.map((m) => memberItem(this.app, m)));
    const coped = checkbox('Coped cut (follow the boundary member)', f.coped, (v) => { f.coped = v; this.changed(); });
    const sync = () => {
      faces.el.hidden = f.boundary !== 'faces';
      bounds.el.hidden = f.boundary !== 'members';
      coped.hidden = f.boundary !== 'members';
    };
    sync();
    return [
      section('Bodies to Be Trimmed', [members.el]),
      section('Trimming Boundary', [
        segmented('Trimming boundary', f.boundary, [{ value: 'faces' as const, label: 'Face/Plane' }, { value: 'members' as const, label: 'Bodies' }], (v) => {
          f.boundary = v;
          sync();
          this.activate(v === 'faces' ? faces : bounds);
          this.changed();
        }),
        faces.el, bounds.el,
        checkbox('Allow extension', f.allowExtension, (v) => { f.allowExtension = v; this.changed(); }),
        coped,
        numberField({ label: 'Gap', icon: 'ruler', value: f.gap, kind: 'length', ctx, min: 0, onChange: (v) => { f.gap = v; this.changed(); } }),
      ]),
    ];
  }

  protected validate() {
    if (!this.f.members.length) return 'Select the members to trim or extend';
    return (this.f.boundary === 'faces' ? this.f.faces.length : this.f.boundaryMembers.length) ? null : 'Select the boundary to trim to';
  }

  preview() {
    return this.validate() ? null : this.f;
  }
}

function dedupe(refs: MemberRef[]): MemberRef[] {
  return refs.filter((r, i) => refs.findIndex((x) => sameMember(x, r)) === i);
}

// ---------- end cap ----------

export class EndCapPanel extends FeaturePanel<EndCapFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    const faces = new SelectionBox(this, 'Faces', { face: true, planarOnly: true }, toPlanarFace(this.app, true), (items) => { f.faces = items.map((x) => x.data as FaceRef); this.changed(); }, { placeholder: 'Select end faces of tubes or pipes', icon: 'endCap' });
    faces.setItems(faceItems(this.app, f.faces));
    return [
      section('Parameters', [
        faces.el,
        segmented('Thickness direction', f.inward ? 'inward' : 'outward', [{ value: 'outward' as const, label: 'Outward' }, { value: 'inward' as const, label: 'Inward' }], (v) => { f.inward = v === 'inward'; this.changed(); }),
        numberField({ label: 'Thickness', icon: 'ruler', value: f.thickness, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.thickness = v; this.changed(); } }),
        numberField({ label: 'Offset', icon: 'offset', value: f.offset, kind: 'length', ctx, min: 0, onChange: (v) => { f.offset = v; this.changed(); } }),
        h('p', { class: 'field-label' }, 'Offset sets the cap\'s edge in from the edge of the tube (inward caps start inside the wall).'),
      ]),
    ];
  }

  protected validate() {
    return this.f.faces.length ? null : 'Select end faces of tube or pipe members';
  }

  preview() {
    return this.f.faces.length ? this.f : null;
  }
}

// ---------- gusset ----------

export class GussetPanel extends FeaturePanel<GussetFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    const faces = new SelectionBox(this, 'Supporting faces', { face: true, planarOnly: true }, toPlanarFace(this.app), (items) => {
      f.faces = items.map((x) => x.data as FaceRef).slice(-2);
      if (items.length > 2) faces.setItems(items.slice(-2));
      this.changed();
    }, { placeholder: 'Select two planar faces at a corner', icon: 'gusset' });
    faces.setItems(faceItems(this.app, f.faces));
    const d3 = numberField({ label: 'Distance 3', icon: 'ruler', value: f.d3, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.d3 = v; this.changed(); } });
    d3.hidden = f.shape !== 'polygonal';
    return [
      section('Supporting Faces', [faces.el]),
      section('Profile', [
        segmented('Profile', f.shape, [{ value: 'triangular' as const, label: 'Triangular' }, { value: 'polygonal' as const, label: 'Polygonal' }], (v) => { f.shape = v; d3.hidden = v !== 'polygonal'; this.changed(); }),
        numberField({ label: 'Distance 1', icon: 'ruler', value: f.d1, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.d1 = v; this.changed(); } }),
        numberField({ label: 'Distance 2', icon: 'ruler', value: f.d2, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.d2 = v; this.changed(); } }),
        d3,
        numberField({ label: 'Thickness', icon: 'ruler', value: f.thickness, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.thickness = v; this.changed(); } }),
        selectField('Location', f.location, [{ value: 'center' as const, label: 'Centered' }, { value: 'side1' as const, label: 'Side 1' }, { value: 'side2' as const, label: 'Side 2' }], (v) => { f.location = v; this.changed(); }),
        numberField({ label: 'Chamfer distance', icon: 'chamfer', value: f.chamfer, kind: 'length', ctx, min: 0, onChange: (v) => { f.chamfer = v; this.changed(); } }),
      ]),
    ];
  }

  protected validate() {
    return this.f.faces.length === 2 ? null : 'Select two planar faces that meet at a corner';
  }

  preview() {
    return this.f.faces.length === 2 ? this.f : null;
  }
}

// ---------- fillet bead ----------

export class WeldBeadPanel extends FeaturePanel<WeldBeadFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const edges = new SelectionBox(this, 'Edges', { edge: true }, (it) => {
      if (it.kind !== 'edge') return null;
      const e = this.app.edges[it.index];
      if (!e || e.type !== 'line') return null;
      return { item: it, data: edgeRef(e), label: `Edge <${it.index + 1}>` };
    }, (items) => { f.edges = items.map((x) => x.data as EdgeRef); this.changed(); }, { placeholder: 'Select straight inside corner edges', icon: 'weldBead' });
    edges.setItems(f.edges.map((r) => ({ item: { kind: 'edge', index: this.app.edges.findIndex((e) => e.name === r.name), name: r.name }, data: r, label: 'Edge (line)' })));
    return [section('Settings', [
      edges.el,
      numberField({ label: 'Bead size', icon: 'ruler', value: f.size, kind: 'length', ctx: this.ctx(), min: 1e-6, onChange: (v) => { f.size = v; this.changed(); } }),
      h('p', { class: 'field-label' }, 'A solid fillet weld with equal legs along each edge, where two flat faces meet at an inside corner.'),
    ])];
  }

  protected validate() {
    return this.f.edges.length ? null : 'Select the inside corner edges to weld';
  }

  preview() {
    return this.f.edges.length ? this.f : null;
  }
}

// ---------- factory ----------

export function weldmentPanelFor(app: App, f: Feature, editing: boolean): PropertyPanel | null {
  switch (f.type) {
    case 'structuralMember': return new StructuralMemberPanel(app, f, editing);
    case 'trimExtend': return new TrimExtendPanel(app, f, editing);
    case 'endCap': return new EndCapPanel(app, f, editing);
    case 'gusset': return new GussetPanel(app, f, editing);
    case 'weldBead': return new WeldBeadPanel(app, f, editing);
    default: return null;
  }
}

/** A new weldment feature's panel, filled from the selection. */
export function startWeldment(app: App, type: Feature['type']): PropertyPanel | null {
  const doc = app.store.doc;
  const id = app.store.nextId('f');
  const name = defaultName(doc, type);
  const size = app.typicalSize();
  const sel = app.selection.items;
  const planar = app.selectedFaceRefs().filter((r) => r.sig.type === 'plane');
  let f: Feature;
  switch (type) {
    case 'structuralMember': {
      // Picked lines and arcs, or every line and arc of the picked sketches, make the first group.
      const segs: SegmentRef[] = [];
      for (const it of sel) {
        if (it.kind === 'skseg') segs.push({ sketch: it.sketch, entity: it.entity });
        else if (it.kind === 'feature') { const sk = app.store.feature(it.id); if (sk?.type === 'sketch') segs.push(...sketchSegments(sk)); }
      }
      // A line picked as well as its sketch is one member.
      const uniq = segs.filter((s, i) => segs.findIndex((x) => memberKey(x) === memberKey(s)) === i);
      f = { ...newStructuralMember(id, name, uniq.length ? [uniq] : []), ...defaultProfile(app) };
      break;
    }
    case 'trimExtend': {
      const x = newTrimExtend(id, name);
      x.members = dedupe(sel.flatMap((it) => (it.kind === 'face' ? [memberOfFace(app.faces[it.index]?.name ?? '')] : [])).filter((m): m is MemberRef => !!m));
      f = x;
      break;
    }
    case 'endCap': {
      const x = newEndCap(id, name, Math.max(size / 50, 1));
      x.faces = planar.filter((r) => memberOfFace(r.name));
      f = x;
      break;
    }
    case 'gusset': {
      const x = newGusset(id, name, Math.max(size / 8, 5), Math.max(size / 50, 1));
      x.faces = planar.slice(0, 2);
      f = x;
      break;
    }
    case 'weldBead': {
      const x = newWeldBead(id, name, Math.max(size / 50, 1));
      x.edges = app.selection.ofKind('edge').map((s) => app.edges[s.index]).filter((e) => e?.type === 'line').map(edgeRef);
      f = x;
      break;
    }
    default: return null;
  }
  return weldmentPanelFor(app, f, false);
}

// ---------- cut list ----------

export function cutListOf(app: App): CutList {
  return weldmentCutList(app.store.doc, app.weldments);
}

/**
 * The cut list after the latest rebuild, with each member's mass less what
 * later cuts and holes took from it (asked of the kernel only here, when the
 * list is opened or exported: never on a rebuild).
 */
export async function exactCutList(app: App): Promise<CutList> {
  await app.whenBuilt();
  let members = app.weldments;
  let approximate = false;
  try {
    const v = await app.kernel.weldVolumes();
    approximate = v.approximate;
    const vol = new Map(v.volumes.map((x) => [`${x.feature}|${x.member}`, x.volume]));
    if (vol.size) members = members.map((m) => ({ ...m, volume: vol.get(`${m.feature}|${m.member}`) ?? m.volume }));
  } catch {
    // The kernel restarted: the masses as built, said to be so.
    approximate = true;
  }
  const list = weldmentCutList(app.store.doc, members);
  if (approximate) list.massApproximate = true;
  return list;
}

let cutListOpen = false;

export async function cutListDialog(app: App) {
  if (cutListOpen) return;
  cutListOpen = true;
  try {
    const list = await exactCutList(app);
    const doc = app.store.doc;
    if (!list.items.length) {
      // The tree's Cut list row stays while the members fail to build or are rolled back.
      const message = doc.features.some((x) => x.type === 'structuralMember')
        ? 'No structural members are built: check the Structural Member features for errors, suppression or the rollback position.'
        : 'The part has no structural members yet. Add them with Structural Member in the Weldments tab.';
      toast({ kind: 'info', message });
      return;
    }
    const { header, rows, total } = cutListRows(list, doc.units, doc.decimals);
    const numeric = (i: number) => i !== 2;
    const table = h('table', { class: 'table weld-cutlist' },
      h('caption', { class: 'sr-only' }, 'Cut list'),
      h('thead', {}, h('tr', {}, ...header.map((x, i) => h('th', { scope: 'col', class: numeric(i) ? 'num' : '' }, x)))),
      h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((x, i) => h('td', { class: numeric(i) ? 'num' : '' }, x))))),
      h('tfoot', {}, h('tr', {}, ...total.map((x, i) => h(i === 2 ? 'th' : 'td', { class: numeric(i) ? 'num' : '', ...(i === 2 ? { scope: 'row' } : {}) }, x)))),
    );
    const limit = app.buildLimit();
    const rolledTo = limit < doc.features.length ? doc.features[limit] : null;
    const note = (doc.material
      ? `Mass from ${doc.material.name} (${doc.material.density} kg/m³), less later cuts and holes.`
      : 'No material is set: mass uses 1000 kg/m³. Set one with Edit Material.')
      + (list.massApproximate ? ' Later fillets, shells and other changes to the members are not in the mass.' : '');
    const v = await showDialog({
      title: 'Cut List', signal: app.documentSignal, wide: true,
      body: [
        h('p', {}, `${list.count} ${list.count === 1 ? 'member' : 'members'} in ${list.items.length} ${list.items.length === 1 ? 'item' : 'items'}. Lengths are overall (long point to long point); angles are the end cuts from square. ${note}`),
        ...(rolledTo ? [h('p', { class: 'field-label' }, `The part is rolled back to before ${rolledTo.name}: members from there on are not listed.`)] : []),
        h('div', { class: 'weld-cutlist-wrap', tabindex: '0', role: 'region', 'aria-label': 'Cut list table' }, table),
      ],
      buttons: [{ label: 'Export CSV', value: 'csv', left: true }, { label: 'Close', value: 'close', primary: true }],
      onAction: (a) => {
        if (a === 'csv') { exportCutList(app, list); return false; }
      },
    });
    void v;
  } finally {
    cutListOpen = false;
  }
}

function exportCutList(app: App, list: CutList) {
  const doc = app.store.doc;
  // A byte order mark lets spreadsheet programs read the degree signs.
  download('﻿' + cutListCsv(list, doc.units, doc.decimals), `${safeName(doc.name)} cut list.csv`, 'text/csv');
}

// ---------- commands and ribbon ----------

export function weldmentCommands(app: App): Command[] {
  const hasMembers = () => app.weldments.length > 0;
  const start = (type: Feature['type']) => () => {
    if (app.sketchEditor) {
      // Finish the sketch first: its lines become member paths.
      const id = app.sketchEditor.sketchId;
      app.exitSketch(true);
      app.selection.set([{ kind: 'feature', id }]);
    }
    const p = startWeldment(app, type);
    if (p) void app.openPanel(p);
  };
  return [
    {
      id: 'structuralMember', label: 'Structural Member', icon: 'structuralMember', keywords: 'weldment frame tube pipe beam channel angle profile steel',
      description: 'Sweep a standard profile (tube, pipe, angle, channel, beam, bar) along sketch lines and arcs.', run: start('structuralMember'),
    },
    {
      id: 'trimExtend', label: 'Trim / Extend', icon: 'trimExtend', keywords: 'weldment trim extend cope member',
      description: 'Trim or extend structural members to a face or to other members.', enabled: hasMembers, run: start('trimExtend'),
    },
    {
      id: 'endCap', label: 'End Cap', icon: 'endCap', keywords: 'weldment cap plug tube end',
      description: 'Close the open end of a tube or pipe member with a plate.', enabled: hasMembers, run: start('endCap'),
    },
    {
      id: 'gusset', label: 'Gusset', icon: 'gusset', keywords: 'weldment gusset stiffener plate corner bracket',
      description: 'Add a triangular or polygonal plate between two faces at a corner.', enabled: () => !!app.bbox, run: start('gusset'),
    },
    {
      id: 'weldBead', label: 'Fillet Bead', icon: 'weldBead', keywords: 'weldment weld bead fillet weld seam',
      description: 'Add a solid fillet weld along inside corner edges.', enabled: () => !!app.bbox, run: start('weldBead'),
    },
    {
      id: 'cutList', label: 'Cut List', icon: 'cutList', keywords: 'weldment bill of materials bom lengths csv',
      description: 'List the structural members by profile, length and end angles, and export it as CSV.',
      // With members that fail to build too, so the tree's Cut list row says why it is empty.
      enabled: () => hasMembers() || app.store.doc.features.some((x) => x.type === 'structuralMember'), run: () => cutListDialog(app),
    },
    {
      id: 'cutListCsv', label: 'Export Cut List (CSV)', icon: 'download', keywords: 'weldment csv', enabled: hasMembers,
      // After the rebuild of the latest edit, as the dialog does.
      run: async () => exportCutList(app, await exactCutList(app)),
    },
  ];
}

export const WELDMENTS_TAB: RibbonTab = {
  id: 'weldments', label: 'Weldments',
  groups: [
    [{ cmd: 'structuralMember' }, { cmd: 'trimExtend' }],
    [{ stack: [{ cmd: 'endCap' }, { cmd: 'gusset' }, { cmd: 'weldBead' }] }],
    [{ cmd: 'cutList' }],
    [{ cmd: 'sketch' }],
  ],
};
