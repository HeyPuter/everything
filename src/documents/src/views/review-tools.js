/**
 * Review tools beyond comments and changes: the Editor pane, Thesaurus, Word Count, Check
 * Accessibility, Language and Translate, Compare and Combine, Restrict Editing and Lock Tracking.
 * Each contributes ribbon groups (extendTab), classic menu items (extendMenu) and document context
 * menu items (contextMenuItems) through the editor's command object.
 */
import { isComposing, MOD_KEY, shortcutCode } from '../ui/dom.js';
import { toast } from '../ui/toast.js';
import { openMenu } from '../ui/menu.js';
import { revisionView } from '../engine/revisions.js';
import { createEditorPane } from './editor-pane.js';
import { createThesaurusPane } from './thesaurus-pane.js';
import { openWordCount } from './word-count.js';
import { createAccessibilityPane } from './accessibility-pane.js';
import { openLanguageDialog, createTranslatePane, TRANSLATION_LANGUAGE, DETECT_LANGUAGE } from './language-tools.js';
import { createCommentsPane } from './comments-pane.js';
import { createRestrictEditing } from './restrict-editing.js';
import { openCompareDialog } from './compare-dialog.js';
import { openTrackingOptions, restoreTrackingOptions, rememberTrackingOptions, showMarkupItems } from './tracking-options.js';
import { languageName, LANGUAGES } from './review-ui.js';

export function createReviewTools({ editor, pkg, error, author, review, proofing, commands: w, documentName, openDocument, currentBytes, onChange = () => {} }) {
  const ready = () => { const engine = editor(); return engine && !pkg()?.readOnly ? engine : null; };
  const editorPane = createEditorPane({ editor, pkg, proofing, error, onState: onChange });
  const thesaurus = createThesaurusPane({ editor, pkg, error });
  const accessibility = createAccessibilityPane({ editor, pkg, error, onState: onChange });
  const translator = createTranslatePane({ editor, pkg, error, openDocument, documentName });
  const people = () => {
    const engine = editor(); if (!engine) return [];
    const body = engine.session.body;
    return [...new Set([author(), ...(body.comments || []).map(c => c.author), ...body.revisions.map(r => r.author)].filter(Boolean))];
  };
  const commentsPane = createCommentsPane({ editor, review, people });
  const restrict = createRestrictEditing({ editor, pkg, error, author, onChange });
  restoreTrackingOptions();

  const markDirty = () => { const engine = editor(); engine?.onChange?.(); onChange(); };
  const setSettings = patch => { const p = pkg(); if (!p || p.readOnly) return; p.reviewSettings = { ...p.reviewSettings, ...patch }; markDirty(); };
  const docRevisionView = () => pkg()?.reviewSettings?.revisionView || {};

  /* ---- Language ---- */
  function languageDialog() {
    const engine = ready(); if (!engine) return;
    engine.finishComposition();
    const format = engine.model.runFormatting || {};
    openLanguageDialog({ language: format.fontLanguage || pkg()?.reviewSettings?.defaultLanguage || 'en-US', noProof: !!format.noProof, defaultLanguage: pkg()?.reviewSettings?.defaultLanguage,
      apply: ({ language, noProof }) => { engine.setRunFormat({ fontLanguage: language, noProof }); proofing.recheck?.(); },
      setDefault: language => { setSettings({ defaultLanguage: language }); },
      onClose: () => queueMicrotask(() => editor()?.focus()) });
  }

  /* ---- Tracking display ---- */
  function updateOptions(patch) {
    Object.assign(revisionView.options, patch);
    rememberTrackingOptions();
    // What markup the document shows is also a document setting (§17.15.1 revisionView).
    const view = { ...docRevisionView(), ...(('showInsDel' in patch) ? { insDel: patch.showInsDel } : {}), ...(('showFormatting' in patch) ? { formatting: patch.showFormatting } : {}) };
    if (('showInsDel' in patch || 'showFormatting' in patch) && !pkg()?.readOnly) setSettings({ revisionView: view });
    editor()?.relayout(); review.refresh(true); onChange();
  }
  const markupMenu = () => showMarkupItems({ authors: () => people().filter(name => editor()?.session.body.revisions.some(r => r.author === name) || (editor()?.session.body.comments || []).some(c => c.author === name)),
    ink: w.toggleInk ? { shown: !w.inkHidden?.(), toggle: () => w.toggleInk() } : null,
    comments: { shown: review.commands.shown, toggle: () => review.commands.toggleShown() }, update: updateOptions });
  function trackingOptions() {
    const engine = editor(); if (!engine) return;
    const settings = pkg()?.reviewSettings || {};
    // While tracking is locked, formatting changes are tracked: the setting is shown on and cannot be changed.
    const locked = restrict.trackingLocked;
    openTrackingOptions({ authors: () => people(), doc: { trackMoves: !settings.doNotTrackMoves, trackFormatting: locked || !settings.doNotTrackFormatting, formattingLocked: locked },
      apply: (options, doc) => {
        Object.assign(revisionView.options, options);
        rememberTrackingOptions();
        const trackFormatting = locked ? !settings.doNotTrackFormatting : doc.trackFormatting;
        if (!pkg()?.readOnly && (doc.trackMoves !== !settings.doNotTrackMoves || trackFormatting !== !settings.doNotTrackFormatting)) setSettings({ doNotTrackMoves: !doc.trackMoves, doNotTrackFormatting: !trackFormatting });
        applyTrackingSettings(); review.commands.setPaneOrientation(options.paneOrientation); editor()?.relayout(); review.refresh(true); onChange();
      }, onClose: () => queueMicrotask(() => editor()?.focus()) });
  }
  function applyTrackingSettings() {
    const engine = editor(); if (!engine) return;
    const settings = pkg()?.reviewSettings || {};
    engine.session.body.trackMoves = !settings.doNotTrackMoves;
    engine.session.body.trackFormatting = restrict.trackingLocked || !settings.doNotTrackFormatting;
    revisionView.options.trackMoves = !settings.doNotTrackMoves;
  }
  async function lockTracking() {
    if (restrict.trackingLocked) { await restrict.stopEnforcing({ title: 'Unlock Tracking' }); return; }
    if (restrict.enforced) { error(new Error('Stop the document\'s protection before locking tracking.')); return; }
    review.commands.toggleTracking(true);
    await restrict.startEnforcing({ edit: 'trackedChanges', formatting: false, title: 'Lock Tracking', intro: 'Others will not be able to turn off Track Changes, or accept or reject changes. Enter a password to keep them from unlocking it, or leave it empty.' });
  }

  /* ---- Commands ---- */
  const commands = {
    spelling: () => editorPane.open(),
    editorPane: () => editorPane.open(),
    spellingItems: () => [
      { label: 'Editor', icon: 'spelling', onSelect: () => editorPane.open() },
      { label: 'Check Spelling One by One', icon: 'spell', shortcut: 'F7', onSelect: () => proofing.openPane() },
      { label: 'Check Spelling as You Type', checked: proofing.enabled, onSelect: () => proofing.setEnabled(!proofing.enabled) },
      { separator: true },
      { label: 'Hide Spelling Errors in This Document', checked: !!pkg()?.hideSpellingErrors, disabled: !!pkg()?.readOnly, onSelect: () => commands.toggleHideSpelling() },
      { label: 'Hide Grammar Errors in This Document', checked: !!pkg()?.reviewSettings?.hideGrammaticalErrors, disabled: !!pkg()?.readOnly, onSelect: () => commands.toggleHideGrammar() },
      { separator: true },
      { label: 'Recheck Document', disabled: !proofing.enabled, onSelect: () => proofing.recheck() },
      { label: 'Reset Ignored Words', onSelect: () => commands.resetIgnoredWords() },
    ],
    toggleHideSpelling() { const p = pkg(); if (!p || p.readOnly) return; p.hideSpellingErrors = !p.hideSpellingErrors; editor()?.paint(); markDirty(); },
    toggleHideGrammar() { setSettings({ hideGrammaticalErrors: !pkg()?.reviewSettings?.hideGrammaticalErrors }); editor()?.paint(); editorPane.refresh(); },
    resetIgnoredWords() { proofing.resetIgnored(); toast('Ignored words will be checked again'); editorPane.refresh(); },
    thesaurus: () => { if (editor()) thesaurus.open(); },
    wordCount: () => { const engine = editor(); if (engine) openWordCount(engine, { onClose: () => queueMicrotask(() => editor()?.focus()) }); },
    checkAccessibility: () => accessibility.open(),
    accessibilitySummary: () => accessibility.summary(),
    language: languageDialog,
    languageItems: () => [
      { label: 'Set Proofing Language…', onSelect: languageDialog, disabled: !ready() },
      { label: 'Detect Language Automatically', checked: DETECT_LANGUAGE.get(), onSelect: () => { DETECT_LANGUAGE.set(!DETECT_LANGUAGE.get()); proofing.recheck(); } },
      { separator: true },
      { label: 'Set Default Proofing Language', disabled: !ready(), items: LANGUAGES.map(tag => ({ label: languageName(tag), radio: true, checked: (pkg()?.reviewSettings?.defaultLanguage || 'en-US') === tag, onSelect: () => setSettings({ defaultLanguage: tag }) })) },
    ],
    /** For the status bar: the proofing language at the caret. */
    proofingLanguage() { const engine = editor(); const tag = engine?.model.runFormatting?.fontLanguage || pkg()?.reviewSettings?.defaultLanguage || 'en-US'; return { tag, name: languageName(tag), open: languageDialog }; },
    translateSelection: () => translator.open(),
    translateDocument: () => translator.open(),
    translateItems: () => [
      { label: 'Translate Selection', onSelect: () => translator.open() },
      { label: 'Translate Document', onSelect: () => translator.open() },
      { separator: true },
      { label: 'Set Document Translation Language', items: LANGUAGES.map(tag => ({ label: languageName(tag), radio: true, checked: TRANSLATION_LANGUAGE.get() === tag, onSelect: () => TRANSLATION_LANGUAGE.set(tag) })) },
    ],
    compareDocuments: () => openCompareDialog({ mode: 'compare', editor, pkg, documentName, author, openDocument, currentBytes, error }),
    combineDocuments: () => openCompareDialog({ mode: 'combine', editor, pkg, documentName, author, openDocument, currentBytes, error }),
    restrictEditing: () => restrict.open(),
    protectionEnforced: () => restrict.enforced,
    trackingLocked: () => restrict.trackingLocked,
    lockTracking,
    trackingOptions,
    showMarkupItems: markupMenu,
    commentsPane: () => commentsPane.open(),
    alwaysOpenReadOnly: () => restrict.toggleAlwaysReadOnly(),
  };

  /* ---- Ribbon ---- */
  function extendTab(tabId, kit) {
    if (tabId !== 'review') return [];
    const { command, menuButton, split, rows, when } = kit;
    const quiet = (...buttons) => { for (const b of buttons) b.addEventListener('mousedown', e => e.preventDefault()); return buttons[0]; };
    const accessibilityButton = quiet(command('Check Accessibility', 'accessibility', () => accessibility.open(), { size: 'large', text: 'Check Accessibility' }));
    when(accessibilityButton, () => !!editor());
    const translate = menuButton('Translate', 'translate', commands.translateItems, { size: 'large', text: 'Translate' });
    const language = menuButton('Language', 'language', commands.languageItems, { size: 'large', text: 'Language' });
    when(translate, () => !!editor()); when(language, () => !!editor());
    const compare = menuButton('Compare', 'compare', () => [
      { label: 'Compare…', icon: 'compare', onSelect: commands.compareDocuments },
      { label: 'Combine…', icon: 'combine', onSelect: commands.combineDocuments },
    ], { size: 'large', text: 'Compare' });
    when(compare, () => !!editor());
    const protect = quiet(command('Restrict Editing', 'protect', () => restrict.open(), { size: 'large', text: 'Restrict Editing' }));
    when(protect, () => !!editor() && !pkg()?.readOnly, () => String(restrict.enforced));
    // One-command groups fold to a button as wide as the command, so they never fold; groups that
    // gain room by folding (Language, and the comment and change groups) fold instead.
    const groups = [
      { id: 'accessibility', label: 'Accessibility', icon: 'accessibility', priority: 3, after: 'speech', items: [accessibilityButton] },
      { id: 'language', label: 'Language', icon: 'language', priority: 2.5, after: 'speech', items: [translate, language] },
      { id: 'compare', label: 'Compare', icon: 'compare', priority: 3.5, after: 'changes', items: [compare] },
      { id: 'protect', label: 'Protect', icon: 'protect', priority: 3, after: 'changes', items: [protect] },
    ];
    if (w.toggleInk) {
      const ink = quiet(command('Hide Ink', 'hideInk', () => w.toggleInk(), { size: 'large', text: 'Hide Ink' }));
      when(ink, () => !!editor(), () => String(!!w.inkHidden?.()));
      groups.push({ id: 'ink', label: 'Ink', icon: 'hideInk', priority: 1, after: 'changes', items: [ink] });
    }
    void split; void rows;
    return groups;
  }

  /* ---- Menu bar ---- */
  function extendMenu(menuId) {
    const has = !!editor();
    if (menuId === 'tools') return [
      { label: 'Spelling and Grammar', icon: 'spelling', items: commands.spellingItems() },
      { label: 'Thesaurus…', icon: 'thesaurus', shortcut: 'Shift+F7', disabled: !has, onSelect: commands.thesaurus },
      { label: 'Translate', icon: 'translate', disabled: !has, items: commands.translateItems() },
      { label: 'Language…', icon: 'language', disabled: !ready(), onSelect: languageDialog },
      { separator: true },
      // On a Mac Cmd+Shift+G is Find Previous (editor.js), so Word Count has its chord only elsewhere.
      { label: 'Word Count…', icon: 'wordCount', shortcut: MOD_KEY === 'Cmd' ? null : 'Ctrl+Shift+G', disabled: !has, onSelect: commands.wordCount },
      { separator: true },
      { label: 'Check Accessibility', icon: 'accessibility', disabled: !has, onSelect: commands.checkAccessibility },
      { separator: true },
      { label: 'Track Changes', icon: 'trackChanges', disabled: !has, items: [
        { label: 'Track Changes', checked: review.commands.tracking, disabled: !review.commands.canTrack() || restrict.trackingLocked, onSelect: () => review.commands.toggleTracking() },
        { label: restrict.trackingLocked ? 'Unlock Tracking…' : 'Lock Tracking…', disabled: !ready(), onSelect: lockTracking },
        { label: 'Tracking Options…', onSelect: trackingOptions },
        { separator: true },
        { label: 'Compare Documents…', icon: 'compare', onSelect: commands.compareDocuments },
      ] },
      { label: 'Combine Documents…', icon: 'combine', disabled: !has, onSelect: commands.combineDocuments },
      { separator: true },
      { label: 'Protect Document…', icon: 'protect', disabled: !has || !!pkg()?.readOnly, onSelect: commands.restrictEditing },
    ];
    if (menuId === 'file') return fileItems();
    if (menuId === 'view') return [
      { separator: true },
      { label: 'Markup', icon: 'markup', disabled: !has, items: [
        ...['all', 'simple', 'none', 'original'].map(mode => ({ label: { all: 'All Markup', simple: 'Simple Markup', none: 'No Markup', original: 'Original' }[mode], radio: true, checked: revisionView.mode === mode, onSelect: () => review.commands.setMarkupView(mode) })),
        { separator: true }, ...markupMenu()] },
      { label: 'Reviewing Pane', icon: 'reviewingPane', checked: !!review.commands.paneShown, disabled: !has, onSelect: () => review.commands.toggleReviewingPane() },
      { label: 'Comments Pane', icon: 'showComments', disabled: !has, onSelect: () => commentsPane.open() },
    ];
    if (menuId === 'insert') return [{ label: 'Comment', icon: 'newComment', shortcut: MOD_KEY === 'Cmd' ? 'Cmd+Option+A' : 'Ctrl+Alt+M', disabled: !review.commands.canComment(), onSelect: () => review.commands.newComment() }];
    return [];
  }

  /* ---- Document context menu ---- */
  function contextMenuItems(context) {
    if (context === 'field') return review.contextItems();
    if (context !== 'text' && context !== 'table' && context !== 'list' && context !== 'link') return [];
    const engine = editor(); if (!engine) return [];
    const items = [];
    if (engine.session.path === null || context === 'text') {
      items.push({ label: 'Synonyms', icon: 'thesaurus', disabled: !ready(), submenu: async (anchor, { focusFirst } = {}) => {
        const found = await thesaurus.synonymsAt(8);
        const list = found?.synonyms || [];
        openMenu({ anchor, label: 'Synonyms', focusFirst, items: [
          ...(list.length ? list.map(s => ({ label: s.text, onSelect: () => thesaurus.insert(s.word) })) : [{ note: found ? 'No synonyms found.' : 'Select a word first.' }]),
          { separator: true }, { label: 'Thesaurus…', onSelect: commands.thesaurus }] });
      } });
      items.push({ label: 'Translate', icon: 'translate', disabled: engine.model.range[0] === engine.model.range[1], onSelect: () => translator.open() });
    }
    return [...items, ...review.contextItems()];
  }

  /* ---- Keys ---- */
  const keyAbort = new AbortController();
  window.addEventListener('keydown', e => {
    if (e.defaultPrevented || isComposing(e) || !e.target?.matches?.('.canvas-input')) return;
    const mac = MOD_KEY === 'Cmd';
    if (e.key === 'F7' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey || mac && e.metaKey && e.altKey && !e.shiftKey && shortcutCode(e) === 'KeyR') { e.preventDefault(); commands.thesaurus(); }
    else if (!mac && e.ctrlKey && e.shiftKey && !e.altKey && shortcutCode(e) === 'KeyG') { e.preventDefault(); commands.wordCount(); }
  }, { signal: keyAbort.signal });

  /** Items for the File menu: the read-only recommendation and protection. */
  const fileItems = () => [
    { separator: true },
    { label: 'Always Open Read-Only', icon: 'readOnly', checked: restrict.alwaysReadOnly, disabled: !editor() || !!pkg()?.readOnly, onSelect: commands.alwaysOpenReadOnly },
    { label: 'Protect Document…', icon: 'protect', disabled: !editor() || !!pkg()?.readOnly, onSelect: commands.restrictEditing },
  ];

  return {
    commands, extendTab, extendMenu, contextMenuItems, people, fileItems,
    panes: [editorPane.pane.node, thesaurus.pane.node, accessibility.pane.node, translator.pane.node, commentsPane.pane.node, restrict.pane.node],
    /** Tints the comment layer adds to its own: editable regions under protection. */
    tints: () => restrict.tints(),
    attach(engine) {
      if (!engine.overlays.includes(editorPane.overlay)) engine.overlays.push(editorPane.overlay);
      applyTrackingSettings();
      const view = docRevisionView();
      // The document's own choices, shown or not: those of the document opened before it would otherwise stay.
      Object.assign(revisionView.options, { showInsDel: view.insDel !== false, showFormatting: view.formatting !== false });
      restrict.applyGuard();
      // A protected document opens with its permissions in view, as desktop word processors show them.
      const protection = pkg()?.reviewSettings?.protection;
      if (protection?.enforcement && protection.edit !== 'trackedChanges' && !pkg()?.readOnly) queueMicrotask(() => restrict.open({ focus: false }));
      queueMicrotask(() => restrict.offerReadOnly());
    },
    refresh() { commentsPane.refresh(); restrict.refresh(); },
    changed() { accessibility.changed(); editorPane.changed(); editorPane.refresh(); },
    selectionChanged() { editorPane.selectionChanged(); translator.selectionChanged(); },
    get trackingLocked() { return restrict.trackingLocked; },
    get protectionEnforced() { return restrict.enforced; },
    /** The protection in force, or null. */
    get protection() { return restrict.enforced ? restrict.protection : null; },
    destroy() { keyAbort.abort(); for (const part of [editorPane, thesaurus, accessibility, translator, commentsPane, restrict]) part.destroy(); },
  };
}

