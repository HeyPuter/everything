// Light and shadow linking: an emitter (a light) can limit which objects it lights (receiver
// collection) and which objects cast its shadows (blocker collection). A collection member is
// INCLUDE or EXCLUDE: when any member is INCLUDE only included objects are affected, otherwise
// every object except the excluded ones. Child collections pass their state to their objects.
//
// The renderers get a compact table: objects with the same linking signature share a group (at
// most LINK_GROUPS), and every linked light has a bit mask of the groups it lights / that block it.
import type { CollectionData, DocumentData, ID, ObjectData } from '../data/types';
import type { LightLinkState } from './types';

export type LinkKind = 'receiver' | 'blocker';
export const LINK_GROUPS = 24;
export const ALL_GROUPS = (1 << LINK_GROUPS) - 1;

export function linkCollection(ob: ObjectData | undefined, kind: LinkKind): ID | null {
  const l = ob?.light_linking;
  return (kind === 'receiver' ? l?.receiver_collection : l?.blocker_collection) ?? null;
}

/** Link state of each object reached through a linking collection (child collections expanded). */
export function linkMembers(doc: DocumentData, cid: ID): Map<ID, LightLinkState> {
  const out = new Map<ID, LightLinkState>();
  const seen = new Set<ID>();
  const walk = (c: CollectionData, inherited: LightLinkState | null) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    for (const o of c.objects) if (!out.has(o)) out.set(o, inherited ?? c.light_linking?.[o] ?? 'INCLUDE');
    for (const ch of c.children) {
      const cc = doc.collections[ch];
      if (cc) walk(cc, inherited ?? c.light_linking?.[ch] ?? 'INCLUDE');
    }
  };
  const c = doc.collections[cid];
  if (c) walk(c, null);
  return out;
}

/** Whether a linking collection's members affect `obId` (no collection: everything is affected). */
export function linkAffects(members: Map<ID, LightLinkState> | null, obId: ID): boolean {
  if (!members) return true;
  const s = members.get(obId);
  if (s) return s === 'INCLUDE';
  for (const v of members.values()) if (v === 'INCLUDE') return false;
  return true;
}

export interface LinkTable {
  /** group of each object (0 = affected by every light) */
  objectGroup: Map<ID, number>;
  /** groups lit by / blocking each linked light (bit masks over the groups) */
  lights: Map<ID, { receive: number; block: number }>;
  groups: number;
}

/**
 * Linking table for the given renderable objects and lights; null when no light uses linking
 * (the renderers then skip the work entirely).
 */
export function computeLinkTable(doc: DocumentData, objects: Iterable<ID>, lights: Iterable<ID>): LinkTable | null {
  const linked: { id: ID; recv: Map<ID, LightLinkState> | null; block: Map<ID, LightLinkState> | null }[] = [];
  for (const id of lights) {
    const ob = doc.objects[id];
    const r = linkCollection(ob, 'receiver'),
      b = linkCollection(ob, 'blocker');
    if (!r && !b) continue;
    linked.push({ id, recv: r && doc.collections[r] ? linkMembers(doc, r) : null, block: b && doc.collections[b] ? linkMembers(doc, b) : null });
  }
  if (!linked.length) return null;
  const sigs = new Map<string, number>();
  const all = linked.map(() => '11').join('');
  sigs.set(all, 0);
  const objectGroup = new Map<ID, number>();
  const groupSig: string[] = [all];
  for (const id of objects) {
    let sig = '';
    for (const l of linked) sig += (linkAffects(l.recv, id) ? '1' : '0') + (linkAffects(l.block, id) ? '1' : '0');
    let g = sigs.get(sig);
    if (g === undefined) {
      if (sigs.size < LINK_GROUPS) {
        g = sigs.size;
        sigs.set(sig, g);
        groupSig[g] = sig;
      } else g = LINK_GROUPS - 1; // more distinct signatures than groups: the overflow shares the last group
    }
    objectGroup.set(id, g);
  }
  const lightsOut = new Map<ID, { receive: number; block: number }>();
  linked.forEach((l, k) => {
    let receive = 0,
      block = 0;
    groupSig.forEach((sig, g) => {
      if (sig[k * 2] === '1') receive |= 1 << g;
      if (sig[k * 2 + 1] === '1') block |= 1 << g;
    });
    lightsOut.set(l.id, { receive, block });
  });
  return { objectGroup, lights: lightsOut, groups: groupSig.length };
}

/** Name of a new linking collection for an emitter. */
export function linkCollectionName(ob: ObjectData, kind: LinkKind) {
  return `${kind === 'receiver' ? 'Light' : 'Shadow'} Linking for ${ob.name}`;
}
