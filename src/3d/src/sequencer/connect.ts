// Connected strips: strips that are selected, moved, trimmed and split together (e.g. a movie
// and its sound). Each strip lists the names of the strips it is connected to; connecting a set
// makes every member connected to every other member. Pure functions (unit tested).
import type { Strip } from './types';

/** Strips connected to `s` (not including `s`) that exist in `list`. */
export function connectedOf(list: Strip[], s: Strip): Strip[] {
  if (!s.connections?.length) return [];
  const names = new Set(s.connections);
  return list.filter((x) => x !== s && names.has(x.name));
}

export function isConnected(list: Strip[], s: Strip) {
  return connectedOf(list, s).length > 0;
}

/** Remove the strips from any connection (both directions). */
export function disconnect(list: Strip[], strips: Strip[]): boolean {
  let changed = false;
  const names = new Set(strips.map((s) => s.name));
  for (const s of strips)
    if (s.connections?.length) {
      delete s.connections;
      changed = true;
    }
  for (const o of list) {
    if (!o.connections?.length) continue;
    const kept = o.connections.filter((n) => !names.has(n));
    if (kept.length !== o.connections.length) {
      changed = true;
      if (kept.length) o.connections = kept;
      else delete o.connections;
    }
  }
  return changed;
}

/** Connect the strips to each other (they leave any previous connection first). */
export function connect(list: Strip[], strips: Strip[]): boolean {
  if (strips.length < 2) return false;
  disconnect(list, strips);
  for (const s of strips) s.connections = strips.filter((o) => o !== s).map((o) => o.name);
  return true;
}

/** Strips plus everything connected to them. */
export function withConnected(list: Strip[], strips: Strip[]): Strip[] {
  const out = new Set(strips);
  for (const s of strips) for (const c of connectedOf(list, s)) out.add(c);
  return [...out];
}

/** After copying strips: keep connections between copies, drop links to strips not copied. */
export function remapConnections(copies: Strip[], rename: Map<string, string>) {
  for (const c of copies) {
    if (!c.connections) continue;
    const next = c.connections.map((n) => rename.get(n)).filter((n): n is string => !!n);
    if (next.length) c.connections = next;
    else delete c.connections;
  }
}

/** A strip was renamed: update the names other strips use to refer to it. */
export function renameConnections(list: Strip[], from: string, to: string) {
  for (const o of list) if (o.connections) o.connections = o.connections.map((n) => (n === from ? to : n));
}
