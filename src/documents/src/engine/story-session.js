import { TextDocument } from './model.js';
import { resolveStyledParagraph } from './styles.js';
import { trackFormatChanges } from './revisions.js';

const objectNames = new WeakMap();
let nextObjectName = 0;
const objectName = object => { let name = objectNames.get(object); if (name === undefined) objectNames.set(object, name = nextObjectName++); return name; };

// A document has separate text-position spaces, but one chronological undo
// stack. History stores only the changed story, never copies of every story.
export class StorySession {
  constructor(body, pageStories) {
    this.body = body;
    this.definition = pageStories;
    this.models = new Map([[null, body]]);
    this.path = null;
    this.page = 0;
    this.history = [];
    this.future = [];
    this.revision = 0;
    // guard(beforeState, model, path) throws to refuse a change (document protection).
    this.guard = null;
    this.prepareSnapshot();
  }
  get model() { return this.models.get(this.path); }
  activate(path = null) {
    if (path === this.path) return this.model;
    if (!this.models.has(path)) {
      const story = this.definition?.stories[path];
      if (!story?.paragraphs?.length) throw new Error('This page story is not available for editing.');
      const model = new TextDocument(story.paragraphs, this.body.pageSettings, this.body.numbering, this.body.styles, story.tables, this.body.assets);
      model.assets = this.body.assets;
      this.models.set(path, model);
    }
    this.path = path;
    return this.model;
  }
  // `caret()`, when the editor sets it, says where its caret shows at a line's end (its affinity), which a
  // position alone does not; Undo and Redo put it back with the selection.
  capture() { return { path: this.path, page: this.page, state: this.snapshot(this.model), revision: this.model.revision, caret: this.caret?.() }; }
  /**
   * The model's state for undo. Copying a long document takes a while, so after each command the
   * document is copied while the browser is idle (prepareSnapshot); the next command starts from
   * that copy when the document has no new revision since. Each prepared copy is used once.
   */
  snapshot(model) {
    const prepared = this.prepared;
    this.prepared = null;
    if (prepared?.model !== model || prepared.revision !== model.revision) return model.snapshot();
    const state = { ...prepared.document, ...model.typingSnapshot() };
    // Every document change must come with a new revision. Development builds check that it did.
    if (import.meta.env?.DEV && JSON.stringify(prepared.document) !== JSON.stringify(model.documentSnapshot())) throw new Error('The document changed without a new revision.');
    return state;
  }
  prepareSnapshot() {
    if (typeof requestIdleCallback !== 'function') return;
    if (this.prepareTask) cancelIdleCallback(this.prepareTask);
    const model = this.model, revision = model.revision;
    this.prepareTask = requestIdleCallback(() => {
      this.prepareTask = null;
      if (this.model === model && model.revision === revision) this.prepared = { model, revision, document: model.documentSnapshot() };
    }, { timeout: 2000 });
  }
  publish(owner, before) {
    if (this.models.size === 1) return;
    const stylesChanged = JSON.stringify(before.styles) !== JSON.stringify(owner.styles);
    const numberingChanged = JSON.stringify(before.numbering) !== JSON.stringify(owner.numbering);
    for (const model of this.models.values()) {
      if (model === owner) continue;
      model.styles = owner.styles; model.stylesEnabled = owner.stylesEnabled;
      model.numbering = owner.numbering; model.pageSettings = owner.pageSettings;
      if (stylesChanged || numberingChanged) for (const paragraph of model.paragraphs) resolveStyledParagraph(paragraph, model.styles, model.numbering);
    }
  }
  restore(entry) {
    const model = this.activate(entry.path), before = model.snapshot();
    this.page = entry.page;
    model.restore(entry.state);
    this.publish(model, before);
    model.history = []; model.future = [];
  }
  record(entry) {
    this.history.push(entry);
    if (this.history.length > 100) this.history.shift();
    this.future = [];
  }
  run(action, validate = () => {}, { record = true } = {}) {
    const before = this.capture(), model = this.model;
    model.formatTrackingSuppressed = false;
    // The session keeps `before` for undo, and the model's own undo entries are dropped when the command
    // ends. Commands still push one (some mark or remove their own), but it need not copy the document:
    // that copy, of the whole document, was made and thrown away on every keystroke.
    const ownCheckpoint = Object.hasOwn(model, 'checkpoint') ? model.checkpoint : null;
    model.checkpoint = function () {
      this.history.push({ selection: { ...this.selection } });
      if (this.history.length > 100) this.history.shift();
      this.future = [];
    };
    try {
      const result = action(model);
      if (this.path !== before.path) throw new Error('A text command cannot switch page stories.');
      if (model.revision !== before.revision) {
        // With Track Changes on, a formatting change keeps the formatting it replaced (§17.13.5.29/.30).
        if (model.trackChanges && model.trackFormatting !== false && !model.formatTrackingSuppressed && this.path === null) trackFormatChanges(before.state.paragraphs, model.paragraphs, () => model.newRevision('format'), {
          // Style definitions and table structure (with its conditional formatting) are not
          // formatting changes to the text they restyle.
          stylesChanged: JSON.stringify(before.state.styles) !== JSON.stringify(model.styles) || JSON.stringify(before.state.tables) !== JSON.stringify(model.tables),
        });
        this.publish(model, before.state);
        this.guard?.(before.state, model, this.path);
      }
      validate(model);
      if (model.revision !== before.revision) { if (record) this.record(before); this.revision++; }
      model.history = []; model.future = [];
      this.prepareSnapshot();
      return result;
    } catch (error) {
      this.restore(before); this.model.revision = before.revision;
      throw error;
    } finally {
      if (ownCheckpoint) model.checkpoint = ownCheckpoint; else delete model.checkpoint;
    }
  }
  travel(from, to, validate) {
    if (!from.length) return false;
    const previousPath = this.path, previousPage = this.page, entry = from.at(-1);
    this.activate(entry.path);
    this.page = entry.page;
    const current = this.capture();
    try {
      this.restore(entry);
      this.guard?.(current.state, this.model, this.path);
      validate?.(this.model);
      from.pop(); to.push(current);
      this.revision++;
      this.prepareSnapshot();
      return true;
    } catch (error) {
      this.restore(current); this.model.revision = current.revision;
      this.activate(previousPath);
      this.page = previousPage;
      throw error;
    }
  }
  undo(validate) { return this.travel(this.history, this.future, validate); }
  redo(validate) { return this.travel(this.future, this.history, validate); }
  get pageStories() {
    if (!this.definition) return this.definition;
    if (this.sectionRevision !== this.body.revision) {
      const source = this.definition.sections;
      // A file with one section keeps its definition only while the body has one too: a section break
      // inserted since makes another section, which takes its headers, footers and notes from the file's.
      if (source.length === 1 && !this.body.paragraphs?.some(p => p.sectionEnd)) { this.sectionDefinition = this.definition; this.sectionMapping = null; }
      else {
        const indices = this.body.paragraphs.filter(p => p.sectionEnd).map((p, i) => Math.min(p.sectionSourceIndex ?? i, source.length - 1));
        indices.push(source.length - 1);
        // The same sections keep the same object, so edits within them keep their stories' version.
        const mapping = indices.join(',');
        if (mapping !== this.sectionMapping || this.sectionSource !== this.definition) {
          this.sectionDefinition = indices.length === source.length && indices.every((index, i) => index === i)
            ? this.definition : { ...this.definition, sections: indices.map(index => source[index]) };
          this.sectionMapping = mapping; this.sectionSource = this.definition;
        }
      }
      this.sectionRevision = this.body.revision;
    }
    let pageStories = this.sectionDefinition;
    if (this.models.size > 1) {
      const stories = { ...this.definition.stories };
      for (const [path, model] of this.models) if (path !== null) stories[path] = { ...stories[path], paragraphs: model.paragraphs, tables: model.tables };
      pageStories = { ...this.sectionDefinition, stories };
    }
    // Names this content for layout's remembered story measurements (page-story-measure.js): the file's
    // stories change only by edits to their own models (each with its revision) or by notes added to it.
    const edited = [...this.models].filter(([path]) => path !== null).map(([path, model]) => `${path}@${model.revision}`);
    Object.defineProperty(pageStories, 'storiesVersion', { configurable: true, enumerable: false, writable: true,
      value: `${objectName(this.definition)}:${objectName(this.sectionDefinition.sections)}:${Object.keys(this.definition.stories).length}:${edited.join(',')}` });
    return pageStories;
  }
  get storyEdits() {
    return Object.fromEntries([...this.models].filter(([path]) => path !== null).map(([path, model]) => [path, { paragraphs: model.paragraphs, tables: model.tables }]));
  }
  export(pkg, { async = false } = {}) {
    const body = this.body;
    // Tracking "just mine" is a session choice: the document keeps its own Track Changes setting.
    const track = body.trackChangesMode === 'mine' ? !!pkg.trackRevisions : body.trackChanges;
    // The asynchronous export writes the parts now and zips them off the page's thread (DocxPackage.exportAsync).
    return pkg[async && pkg.exportAsync ? 'exportAsync' : 'export'](body.paragraphs, body.pageSettings, body.numbering, body.styles, body.tables, body.assets, this.storyEdits, body.comments, track);
  }
}
