// Entry points for the trip assistant: a side panel, an embedded pane and the palette command.
import { toast } from '../../../ui/toast.js';
import { t } from '../../../lib/i18n/index.js';
import { createPanel } from './panel.js';

export { registerAssistantCommand } from './command.js';

let current = null;

/**
 * Opens the side panel for the trip in `context` (`space`, `account`, `puter`, `session`, `app`; optional `plan`,
 * `redate({start, end})`, and `assistantChat` as a test hook). Opening it again focuses it; another trip replaces it.
 */
export function openAssistant(context) {
  if (!context?.space) { toast(t('assistant.noTrip')); return null; }
  if (current?.space === context.space && current.panel.element.isConnected) { current.panel.focus(); return current.panel; }
  current?.panel.close();
  const opener = document.activeElement;
  const entry = { space: context.space, panel: null };
  const onAbort = () => entry.panel?.close();
  entry.panel = createPanel(context, {
    onClose: () => {
      context.signal?.removeEventListener?.('abort', onAbort);
      if (current === entry) current = null;
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus();
    },
  });
  current = entry;
  document.body.append(entry.panel.element);
  context.signal?.addEventListener?.('abort', onAbort, { once: true });
  entry.panel.focus();
  return entry.panel;
}

export function closeAssistant() { current?.panel.close(); }

/** Renders the assistant inside `container` (a pane the caller sizes). Returns a cleanup function. */
export function mountAssistant(container, context) {
  if (!context?.space) return () => {};
  const panel = createPanel(context, { embedded: true });
  container.replaceChildren(panel.element);
  return () => panel.close();
}
