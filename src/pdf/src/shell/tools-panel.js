import { el, formatShortcut, icon, iconButton } from '../lib/ui.js';
import { toolIcon } from './icons.js';

/**
 * The left-hand tools panel. It lists every tool ("All tools") and, once one is chosen, shows
 * that tool's own commands in sections, the way a desktop PDF editor swaps its tool pane.
 *
 * catalog: [{ id, label, icon, group, featured?, description?, permission?,
 *             run?: () => void,                    // a one-step tool (opens a dialog)
 *             sections?: () => [{ title?, items: [item] }],
 *             enter?: () => void, leave?: () => void,
 *             takesView?: boolean }]           // enter() replaces the page with its own view
 * item:    { label, icon? (tool icon name) | glyph? (Lucide name), onSelect, disabled?,
 *            pressed?, shortcut?, hint?, permission?, danger? }
 */
export function createToolsPanel({ catalog, can = () => true, onClose, onChange, onAct }) {
  let current = null; // the open tool's id, or null for the list
  let expanded = false;
  const heading = el('h2', { class: 'tools-panel-title', id: 'tools-panel-title' }, 'All tools');
  const back = iconButton('Back to all tools', 'ArrowLeft', () => showAll(true), {
    class: 'icon-btn tools-back',
    hidden: true,
  });
  const headIcon = el('span', { class: 'tools-head-icon', hidden: true });
  const body = el('div', { class: 'tools-panel-body' });
  const root = el(
    'section',
    { class: 'tools-panel', 'aria-labelledby': 'tools-panel-title' },
    el(
      'div',
      { class: 'tools-panel-head' },
      back,
      headIcon,
      heading,
      iconButton('Close tools panel', 'X', () => onClose?.(), { class: 'icon-btn tools-close' }),
    ),
    body,
  );
  const find = (id) => catalog().find((tool) => tool.id === id);
  const allowed = (entry) => !entry.permission || [entry.permission].flat().every((p) => can(p));

  function toolRow(tool) {
    return el(
      'button',
      {
        type: 'button',
        class: 'tool-row',
        'data-tool': tool.id,
        title: tool.description || tool.label,
        disabled: !allowed(tool) || tool.disabled,
        onclick: () => open(tool.id, { focus: true }),
      },
      toolIcon(tool.icon || tool.id, 20),
      el('span', { class: 'tool-row-label' }, tool.label),
    );
  }

  function renderList() {
    const tools = catalog().filter((tool) => !tool.hidden);
    const featured = tools.filter((tool) => tool.featured);
    const list = el('div', { class: 'tool-list', role: 'list' });
    if (!expanded) {
      list.append(...featured.map((tool) => el('div', { role: 'listitem' }, toolRow(tool))));
      body.replaceChildren(
        list,
        el(
          'button',
          {
            type: 'button',
            class: 'tools-more',
            onclick: () => {
              expanded = true;
              renderList();
              body.querySelector('.tool-row')?.focus();
            },
          },
          'View more',
        ),
      );
      return;
    }
    const groups = [];
    for (const tool of tools) {
      let group = groups.find((entry) => entry.name === tool.group);
      if (!group) groups.push((group = { name: tool.group, tools: [] }));
      group.tools.push(tool);
    }
    body.replaceChildren(
      ...groups.map((group) =>
        el(
          'div',
          { class: 'tool-group-block' },
          el('h3', { class: 'tool-group-title' }, group.name),
          el(
            'div',
            { class: 'tool-list', role: 'list' },
            ...group.tools.map((tool) => el('div', { role: 'listitem' }, toolRow(tool))),
          ),
        ),
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'tools-more',
          onclick: () => {
            expanded = false;
            renderList();
            // The pressed button was replaced; its successor, View more, keeps the focus.
            body.querySelector('.tools-more')?.focus();
          },
        },
        'View less',
      ),
    );
  }

  function commandButton(item) {
    const disabled = !!item.disabled || !allowed(item);
    const node = el(
      'button',
      {
        type: 'button',
        class: `tool-command${item.danger ? ' danger' : ''}`,
        // The hint is a description; the command is named by its label alone.
        'aria-label': item.label,
        disabled,
        title: item.shortcut
          ? `${item.label} (${formatShortcut(item.shortcut)})`
          : item.hint || item.label,
        ...(item.pressed != null && { 'aria-pressed': String(!!item.pressed) }),
        onclick: () => {
          if (node.disabled) return;
          item.onSelect?.();
          onAct?.();
        },
      },
      item.icon ? toolIcon(item.icon, 20) : item.glyph ? icon(item.glyph, 18) : null,
      el(
        'span',
        { class: 'tool-command-text' },
        el('span', { class: 'tool-command-label' }, item.label),
        item.hint && el('span', { class: 'tool-command-hint' }, item.hint),
      ),
      item.shortcut && el('kbd', { class: 'tool-command-key' }, formatShortcut(item.shortcut)),
    );
    return node;
  }

  function renderTool(tool) {
    const sections = (tool.sections?.() || []).filter(Boolean);
    body.replaceChildren(
      ...(tool.description ? [el('p', { class: 'tool-description' }, tool.description)] : []),
      ...sections.map((section) =>
        el(
          'div',
          { class: 'tool-section', role: 'group', 'aria-label': section.title || tool.label },
          section.title && el('h3', { class: 'tool-section-title' }, section.title),
          section.content ||
            el(
              'div',
              { class: 'tool-commands' },
              ...section.items.filter(Boolean).map((item) => commandButton(item)),
            ),
        ),
      ),
    );
  }

  function render() {
    const tool = current && find(current);
    back.hidden = !tool;
    headIcon.hidden = !tool;
    headIcon.replaceChildren(...(tool ? [toolIcon(tool.icon || tool.id, 20)] : []));
    heading.textContent = tool ? tool.label : 'All tools';
    root.dataset.tool = tool ? tool.id : 'all';
    if (tool) renderTool(tool);
    else renderList();
  }

  /** Open a tool: a one-step tool runs; one with commands takes over the panel. */
  function open(id, { focus = false } = {}) {
    const tool = find(id);
    if (!tool || !allowed(tool)) return false;
    if (tool.run && !tool.sections) {
      tool.run();
      onAct?.();
      return true;
    }
    if (current && current !== id) find(current)?.leave?.();
    const entering = current !== id;
    current = id;
    render();
    if (entering) tool.enter?.();
    onChange?.(current);
    if (entering && tool.takesView) onAct?.();
    if (focus) (body.querySelector('button:not(:disabled)') || back).focus();
    return true;
  }

  function showAll(focus = false) {
    if (current) find(current)?.leave?.();
    current = null;
    render();
    onChange?.(null);
    if (focus) body.querySelector('.tool-row')?.focus();
  }

  render();
  return {
    root,
    open,
    showAll,
    get current() {
      return current;
    },
    /** Redraw with fresh enabled and pressed states, keeping keyboard focus where it was. */
    refresh() {
      const focused = document.activeElement;
      // View more and View less have no label of their own; the list has one such button.
      const keyOf = (b) =>
        b.classList?.contains('tools-more')
          ? 'tools-more'
          : b.querySelector?.('.tool-command-label, .tool-row-label')?.textContent;
      const key = body.contains(focused) ? keyOf(focused) : null;
      render();
      if (key)
        [...body.querySelectorAll('button')]
          .find((b) => keyOf(b) === key)
          ?.focus({ preventScroll: true });
    },
  };
}
