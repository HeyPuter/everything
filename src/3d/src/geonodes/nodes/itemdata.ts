// Item lists stored on nodes as JSON (no UI): Format String, Index Switch and Menu Switch items.
import type { NodeData } from '../../data/types';

export interface NodeItem {
  id: number;
  name: string;
  /** socket type of the item (Format String) */
  type?: string;
}

export function readItems(n: NodeData, prop: string, fallback: NodeItem[] = []): NodeItem[] {
  const raw = n.props[prop];
  if (raw === undefined || raw === null) return fallback;
  try {
    const v = JSON.parse(String(raw));
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function writeItems(n: NodeData, prop: string, items: NodeItem[]) {
  n.props[prop] = JSON.stringify(items);
}

export const formatItems = (n: NodeData) => readItems(n, 'format_items');
export const indexItems = (n: NodeData) =>
  readItems(n, 'index_switch_items', [
    { id: 0, name: '0' },
    { id: 1, name: '1' },
  ]);
export const menuItems = (n: NodeData) =>
  readItems(n, 'enum_items', [
    { id: 0, name: 'A' },
    { id: 1, name: 'B' },
  ]);
