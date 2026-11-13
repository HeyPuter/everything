import { History } from '../history/history';
import { Assets } from '../model/assets';
import { newDocument, type PhotoDocument } from '../model/document';
import { PuterStorage } from '../persistence/puter';
import { documentTileIds } from '../model/pixel-layer';
import type { TileGrid } from '../model/tiles';

// Tiles features hold outside any document (the Quick Mask), kept by every
// cleanup; IDs from another document's store are harmless here.
export const tileHolders: (() => Iterable<string>)[] = [];

/** One open document: its history, assets and per-document view state. */
export class DocumentSession {
  readonly id = crypto.randomUUID();
  history: History;
  assets = new Assets();
  storage = new PuterStorage();
  selectedIds = new Set<string>();
  collapsedGroups = new Set<string>();
  selectionAnchor = '';
  selections = new WeakMap<PhotoDocument, string[]>();
  // Data kept outside history (review comments) can change while a save waits.
  extrasRevision = 0;
  savedExtrasRevision = 0;
  get unsavedExtras() {
    return this.extrasRevision !== this.savedExtrasRevision;
  }
  set unsavedExtras(dirty: boolean) {
    if (dirty) this.extrasRevision++;
    else this.savedExtrasRevision = this.extrasRevision;
  }
  // A transparent, zero-layer document is still an open editing workspace.
  hasDocument = false;
  saved?: PhotoDocument;
  maskTarget = '';
  // The channel selected in this document's Channels panel.
  activeChannel?: string;
  // The previous selection, restored by Select → Reselect.
  lastSelection?: TileGrid | null;
  // File name/handle for Save; undefined until saved or opened from a file.
  fileName?: string;
  // Features can take over Save and closing (embedded object contents save
  // into their parent document). `closeHandler` resolves false to stay open.
  saveHandler?: () => Promise<void>;
  closeHandler?: () => Promise<boolean>;
  // Other document states features keep (History snapshots) whose tiles must survive cleanup.
  retained: (() => PhotoDocument[])[] = [];
  // Edits can finish storing assets after their tool has closed. Readers of
  // the document must still wait for those edits to enter history.
  private pendingEdits = new Set<Promise<void>>();
  get hasPendingEdits() {
    return this.pendingEdits.size > 0;
  }
  pendingEditsChanged?: () => void;
  trackEdit(task: Promise<void>): Promise<void> {
    const pending = this.hasPendingEdits;
    this.pendingEdits.add(task);
    if (!pending) this.pendingEditsChanged?.();
    const done = () => {
      if (this.pendingEdits.delete(task) && !this.hasPendingEdits) this.pendingEditsChanged?.();
    };
    void task.then(done, done);
    return task;
  }
  async waitForEdits(): Promise<void> {
    while (this.pendingEdits.size) await Promise.all([...this.pendingEdits]);
  }
  constructor(doc = newDocument()) {
    this.history = new History(doc);
  }
  get doc() {
    return this.history.document;
  }
  get dirty() {
    return this.hasDocument && (this.doc !== this.saved || this.unsavedExtras);
  }
  /** Free tiles no reachable history state refers to. */
  collectTiles(extra: Iterable<string> = []) {
    const keep = new Set<string>(extra);
    for (const d of this.history.documents) documentTileIds(d, keep);
    // The History Brush paints from the opened state after history dropped it.
    documentTileIds(this.history.opened, keep);
    if (this.saved) documentTileIds(this.saved, keep);
    for (const list of this.retained) for (const d of list()) documentTileIds(d, keep);
    if (this.lastSelection) for (const id of Object.values(this.lastSelection.tiles)) keep.add(id);
    for (const held of tileHolders) for (const id of held()) keep.add(id);
    this.assets.tiles.retain(keep);
  }
  dispose() {
    this.assets.clear();
  }
}
