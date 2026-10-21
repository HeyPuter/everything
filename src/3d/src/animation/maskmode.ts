// Dope Sheet ▸ Mask: the shape keys of every mask's layers as keyframes. Each layer gets a stand-in
// F-Curve whose keys mirror its shape-key frames, so the Dope Sheet's selection, transform, delete,
// duplicate, snap and mirror tools work on them; edits are written back to the layers after every
// change (and before each undo step is stored).
import { app, onAppReady, undoPushHooks } from '../app/app';
import type { ActionData, DocumentData, FCurve, Keyframe, ObjectData } from '../data/types';
import { insertKeyframe } from '../anim/fcurve';
import type { MaskData, MaskLayer, MaskShapeKey } from '../mask/types';
import { maskTable } from '../mask/types';
import { insertShapeKey, keyedData, layerData } from '../mask/geom';
import { spaceChannelBuilders, isExpanded, type Channel, type ChannelFilter, type ChannelList, type CurveRef } from './channels';

declare module '../mask/types' {
  interface MaskShapeKey {
    /** selected in the Dope Sheet */
    select?: boolean;
  }
  interface MaskLayer {
    /** keys of the layer can't be edited in the Dope Sheet */
    lock?: boolean;
  }
}

type MaskKey = Keyframe & { mask_ref?: MaskShapeKey };

interface Stand {
  fc: FCurve;
  layer: MaskLayer;
  /** layer state the stand-in was built from or last written to */
  sig: string;
}

const stands = new WeakMap<MaskLayer, Stand>();
/** stand-ins of the last channel build: the ones written back */
let live: Stand[] = [];
const owners = new WeakMap<MaskData, { ob: ObjectData; act: ActionData }>();

const sigOf = (l: MaskLayer) => `${l.lock ? 'L' : ''}|` + l.shape_keys.map((k) => `${k.frame}${k.select ? 's' : ''}`).join(',');

/** Stand-in object / action of a mask (only names and ids are read by the editors). */
function ownerOf(m: MaskData) {
  let o = owners.get(m);
  if (!o) {
    o = {
      ob: { id: `mask:${m.id}`, name: m.name, select: true, animation_data: null, type: 'EMPTY' } as unknown as ObjectData,
      act: { id: `mask:${m.id}`, name: m.name, fcurves: [] } as ActionData,
    };
    owners.set(m, o);
  }
  o.ob.name = m.name;
  return o;
}

/** The stand-in curve of a layer, rebuilt when the layer changed elsewhere. */
export function layerCurve(layer: MaskLayer): FCurve {
  const sig = sigOf(layer);
  let s = stands.get(layer);
  if (!s || s.sig !== sig) {
    const fc: FCurve = { data_path: `layers["${layer.name}"]`, array_index: 0, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [], select: s?.fc.select, lock: !!layer.lock };
    layer.shape_keys
      .slice()
      .sort((a, b) => a.frame - b.frame)
      .forEach((sk, i) => {
        const k = insertKeyframe(fc, sk.frame, i) as MaskKey;
        // shape keys have no handles: drawn as plain diamonds
        k.handle_left_type = k.handle_right_type = 'FREE';
        k.select_control_point = !!sk.select;
        k.mask_ref = sk;
      });
    s = { fc, layer, sig };
    stands.set(layer, s);
  }
  return s.fc;
}

/** Write the stand-in keys back into their layers' shape keys. */
export function writeBackMaskKeys() {
  for (const s of live) {
    const { fc, layer } = s;
    // the layer changed elsewhere (mask editor, undo): it wins, the stand-in is rebuilt
    if (sigOf(layer) !== s.sig) continue;
    layer.lock = !!fc.lock;
    const used = new Set<MaskShapeKey>();
    const byFrame = new Map<number, MaskShapeKey>();
    const keys = [...(fc.keyframe_points as MaskKey[])].sort((a, b) => a.co[0] - b.co[0]);
    for (const k of keys) {
      const frame = Math.round(k.co[0]);
      let sk = k.mask_ref;
      const known = sk && layer.shape_keys.includes(sk) && !used.has(sk);
      // duplicated or pasted keys become new shape keys with the data they were made from
      if (!known) sk = { frame, data: sk ? [...sk.data] : (keyedData(layer, frame) ?? layerData(layer)) };
      used.add(sk!);
      sk!.frame = frame;
      sk!.select = !!k.select_control_point;
      k.mask_ref = sk;
      byFrame.set(frame, sk!);
    }
    const next = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
    const changed = next.length !== layer.shape_keys.length || next.some((k, i) => k !== layer.shape_keys[i]);
    if (changed) layer.shape_keys = next;
    // keep the stand-in values distinct (equal neighbours would draw as holds)
    keys.forEach((k, i) => {
      const dy = i - k.co[1];
      k.co[1] = i;
      k.handle_left[1] += dy;
      k.handle_right[1] += dy;
    });
    s.sig = sigOf(layer);
  }
}

/** Dope Sheet ▸ Mask channels: Summary ▸ Mask ▸ Layers. */
export function maskChannels(doc: DocumentData, f: ChannelFilter): ChannelList {
  const rows: Channel[] = [];
  const curves: CurveRef[] = [];
  const nextLive: Stand[] = [];
  const masks = Object.values(maskTable(doc));
  const q = f.search.trim().toLowerCase();
  const sum: Channel = { key: 'mask-summary', kind: 'SUMMARY', depth: 0, label: 'Summary', curves: [], expandable: true, expanded: isExpanded('mask-summary', 'SUMMARY') };
  if (masks.length && !f.noSummary) rows.push(sum);
  for (const m of masks) {
    const { ob, act } = ownerOf(m);
    const key = `mask:${m.id}`;
    const exp = !!q || isExpanded(key, 'OBJECT');
    const mrow: Channel = { key, kind: 'MASK', depth: 0, label: m.name, icon: 'mod_mask', mask: m, ob, action: act, curves: [], expandable: true, expanded: exp };
    const layerRows: Channel[] = [];
    // layers listed top-most first
    for (let i = m.layers.length - 1; i >= 0; i--) {
      const layer = m.layers[i];
      if (q && !layer.name.toLowerCase().includes(q)) continue;
      const fc = layerCurve(layer);
      nextLive.push(stands.get(layer)!);
      const ref = { ob, action: act, fc };
      mrow.curves.push(ref);
      curves.push(ref);
      layerRows.push({ key: `maskl:${m.id}:${i}`, kind: 'MASK_LAYER', depth: 1, label: layer.name, mask: m, maskLayer: layer, ob, action: act, fc, curves: [ref], expandable: false, expanded: false });
    }
    if (q && !layerRows.length) continue;
    act.fcurves = mrow.curves.map((r) => r.fc);
    sum.curves.push(...mrow.curves);
    if (sum.expanded || f.noSummary) {
      rows.push(mrow);
      if (exp) rows.push(...layerRows);
    }
  }
  live = nextLive;
  return { rows, curves };
}

/** Dope Sheet ▸ Mask: key the current point positions of the layers behind the given stand-ins. */
export function insertMaskKeys(curves: CurveRef[], frame: number): number {
  let n = 0;
  for (const s of live) {
    if (!curves.some((r) => r.fc === s.fc) || !s.layer.splines.length || s.layer.lock) continue;
    insertShapeKey(s.layer, frame);
    n++;
  }
  return n;
}

spaceChannelBuilders.MASK = maskChannels;
undoPushHooks.push(writeBackMaskKeys);
onAppReady((a) =>
  a.subscribe((kinds) => {
    if (kinds.has('doc') && live.length) writeBackMaskKeys();
  }),
);
void app;
