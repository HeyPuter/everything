import { TextDocument } from './model.js';
import { resolveStyledParagraph } from './styles.js';
import { trackFormatChanges } from './revisions.js';
import { ParagraphOwners, copyAfterTyping } from './typing-copies.js';

const objectNames = new WeakMap();
let nextObjectName = 0;
const objectName = object => { let name = objectNames.get(object); if (name === undefined) objectNames.set(object, name = nextObjectName++); return name; };

// Typing copies only the paragraphs it changed (typing-copies.js) where nothing changes paragraphs far from the
// caret: Track Changes (a tracked deletion marks text in place, a move marks its source), fields (kept in step
// across the document), and content controls, which span paragraphs.
const DOCUMENT_PARTS = ['comments', 'tables', 'styles', 'stylesEnabled', 'numbering', 'pageSettings'];
// Settings the host keeps, compared by value; their bytes (custom XML parts) by identity, as each write replaces them.
const byteIds = new WeakMap();
let nextByteId = 0;
const hostKey = host => JSON.stringify(host ?? null, (key, value) => {
  if (!(value instanceof Uint8Array)) return value;
  if (!byteIds.has(value)) byteIds.set(value, nextByteId++);
  return `bytes:${byteIds.get(value)}`;
});
const sameHost = (a, b) => hostKey(a) === hostKey(b);
const incrementalTyping = model => !model.trackChanges && !model.hasBodyFields && !model.hasContentControls && !model.hasBlockControls;

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
    // untracked(path) hears of each change made in a header, footer or note while Track Changes is on: tracked
    // changes are recorded in the body only, so the change there is not tracked.
    this.untracked = null;
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
      // A header, footer or note is laid out on one page: it takes no page or column break.
      model.refusesBreaks = true;
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
   * that copy when the document has no new revision since. A keystroke makes the next one's copy
   * itself, from its own (typing-copies.js): keys that come faster than the browser goes idle copied
   * the whole document every time. Each prepared copy is used once.
   */
  snapshot(model) {
    const prepared = this.prepared;
    this.prepared = null;
    if (prepared?.model !== model || prepared.revision !== model.revision) return model.snapshot();
    const state = { ...prepared.document, ...model.typingSnapshot() };
    // Every document change must come with a new revision, and a keystroke changes only the paragraphs it
    // replaces or reaches. Development builds check that the copy is still the document.
    if (import.meta.env?.DEV && JSON.stringify(prepared.document) !== JSON.stringify(model.documentState())) throw new Error(prepared.typed ? 'A keystroke changed a paragraph it did not replace or reach, or the document changed without a new revision.' : 'The document changed without a new revision.');
    return state;
  }
  prepareSnapshot() {
    if (typeof requestIdleCallback !== 'function') return;
    if (this.prepareTask) cancelIdleCallback(this.prepareTask);
    const model = this.model, revision = model.revision;
    this.prepareTask = requestIdleCallback(() => {
      this.prepareTask = null;
      if (this.model !== model || model.revision !== revision) return;
      this.prepared = { model, revision, document: model.documentSnapshot() };
      // Typing next copies only what it changes, knowing which paragraph holds what.
      if (incrementalTyping(model) && !this.knowsOwners(model, revision, model.paragraphs)) this.owners = { model, revision, paragraphs: new ParagraphOwners(model.paragraphs) };
    }, { timeout: 2000 });
  }
  /** What a keystroke's copy for the next one is made from (copyAfterTyping), when it can be. */
  typingStart(model, before) {
    if (!incrementalTyping(model)) return null;
    const [start, end] = model.range;
    return {
      revision: before.revision, live: model.paragraphs.slice(), copy: before.state,
      parts: DOCUMENT_PARTS.map(key => model[key]),
      // A keystroke can change the caret's paragraphs in place, and the ones beside them (Backspace joins two).
      reach: [model.locate(start).index - 1, model.locate(end).index + 1],
    };
  }
  /** After keystroke `typed` (typingStart) changed `model`, the copy the next command starts from, or null. */
  typingCopy(typed, model) {
    if (!incrementalTyping(model) || DOCUMENT_PARTS.some((key, i) => model[key] !== typed.parts[i])) { this.owners = null; return null; }
    if (!this.knowsOwners(model, typed.revision, typed.live)) this.owners = { model, paragraphs: new ParagraphOwners(typed.live) };
    this.owners.revision = model.revision;
    const document = copyAfterTyping(typed, model.paragraphs, model.locate(model.selection.focus).index, this.owners.paragraphs);
    return document && { model, revision: model.revision, document, typed: true };
  }
  /** Whether the owners known (ParagraphOwners) are those of `paragraphs`, the model's at `revision`. */
  knowsOwners(model, revision, paragraphs) {
    const owners = this.owners;
    // Undo after a failed command puts equal copies of the paragraphs back at the same revision.
    return owners?.model === model && owners.revision === revision && owners.paragraphs.live.size === paragraphs.length && paragraphs.every(p => owners.paragraphs.live.has(p));
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
    this.recorded = (this.recorded || 0) + 1;
    this.history.push(entry);
    if (this.history.length > 100) this.history.shift();
    this.future = [];
  }
  // `label` names the undo step for the host's menus, where the change alone does not say what made it (AutoCorrect).
  // `resume` ({ path, page }) is the header, footer or note being edited when the change was made in another story
  // (the body's section settings from a header): Undo and Redo go back to editing it.
  // `settings`: the action also changes the settings changeSettings keeps (the citation style and sources), which
  // the step takes back with it.
  run(action, validate = () => {}, { record = true, typing = false, label, resume, settings = false } = {}) {
    const before = this.capture(), model = this.model, settingsBefore = settings ? this.settingsState() : null;
    // Text typed or deleted with a key (CanvasEditor typeText and deleteText).
    const typed = typing ? this.typingStart(model, before) : null;
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
      if (model.revision !== before.revision) {
        if (record) { if (label) before.label = label; if (resume) before.resume = resume; if (settingsBefore) before.settings = settingsBefore; this.record(before); }
        this.revision++;
        if (this.path !== null && this.body.trackChanges) this.untracked?.(this.path);
      }
      model.history = []; model.future = [];
      const next = typed && model.revision !== before.revision && this.model === model ? this.typingCopy(typed, model) : null;
      if (next) {
        if (this.prepareTask) cancelIdleCallback(this.prepareTask);
        this.prepareTask = null; this.prepared = next;
      } else this.prepareSnapshot();
      return result;
    } catch (error) {
      this.restore(before); this.model.revision = before.revision;
      if (settingsBefore) this.applySettings(settingsBefore);
      throw error;
    } finally {
      if (ownCheckpoint) model.checkpoint = ownCheckpoint; else delete model.checkpoint;
    }
  }
  /**
   * Settings kept beside the stories' text: each section's first-page and page-numbering options, odd-and-even
   * pages and the note settings (in the definition), and what the host keeps of them for saving (`settingsHost`,
   * the package's side). The headers, footers and notes themselves are not among them: a story added since stays.
   */
  settingsState() {
    const definition = this.definition;
    return {
      options: definition && { evenAndOdd: !!definition.evenAndOdd, footnotes: definition.footnotes, endnotes: definition.endnotes,
        sections: definition.sections.map(section => ({ firstPageDifferent: !!section.firstPageDifferent, pageNumbering: section.pageNumbering })) },
      host: this.settingsHost?.capture(),
    };
  }
  applySettings({ options, host }) {
    const definition = this.definition;
    if (definition) {
      const next = { ...definition, evenAndOdd: !!options?.evenAndOdd, sections: definition.sections.map((section, i) => {
        const kept = options?.sections[i], value = { ...section, firstPageDifferent: !!kept?.firstPageDifferent };
        if (kept?.pageNumbering) value.pageNumbering = kept.pageNumbering; else delete value.pageNumbering;
        return value;
      }) };
      // Note settings are set before they change (a note adds them): ones a later note added stay.
      for (const key of ['footnotes', 'endnotes']) if (options?.[key] !== undefined) next[key] = options[key];
      this.definition = next; this.sectionRevision = undefined;
    }
    this.settingsHost?.restore(host);
  }
  /**
   * Change those settings (`change()`) as one undo step, like an edit to the text. A change that leaves them as
   * they were records nothing. Whether anything changed. `label` names the step, as run's does.
   */
  changeSettings(change, { label } = {}) {
    const before = { path: this.path, page: this.page, settings: this.settingsState(), caret: this.caret?.(), ...(label ? { label } : {}) };
    const same = () => {
      const now = this.settingsState(), outline = state => JSON.stringify(state.options?.sections.some(s => s.firstPageDifferent || s.pageNumbering) || state.options?.evenAndOdd || state.options?.footnotes || state.options?.endnotes ? state.options : null);
      return outline(now) === outline(before.settings) && sameHost(now.host, before.settings.host);
    };
    try { change(); } catch (error) { this.applySettings(before.settings); throw error; } finally { this.sectionRevision = undefined; }
    if (same()) return false;
    this.record(before);
    this.revision++;
    return true;
  }
  /**
   * Make the steps `action` records one undo step, also when they change several stories (Replace All in every
   * header and footer). The step is named as its first part was.
   */
  transact(action) {
    const start = this.recorded || 0;
    try { return action(); } finally {
      const count = Math.min((this.recorded || 0) - start, this.history.length), steps = this.history.slice(this.history.length - count);
      if (count > 1 && steps.every(step => step.state || step.settings)) {
        this.history.splice(this.history.length - count);
        this.history.push(this.compound(steps, steps[0].label));
      }
    }
  }
  /** One step made of `steps`, which Undo and Redo apply last to first: the first's story is where it ends. */
  compound(steps, label) {
    return { steps, path: steps[0].path, page: steps[0].page, caret: steps[0].caret, ...(label ? { label } : {}) };
  }
  travel(from, to, validate) {
    if (!from.length) return false;
    const previousPath = this.path, previousPage = this.page, entry = from.at(-1);
    if (entry.steps) {
      // Each part puts its story back, the last part first; the state each replaces makes the step back.
      const applied = [];
      try {
        for (const step of [...entry.steps].reverse()) {
          // A part can be a change of settings (changeSettings), which no story's text holds.
          if (step.settings && !step.state) {
            applied.push({ path: step.path, page: step.page, settings: this.settingsState(), caret: step.caret });
            this.applySettings(step.settings);
            continue;
          }
          this.activate(step.path); this.page = step.page;
          const current = this.capture();
          if (step.settings) current.settings = this.settingsState();
          applied.push(current);
          this.restore(step);
          if (step.settings) this.applySettings(step.settings);
          this.guard?.(current.state, this.model, this.path);
        }
        validate?.(this.model);
      } catch (error) {
        for (const current of [...applied].reverse()) {
          if (current.settings) this.applySettings(current.settings);
          if (!current.state) continue;
          this.restore(current); this.model.revision = current.revision;
        }
        this.activate(previousPath); this.page = previousPage;
        throw error;
      }
      from.pop(); to.push(this.compound(applied, entry.label));
      this.revision++;
      this.prepareSnapshot();
      return true;
    }
    if (entry.settings && !entry.state) {
      // The settings go back (or forward) where the caret is: no story's text changes.
      const current = { path: this.path, page: this.page, settings: this.settingsState(), caret: this.caret?.() };
      this.applySettings(entry.settings);
      try { validate?.(this.model); } catch (error) { this.applySettings(current.settings); throw error; }
      if (entry.label) current.label = entry.label;
      from.pop(); to.push(current);
      this.revision++;
      return true;
    }
    this.activate(entry.path);
    this.page = entry.page;
    const current = this.capture();
    // A step that also changed settings (run's `settings`) puts them back with the text.
    if (entry.settings) current.settings = this.settingsState();
    try {
      this.restore(entry);
      if (entry.settings) this.applySettings(entry.settings);
      this.guard?.(current.state, this.model, this.path);
      validate?.(this.model);
      // The step keeps its name (for the host's menus) and the story to go on editing in both directions.
      if (entry.label) current.label = entry.label;
      if (entry.resume) current.resume = entry.resume;
      from.pop(); to.push(current);
      this.revision++;
      this.prepareSnapshot();
      return true;
    } catch (error) {
      this.restore(current); this.model.revision = current.revision;
      if (current.settings) this.applySettings(current.settings);
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
