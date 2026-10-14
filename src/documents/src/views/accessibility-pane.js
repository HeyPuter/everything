/**
 * Check Accessibility: a pane listing issues by severity with Go To and quick fixes, and a summary
 * for the status bar. Fixes are ordinary edits, one undo step each.
 */
import { el } from '../ui/dom.js';
import { promptDialog } from '../ui/modal.js';
import { checkAccessibility, summarize, RULES } from '../lib/accessibility.js';
import { sidePane, button, hint, preference, reveal } from './review-ui.js';

const KEEP_RUNNING = preference('documents:accessibility-live', true);
const SEVERITY = { error: 'Errors', warning: 'Warnings', tip: 'Tips' };
const FIX_LABEL = { altText: 'Add description…', headerRow: 'Use first row as header', autoColor: 'Use automatic color', clearHighlight: 'Remove highlight', removeEmpty: 'Remove empty paragraphs', collapseBlanks: 'Use a single space', deleteRow: 'Delete row' };

export function createAccessibilityPane({ editor, pkg, error, onState = () => {} }) {
  let issues = [], checkedRevision = -1, timer = null;
  const pane = sidePane({ title: 'Accessibility', label: 'Accessibility pane', className: 'rv-accessibility-pane', onOpen: () => run(true), onClose: () => editor()?.focus() });
  const summaryLine = el('p.rv-status', { role: 'status' });
  const list = el('div.rv-groups');
  const live = el('input', { type: 'checkbox', checked: KEEP_RUNNING.get(), onchange: () => { KEEP_RUNNING.set(live.checked); schedule(); onState(); } });
  pane.body.append(summaryLine, list, el('label.rv-check', {}, live, 'Keep checking while I work'), hint('Checks pictures, tables, headings, color contrast, links and spacing in the document body.'));

  const headingLevel = p => { const level = p.format?.outlineLevel; return Number.isInteger(level) && level < 9 ? level + 1 : null; };
  function run(force = false) {
    const engine = editor(); if (!engine) return issues;
    const body = engine.session.body;
    if (!force && body.revision === checkedRevision) return issues;
    checkedRevision = body.revision;
    issues = checkAccessibility({ paragraphs: body.paragraphs, tables: body.tables, pageSettings: body.pageSettings }, { headingLevel });
    if (pane.isOpen) render();
    onState();
    return issues;
  }
  function render() {
    const counts = summarize(issues);
    summaryLine.textContent = issues.length ? `${counts.errors} errors · ${counts.warnings} warnings · ${counts.tips} tips` : 'No accessibility issues found. People with disabilities should be able to read this document.';
    list.replaceChildren(...Object.entries(SEVERITY).map(([severity, title]) => {
      const own = issues.filter(i => i.severity === severity);
      if (!own.length) return null;
      const byRule = new Map();
      for (const issue of own) { if (!byRule.has(issue.rule)) byRule.set(issue.rule, []); byRule.get(issue.rule).push(issue); }
      return el('section.rv-section', {}, el('h3.rv-section-title', {}, `${title} (${own.length})`),
        ...[...byRule].map(([rule, items]) => el('details.rv-rule', { open: items.length <= 6 },
          el('summary', {}, `${RULES[rule].title} (${items.length})`),
          el('p.rv-why', {}, RULES[rule].why),
          ...items.map(issue => el('div.rv-item.rv-issue', { dataset: { rule } },
            el('button.rv-issue-target', { type: 'button', onclick: () => reveal(editor(), issue.start, issue.end) }, issue.detail),
            issue.fix && !pkg()?.readOnly ? button(FIX_LABEL[issue.fix.kind] || 'Fix', () => fix(issue)) : null)))));
    }).filter(Boolean));
  }
  function schedule() {
    clearTimeout(timer);
    if (pane.isOpen || KEEP_RUNNING.get()) timer = setTimeout(() => run(), 600);
  }

  async function fix(issue) {
    const engine = editor(); if (!engine) return;
    const { kind } = issue.fix;
    engine.finishComposition();
    if (engine.session.path !== null) engine.editStory(null);
    const at = (start, end = start) => engine.model.select(start, end);
    const tableCell = cellId => { const index = engine.model.paragraphs.findIndex(p => p.cellId === cellId); let offset = 0; for (let i = 0; i < index; i++) offset += engine.model.paragraphs[i].runs.reduce((n, r) => n + r.text.length, 0) + 1; return offset; };
    try {
      if (kind === 'altText') {
        const text = await promptDialog({ title: 'Picture description', label: 'Description', multiline: true, confirmLabel: 'Apply', hint: 'Describe what the picture shows and why it matters, in a sentence or two.' });
        if (!text) return;
        engine.execute(() => { at(issue.start, issue.end); engine.model.setImageProperties({ alt: text }); });
      } else if (kind === 'headerRow') engine.execute(() => { at(tableCell(issue.fix.cellId)); engine.model.setTableHeaderRows(1); });
      else if (kind === 'deleteRow') engine.execute(() => { at(tableCell(issue.fix.cellId)); engine.model.deleteTablePart('row'); });
      else if (kind === 'autoColor') engine.execute(() => { at(issue.start, issue.end); engine.model.setRunFormat({ color: 'auto' }); });
      else if (kind === 'clearHighlight') engine.execute(() => { at(issue.start, issue.end); engine.model.setRunFormat({ highlight: 'none', shading: 'auto' }); });
      else if (kind === 'collapseBlanks') engine.execute(() => { const blank = engine.model.text.slice(issue.start, issue.end); at(issue.start, issue.end); engine.model.replace(blank[0] === '\t' ? '\t' : ' '); });
      else if (kind === 'removeEmpty') engine.execute(() => {
        // Keep one blank paragraph's worth of space by removing all but the first.
        const ids = new Set(issue.fix.paragraphs.slice(1));
        for (let i = engine.model.paragraphs.length - 1; i >= 0; i--) {
          if (!ids.has(engine.model.paragraphs[i].id)) continue;
          let offset = 0; for (let k = 0; k < i; k++) offset += engine.model.paragraphs[k].runs.reduce((n, r) => n + r.text.length, 0) + 1;
          at(offset - 1, offset);
          engine.model.replace('');
        }
      });
    } catch (e) { error(e); }
    engine.focus();
    run(true);
  }

  return {
    pane,
    open() { pane.open(); run(true); },
    changed() { schedule(); },
    /** For the status bar: { errors, warnings, tips, label } or null while not checked. */
    summary() {
      if (!KEEP_RUNNING.get() && !pane.isOpen) return null;
      const engine = editor(); if (!engine) return null;
      if (engine.session.body.revision !== checkedRevision) schedule();
      const counts = summarize(issues);
      const label = !issues.length ? 'Accessibility: good to go' : counts.errors ? `Accessibility: ${counts.errors} ${counts.errors === 1 ? 'error' : 'errors'} to fix` : 'Accessibility: worth a look';
      return { ...counts, label, open: () => this.open() };
    },
    get issues() { return run(); },
    destroy() { clearTimeout(timer); pane.destroy(); },
  };
}
