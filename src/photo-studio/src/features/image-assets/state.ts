// Page state of Image Assets per open document: the latest generated files,
// problems found in layer names and the progress shown on the status bar.
// Read at any time by the status indicator; filled by generate.ts.
import type { DocumentSession } from '../../app/session';
import type { PhotoDocument } from '../../model/document';
import type { AssetIssue } from './plan';

export type AssetFile = { path: string; bytes: Uint8Array; mime: string; width: number; height: number; layerId: string; key: string };
export type AssetState = {
  status: 'idle' | 'working' | 'ready' | 'error';
  files: AssetFile[];
  issues: AssetIssue[];
  // Problems writing to Puter or encoding (not tied to a layer name).
  error?: string;
  // Where the files were last written on Puter.
  folder?: string;
  // The document state the files were made from.
  doc?: PhotoDocument;
  // Increments to cancel a generation in progress.
  token: number;
  // Encoded files by content key, reused while their layer is unchanged.
  cache: Map<string, AssetFile>;
  // Puter path → content key last written there.
  written: Map<string, string>;
};

const states = new WeakMap<DocumentSession, AssetState>();
export function assetState(s: DocumentSession): AssetState {
  let st = states.get(s);
  if (!st) states.set(s, (st = { status: 'idle', files: [], issues: [], token: 0, cache: new Map(), written: new Map() }));
  return st;
}
export const peekAssetState = (s: DocumentSession) => states.get(s);

// Called when a state changes (the status indicator re-renders).
export const assetListeners: (() => void)[] = [];
export const notifyAssets = () => assetListeners.forEach((f) => f());

/** Short status text for the status bar. */
export function statusText(st: AssetState | undefined): string {
  if (!st || st.status === 'idle') return 'Assets: waiting';
  if (st.status === 'working') return 'Assets: updating…';
  const n = st.files.length;
  const problems = st.issues.length + (st.error ? 1 : 0);
  return `Assets: ${n}${problems ? ` · ${problems} error${problems === 1 ? '' : 's'}` : ''}`;
}
