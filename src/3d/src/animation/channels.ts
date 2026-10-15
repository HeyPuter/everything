// Channel hierarchy shared by the animation editors (Dope Sheet, Graph Editor,
// Drivers, NLA): Summary ▸ Object ▸ Action ▸ Group ▸ F-Curve, shape keys,
// drivers and NLA tracks. Pure document logic (no DOM) so it can be unit tested.
import type { ActionData, DocumentData, Driver, FCurve, NlaTrack, ObjectData, ShapeKey } from '../data/types';
import { channelLabel, dataBlock } from '../data/rna';
import { driverAction } from './drivercurves';

export type SpaceKind = 'DOPESHEET' | 'ACTION' | 'SHAPEKEY' | 'GRAPH' | 'DRIVERS' | 'NLA';
export type ChannelKind = 'SUMMARY' | 'OBJECT' | 'ACTION' | 'GROUP' | 'FCURVE' | 'SHAPEKEY' | 'DRIVERS' | 'DRIVER' | 'NLA_ACTION' | 'NLA_TRACK';

export interface CurveRef {
  ob: ObjectData;
  action: ActionData;
  fc: FCurve;
}

export interface Channel {
  key: string;
  kind: ChannelKind;
  depth: number;
  label: string;
  icon?: string;
  ob?: ObjectData;
  action?: ActionData;
  group?: string;
  fc?: FCurve;
  shapeKey?: ShapeKey;
  driver?: Driver;
  driverIndex?: number;
  track?: NlaTrack;
  trackIndex?: number;
  /** the channel's property can't be found */
  error?: boolean;
  /** F-Curves summarized by this row (keys drawn/edited through it) */
  curves: CurveRef[];
  expandable: boolean;
  expanded: boolean;
}

export interface ChannelFilter {
  onlySelected: boolean;
  showHidden: boolean;
  search: string;
  onlyErrors?: boolean;
  isVisible: (ob: ObjectData) => boolean;
  activeObject: ObjectData | null;
  /** F-Curves whose property can't be found ("Only Show Errors", error highlight) */
  curveError?: (ob: ObjectData, fc: FCurve) => boolean;
  /** driver error lookup (Drivers editor "Only Show Errors") */
  driverError?: (ob: ObjectData, d: Driver) => string | null;
}

/** Expansion and non-data selection state (shared by all animation editors). */
export const channelState = {
  expanded: new Map<string, boolean>(),
  selectedGroups: new Set<string>(),
  selectedDrivers: new Set<string>(),
  selectedShapeKeys: new Set<string>(),
};

const DEFAULT_EXPANDED: Partial<Record<ChannelKind, boolean>> = {
  SUMMARY: true,
  OBJECT: true,
  ACTION: false,
  GROUP: true,
  DRIVERS: true,
};

export function isExpanded(key: string, kind: ChannelKind) {
  return channelState.expanded.get(key) ?? DEFAULT_EXPANDED[kind] ?? false;
}
export function setExpanded(key: string, value: boolean) {
  channelState.expanded.set(key, value);
}

export const groupKey = (action: ActionData, name: string) => `grp:${action.id}:${name}`;
export const curveKey = (ob: ObjectData, action: ActionData, fc: FCurve) => `fc:${ob.id}:${action.id}:${fc.data_path}:${fc.array_index}`;
export const driverKey = (ob: ObjectData, d: Driver) => `drv:${ob.id}:${d.data_path}:${d.array_index}`;

export function objectIcon(ob: ObjectData) {
  const m: Record<string, string> = {
    MESH: 'outliner_ob_mesh',
    CAMERA: 'outliner_ob_camera',
    LIGHT: 'outliner_ob_light',
    EMPTY: 'outliner_ob_empty',
    ARMATURE: 'outliner_ob_armature',
    CURVE: 'outliner_ob_curve',
    FONT: 'outliner_ob_font',
    LATTICE: 'outliner_ob_lattice',
    POINTCLOUD: 'outliner_ob_pointcloud',
    GREASEPENCIL: 'outliner_ob_greasepencil',
    META: 'outliner_ob_meta',
  };
  return m[ob.type] ?? 'object';
}

export function activeAction(doc: DocumentData, ob: ObjectData | null | undefined): ActionData | undefined {
  const id = ob?.animation_data?.action;
  return id ? doc.actions[id] : undefined;
}

const boneOf = (path: string) => /^pose\.bones\["([^"]+)"\]/.exec(path)?.[1];

function curveVisibleForFilter(doc: DocumentData, ob: ObjectData, fc: FCurve, f: ChannelFilter) {
  if (f.onlyErrors && f.curveError && !f.curveError(ob, fc)) return false;
  if (f.onlySelected && doc.mode === 'POSE' && ob.pose) {
    const bone = boneOf(fc.data_path);
    if (bone && ob.pose[bone] && !ob.pose[bone].select) return false;
  }
  if (f.search) {
    const q = f.search.toLowerCase();
    if (!channelLabel(fc.data_path, fc.array_index).toLowerCase().includes(q) && !fc.data_path.toLowerCase().includes(q)) return false;
  }
  return true;
}

function filteredObjects(doc: DocumentData, f: ChannelFilter): ObjectData[] {
  return doc.object_order.map((id) => doc.objects[id]).filter((ob) => ob && (f.showHidden || f.isVisible(ob)) && (!f.onlySelected || ob.select));
}

/** Rows for an action's groups and F-Curves. */
function actionRows(
  doc: DocumentData,
  ob: ObjectData,
  action: ActionData,
  depth: number,
  f: ChannelFilter,
  rows: Channel[],
  visible: boolean,
  curvesOut: CurveRef[],
  filterCurve?: (fc: FCurve) => boolean,
) {
  const curves = action.fcurves.filter((fc) => curveVisibleForFilter(doc, ob, fc, f) && (!filterCurve || filterCurve(fc)));
  const refs = curves.map((fc) => ({ ob, action, fc }));
  curvesOut.push(...refs);
  if (!visible) return refs;
  const groups: string[] = [];
  for (const fc of curves) if (fc.group && !groups.includes(fc.group)) groups.push(fc.group);
  for (const g of groups) {
    const key = groupKey(action, g);
    const inGroup = refs.filter((r) => r.fc.group === g);
    const exp = !!f.search || isExpanded(key, 'GROUP');
    rows.push({
      key,
      kind: 'GROUP',
      depth,
      label: g,
      ob,
      action,
      group: g,
      curves: inGroup,
      expandable: true,
      expanded: exp,
    });
    if (exp) for (const r of inGroup) rows.push(curveRow(r, depth + 1, f));
  }
  for (const r of refs) if (!r.fc.group) rows.push(curveRow(r, depth, f));
  return refs;
}

function curveRow(r: CurveRef, depth: number, f?: ChannelFilter): Channel {
  return {
    error: f?.curveError?.(r.ob, r.fc) ?? false,
    key: curveKey(r.ob, r.action, r.fc),
    kind: 'FCURVE',
    depth,
    label: channelLabel(r.fc.data_path, r.fc.array_index),
    ob: r.ob,
    action: r.action,
    fc: r.fc,
    curves: [r],
    expandable: false,
    expanded: false,
  };
}

export interface ChannelList {
  rows: Channel[];
  /** every F-Curve in scope (ignores expansion) */
  curves: CurveRef[];
}

export function buildChannels(doc: DocumentData, space: SpaceKind, f: ChannelFilter): ChannelList {
  const rows: Channel[] = [];
  const curves: CurveRef[] = [];
  if (space === 'ACTION') {
    const ob = f.activeObject;
    const action = activeAction(doc, ob);
    if (!ob || !action) return { rows, curves };
    const sum: Channel = {
      key: 'summary',
      kind: 'SUMMARY',
      depth: 0,
      label: 'Summary',
      curves: [],
      expandable: true,
      expanded: isExpanded('summary', 'SUMMARY'),
    };
    rows.push(sum);
    sum.curves = actionRows(doc, ob, action, 0, f, rows, sum.expanded, curves);
    return { rows, curves };
  }
  if (space === 'SHAPEKEY') {
    const ob = f.activeObject;
    const me = ob && ob.type === 'MESH' ? (dataBlock(doc, ob) as { shape_keys?: ShapeKey[] } | null) : null;
    const keys = me?.shape_keys ?? [];
    if (!ob || keys.length < 2) return { rows, curves };
    const sum: Channel = {
      key: 'summary',
      kind: 'SUMMARY',
      depth: 0,
      label: 'Summary',
      curves: [],
      expandable: true,
      expanded: isExpanded('summary', 'SUMMARY'),
    };
    rows.push(sum);
    const action = activeAction(doc, ob);
    for (const sk of keys.slice(1)) {
      if (f.search && !sk.name.toLowerCase().includes(f.search.toLowerCase())) continue;
      const path = shapeKeyPath(sk.name);
      const fc = action?.fcurves.find((c) => c.data_path === path);
      const refs = fc && action ? [{ ob, action, fc }] : [];
      curves.push(...refs);
      sum.curves.push(...refs);
      if (sum.expanded)
        rows.push({
          key: `sk:${ob.id}:${sk.name}`,
          kind: 'SHAPEKEY',
          depth: 0,
          label: sk.name,
          ob,
          action,
          fc,
          shapeKey: sk,
          curves: refs,
          expandable: false,
          expanded: false,
        });
    }
    return { rows, curves };
  }
  const obs = filteredObjects(doc, f);
  if (space === 'DRIVERS') {
    for (const ob of obs) {
      let drivers = (ob.animation_data?.drivers ?? []).map((d, i) => ({
        d,
        i,
      }));
      if (f.search) drivers = drivers.filter(({ d }) => channelLabel(d.data_path, d.array_index).toLowerCase().includes(f.search.toLowerCase()));
      if (f.onlyErrors && f.driverError) drivers = drivers.filter(({ d }) => !!f.driverError!(ob, d));
      if (!drivers.length) continue;
      const okey = `dob:${ob.id}`;
      const oexp = isExpanded(okey, 'OBJECT');
      const action = driverAction(ob);
      const refs = drivers.map(({ d }) => ({ ob, action, fc: d.fcurve! }));
      curves.push(...refs);
      rows.push({
        key: okey,
        kind: 'OBJECT',
        depth: 0,
        label: ob.name,
        icon: objectIcon(ob),
        ob,
        curves: refs,
        expandable: true,
        expanded: oexp,
      });
      if (!oexp) continue;
      const dkey = `drvs:${ob.id}`;
      const dexp = isExpanded(dkey, 'DRIVERS');
      rows.push({
        key: dkey,
        kind: 'DRIVERS',
        depth: 1,
        label: 'Drivers',
        icon: 'graph',
        ob,
        curves: refs,
        expandable: true,
        expanded: dexp,
      });
      if (!dexp) continue;
      drivers.forEach(({ d, i }, n) =>
        rows.push({
          key: driverKey(ob, d),
          kind: 'DRIVER',
          depth: 2,
          label: channelLabel(d.data_path, d.array_index),
          ob,
          action,
          fc: d.fcurve,
          driver: d,
          driverIndex: i,
          error: !!f.driverError?.(ob, d),
          curves: [refs[n]],
          expandable: false,
          expanded: false,
        }),
      );
    }
    return { rows, curves };
  }
  if (space === 'NLA') {
    for (const ob of obs) {
      const ad = ob.animation_data;
      if (!ad || (!ad.action && !ad.nla_tracks.length)) continue;
      const okey = `nob:${ob.id}`;
      const oexp = isExpanded(okey, 'OBJECT');
      rows.push({
        key: okey,
        kind: 'OBJECT',
        depth: 0,
        label: ob.name,
        icon: objectIcon(ob),
        ob,
        curves: [],
        expandable: true,
        expanded: oexp,
      });
      if (!oexp) continue;
      const action = activeAction(doc, ob);
      rows.push({
        key: `nact:${ob.id}`,
        kind: 'NLA_ACTION',
        depth: 1,
        label: action ? action.name : '<No Action>',
        icon: 'action',
        ob,
        action,
        curves: action ? action.fcurves.map((fc) => ({ ob, action, fc })) : [],
        expandable: false,
        expanded: false,
      });
      for (let t = ad.nla_tracks.length - 1; t >= 0; t--) {
        const track = ad.nla_tracks[t];
        if (f.search && !track.name.toLowerCase().includes(f.search.toLowerCase())) continue;
        rows.push({
          key: `trk:${ob.id}:${t}`,
          kind: 'NLA_TRACK',
          depth: 1,
          label: track.name,
          ob,
          track,
          trackIndex: t,
          curves: [],
          expandable: false,
          expanded: false,
        });
      }
    }
    return { rows, curves };
  }
  // DOPESHEET / GRAPH
  const withSummary = space === 'DOPESHEET';
  const sum: Channel | null = withSummary
    ? {
        key: 'summary',
        kind: 'SUMMARY',
        depth: 0,
        label: 'Summary',
        curves: [],
        expandable: true,
        expanded: isExpanded('summary', 'SUMMARY'),
      }
    : null;
  if (sum) rows.push(sum);
  const base = 1;
  const showChildren = !sum || sum.expanded;
  for (const ob of obs) {
    const action = activeAction(doc, ob);
    if (!action) continue;
    const okey = `ob:${ob.id}`;
    const oexp = isExpanded(okey, 'OBJECT');
    const orow: Channel = {
      key: okey,
      kind: 'OBJECT',
      depth: 0,
      label: ob.name,
      icon: objectIcon(ob),
      ob,
      curves: [],
      expandable: true,
      expanded: oexp,
    };
    const akey = `act:${ob.id}:${action.id}`;
    const aexp = !!f.search || isExpanded(akey, 'ACTION');
    const arow: Channel = {
      key: akey,
      kind: 'ACTION',
      depth: base,
      label: action.name,
      icon: 'action',
      ob,
      action,
      curves: [],
      expandable: true,
      expanded: aexp,
    };
    const start = rows.length;
    if (showChildren) rows.push(orow);
    if (showChildren && oexp) rows.push(arow);
    const refs = actionRows(doc, ob, action, base + 1, f, rows, showChildren && oexp && aexp, curves);
    if (!refs.length && f.search) {
      rows.length = start;
      continue;
    }
    orow.curves = refs;
    arow.curves = refs;
    if (sum) sum.curves.push(...refs);
  }
  if (sum && !sum.curves.length && !obs.some((o) => activeAction(doc, o))) rows.length = 0;
  return { rows, curves };
}

export function shapeKeyPath(name: string) {
  return `data.shape_keys.key_blocks["${name.replace(/"/g, '\\"')}"].value`;
}

/** Whether a channel row counts as selected. */
export function channelSelected(ch: Channel): boolean {
  switch (ch.kind) {
    case 'OBJECT':
      return !!ch.ob?.select;
    case 'GROUP':
      return channelState.selectedGroups.has(ch.key);
    case 'FCURVE':
      return !!ch.fc?.select;
    case 'SHAPEKEY':
      return ch.fc ? !!ch.fc.select : channelState.selectedShapeKeys.has(ch.key);
    case 'DRIVER':
      return ch.fc ? !!ch.fc.select : channelState.selectedDrivers.has(ch.key);
    case 'NLA_TRACK':
      return !!ch.track?.select;
    default:
      return false;
  }
}

export function setChannelSelected(ch: Channel, value: boolean) {
  switch (ch.kind) {
    case 'OBJECT':
      if (ch.ob) ch.ob.select = value;
      break;
    case 'GROUP':
      if (value) channelState.selectedGroups.add(ch.key);
      else channelState.selectedGroups.delete(ch.key);
      break;
    case 'FCURVE':
      if (ch.fc) ch.fc.select = value;
      break;
    case 'SHAPEKEY':
      if (ch.fc) ch.fc.select = value;
      if (value) channelState.selectedShapeKeys.add(ch.key);
      else channelState.selectedShapeKeys.delete(ch.key);
      break;
    case 'DRIVER':
      if (ch.fc) ch.fc.select = value;
      if (value) channelState.selectedDrivers.add(ch.key);
      else channelState.selectedDrivers.delete(ch.key);
      break;
    case 'NLA_TRACK':
      if (ch.track) ch.track.select = value;
      break;
  }
}

/** Curves affected by a channel-level setting toggle on this row. */
export function channelCurves(ch: Channel): FCurve[] {
  if (ch.kind === 'FCURVE' || ch.kind === 'SHAPEKEY' || ch.kind === 'DRIVER') return ch.fc ? [ch.fc] : [];
  return ch.curves.map((r) => r.fc);
}
