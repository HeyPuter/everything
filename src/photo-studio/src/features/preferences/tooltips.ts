// Interface → Show tooltips and Rich tooltips. Tooltips are the elements'
// native `title` text: turning them off moves the text aside while the
// pointer is over an element; rich tooltips extend the text of commands and
// tools with their shortcut and a description.
import type { Editor } from '../../editor';
import { findCommand, panels, tools } from '../../app/registry';
import { formatShortcut } from '../../app/shortcuts';
import { groupTools } from '../../app/toolbar';

// The element's own title, kept while the shown text differs from it.
const ORIGINAL = 'data-ps-title';

/** Extra lines for command buttons and toolbar tools, or ''. */
export function richTooltipText(el: HTMLElement, title: string): string {
  const toolId = el.dataset.tool;
  if (toolId && el.classList.contains('tool-slot')) {
    const t = tools.get(toolId);
    if (!t) return '';
    const others = groupTools(t.group).filter((x) => x.id !== t.id);
    return others.length ? `Also in this slot: ${others.map((x) => x.label.replace(/ Tool$/, '')).join(', ')}.` : '';
  }
  const panelId = el.dataset.stripPanel;
  if (panelId) {
    const p = panels.get(panelId);
    const key = formatShortcut(p?.shortcut);
    return [key ? `Shortcut: ${key}` : '', 'Opens beside the dock; drag to rearrange.'].filter(Boolean).join('\n');
  }
  const id = el.dataset.command;
  const c = id ? findCommand(id) : undefined;
  if (!c) return '';
  const lines: string[] = [];
  const key = formatShortcut(c.shortcut);
  if (key && !title.includes(key)) lines.push(`Shortcut: ${key}`);
  if (c.description && !title.includes(c.description)) lines.push(c.description);
  return lines.join('\n');
}

function sync(e: Editor, el: HTMLElement) {
  // Buttons whose tooltip names their command's key follow the Keyboard
  // Shortcuts editor (and drop the key when it was removed).
  const template = el.dataset.keyTitle;
  if (template !== undefined) {
    const key = formatShortcut(findCommand(el.dataset.command ?? '')?.shortcut);
    el.setAttribute('title', template.replace('{key}', key ? ` (${key})` : ''));
    el.removeAttribute(ORIGINAL);
  }
  // A title set again by its owner since the last change replaces the original.
  const title = el.getAttribute('title');
  let original = el.getAttribute(ORIGINAL);
  if (title !== null && (original === null || !title.startsWith(original))) original = title;
  if (original === null) return;
  const p = e.preferences;
  let shown: string | null = original;
  if (!p.showTooltips) shown = null;
  else if (p.richTooltips) {
    const extra = richTooltipText(el, original);
    if (extra) shown = `${original}\n${extra}`;
  }
  if (shown === original) {
    el.setAttribute('title', original);
    el.removeAttribute(ORIGINAL);
    return;
  }
  el.setAttribute(ORIGINAL, original);
  if (shown === null) el.removeAttribute('title');
  else el.setAttribute('title', shown);
}

export function installTooltips(e: Editor) {
  document.addEventListener(
    'pointerover',
    (ev) => {
      const el = (ev.target as HTMLElement | null)?.closest?.<HTMLElement>(`[title],[${ORIGINAL}]`);
      if (el) sync(e, el);
    },
    true,
  );
}
