// Quick Actions Bar: a small floating bar under the selection (or near the
// bottom of the canvas) offering the likely next steps. Hidden while a tool is
// dragging, during transforms and modal work; dismissible and remembered.
import type { Editor } from '../../editor';
import { commands, registerCommand } from '../../app/registry';
import { svg } from '../../app/icons';
import { escapeXML } from '../../model/assets';

const KEY = 'photo-studio-taskbar';
let visible = true;
try {
  visible = localStorage.getItem(KEY) !== 'off';
} catch {
  /* Preferences are optional. */
}
function save() {
  try {
    localStorage.setItem(KEY, visible ? 'on' : 'off');
  } catch {
    /* Optional. */
  }
}

type Action = { id: string; label: string; icon: string };
function actionsFor(e: Editor): Action[] {
  if (!e.hasDocument) return [];
  if (e.doc.selection)
    return [
      { id: 'edit.context-fill-apply', label: 'Context Fill', icon: 'sparkle' },
      { id: 'edit.ai-fill', label: 'AI Fill', icon: 'sparkles' },
      { id: 'select.inverse', label: 'Invert', icon: 'arrow-left-right' },
      { id: 'select.modify-feather', label: 'Feather', icon: 'feather' },
      { id: 'layer.mask-reveal-selection', label: 'Mask', icon: 'mask-add' },
      { id: 'select.deselect', label: 'Deselect', icon: 'x' },
    ];
  const l = e.layer;
  if (l && (l.kind === 'pixel' || l.kind === 'image'))
    return [
      { id: 'select.subject', label: 'Select Subject', icon: 'scan-face' },
      { id: 'layer.remove-background', label: 'Remove Background', icon: 'eraser' },
    ];
  return [];
}

export function installTaskbar(e: Editor) {
  const bar = document.createElement('div');
  bar.className = 'contextual-taskbar canvas-ui';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Quick actions bar');
  bar.hidden = true;
  let signature = '';
  let placed = false;
  const place = () => {
    if (bar.hidden) return;
    const viewport = e.el('#viewport');
    const vr = viewport.getBoundingClientRect();
    const bw = bar.offsetWidth,
      bh = bar.offsetHeight;
    let cx = vr.width / 2,
      top = vr.height - bh - 28;
    const s = e.doc.selection;
    if (s) {
      const [x0, y1] = e.clientPoint(s.x, s.y + s.height);
      const [x1, y0] = e.clientPoint(s.x + s.width, s.y);
      cx = (x0 + x1) / 2 - vr.left;
      top = y1 - vr.top + 14;
      // Not enough room below: place it above the selection.
      if (top + bh > vr.height - 8) top = y0 - vr.top - bh - 14;
    }
    bar.style.left = `${Math.round(Math.max(8, Math.min(vr.width - bw - 8, cx - bw / 2)))}px`;
    bar.style.top = `${Math.round(Math.max(8, Math.min(vr.height - bh - 8, top)))}px`;
    placed = true;
  };
  let recheck = 0;
  const render = () => {
    // Commands update the document while the editor is busy; look again once they finish.
    clearTimeout(recheck);
    if (e.busy || e.toolBusy) recheck = window.setTimeout(render, 120);
    const blocked = !visible || e.toolBusy || e.busy || e.transform.active || !!document.querySelector('dialog[open]');
    const list = blocked ? [] : actionsFor(e).filter((a) => commands.has(a.id));
    const sig = list.map((a) => `${a.id}:${commands.get(a.id)!.enabled?.(e) !== false}`).join('|');
    bar.hidden = !list.length;
    if (sig !== signature) {
      signature = sig;
      bar.innerHTML =
        list
          .map((a) => {
            const on = commands.get(a.id)!.enabled?.(e) !== false;
            return `<button type="button" data-taskbar="${a.id}" ${on ? '' : 'disabled'} title="${escapeXML(commands.get(a.id)!.description ?? a.label)}">${svg(a.icon, 15)}<span>${escapeXML(a.label)}</span></button>`;
          })
          .join('') + `<button type="button" class="taskbar-close" data-taskbar-close aria-label="Hide the quick actions bar" title="Hide (Window › Quick Actions Bar)">${svg('x', 14)}</button>`;
      placed = false;
    }
    if (!bar.hidden) place();
    else placed = false;
  };
  bar.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  bar.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest('[data-taskbar-close]')) {
      visible = false;
      save();
      render();
      e.message('Quick actions bar hidden. Show it again from Window › Quick Actions Bar.');
      return;
    }
    const b = t.closest<HTMLButtonElement>('[data-taskbar]');
    if (b && !b.disabled) void e.runCommand(b.dataset.taskbar!).then(render);
  });
  e.el('#viewport').append(bar);
  e.onUpdate(render);
  // Pan and zoom move the stage; follow it.
  new MutationObserver(() => placed && place()).observe(e.el('#stage'), { attributes: true, attributeFilter: ['style'] });
  window.addEventListener('resize', () => placed && place());
  // Dialogs open and close without an update; re-check cheaply.
  let lastBlocked = false;
  window.setInterval(() => {
    const blocked = !!document.querySelector('dialog[open]');
    if (blocked !== lastBlocked) {
      lastBlocked = blocked;
      render();
    }
  }, 250);
  registerCommand({
    id: 'window.contextual-taskbar',
    label: 'Quick Actions Bar',
    checked: () => visible,
    recordable: false,
    run: () => {
      visible = !visible;
      save();
      render();
    },
  });
}
