import { el, focusables, coarsePointer } from "./dom.js";
import { icon } from "./icons.js";

let root = null;

/**
 * How many toasts may stand at once. They stack upward from the bottom of
 * the window, over the composer: a burst (every message of an outbox that
 * failed on reconnect, a workspace whose links all answer with an error)
 * used to pile up without end, and eight of them covered the composer and
 * the last messages. Past this many the oldest goes early; one that must not
 * be missed (the update prompt, kept until acted on) stays whatever comes.
 */
const MAX_TOASTS = 4;
const entries = new WeakMap(); // node -> { dismiss, sticky }

/** One live region for the whole app, in place before anything posts to it. */
function ensureRoot() {
  if (!root) {
    root = el("div.toast-root", {
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "false",
    });
    document.body.append(root);
  }
  return root;
}

if (document.body) ensureRoot();
else document.addEventListener("DOMContentLoaded", ensureRoot, { once: true });

/**
 * toast('Saved')
 * toast('Deleted', { icon: 'trash', action: { label: 'Undo', onClick } })
 * toast('A new version is ready', { duration: Infinity, dismissible: true, action })
 *
 * A toast leaves on its own after `duration` (longer with an action), held
 * while the pointer or the keyboard is on it. `duration: Infinity` keeps it
 * until it is acted on: news that must not be missed (an update waiting)
 * rather than a confirmation; `dismissible` adds a way to put it away.
 * `onDismiss`, given only with `dismissible`, fires on that close button
 * alone — not on the timeout or on the action — for the rare offer whose
 * being waved away is itself worth remembering (see the events consent
 * toast, src/ui/shell.js).
 */
export function toast(
  message,
  {
    icon: name = "check",
    duration,
    action = null,
    dismissible = false,
    onDismiss = null,
  } = {},
) {
  const ms = duration ?? (action ? 6000 : 2600);
  const sticky = ms === Infinity;
  let timer = null;
  let gone = false;

  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    node.classList.add("leaving");
    node.addEventListener("animationend", () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 400);
  };

  // Where the keyboard was when the toast came (the message box, the control
  // whose press brought it). A button of the toast pressed from the keyboard
  // takes the toast away, and the button with it, so the keyboard fell to
  // the page and the next Tab started over from the top of the window: it
  // goes back there instead, or to the message box, or to the first control
  // of the main column. Pressed with a mouse, the keyboard is elsewhere and
  // stays. Before the action, so one that moves the keyboard itself (Open,
  // on a forward's toast) has the last word. Not to a text box under a
  // finger: a tap puts the keyboard on the button too (Chrome focuses a
  // tapped button), and the message box focused in its place brought the
  // phone's keyboard up over the page for a press that asked for nothing
  // to be typed. On a touch screen the keyboard goes back to a control that
  // is not a text box, or nowhere.
  const opener = document.activeElement;
  const rendered = (n) =>
    n instanceof HTMLElement && n.isConnected && n.getClientRects().length > 0;
  const textBox = (n) => /^(input|textarea)$/i.test(n.localName || "");
  const handBack = () => {
    if (!node.contains(document.activeElement)) return;
    const finger = coarsePointer();
    const back =
      opener !== document.body &&
      rendered(opener) &&
      !node.contains(opener) &&
      !(finger && textBox(opener))
        ? opener
        : finger
          ? null
          : document.querySelector(".main textarea") ||
            focusables(document.querySelector(".main") || document.body)[0];
    back?.focus({ preventScroll: true });
  };

  // Once: the press takes the toast away, but the toast fades for a fifth of
  // a second before it is gone and its buttons take presses the while, and
  // each press ran the action again (a double click on Open, on Join, on
  // an Undo). A toast that has been pressed takes no second press.
  const node = el(
    "div.toast",
    { html: icon(name, 16, 2.2) },
    el("span", {}, message),
    action &&
      el(
        "button.toast-action",
        {
          type: "button",
          onclick: () => {
            if (gone) return;
            dismiss();
            handBack();
            action.onClick();
          },
        },
        action.label,
      ),
    dismissible &&
      el("button.toast-close", {
        type: "button",
        html: icon("x", 14, 2.4),
        "aria-label": "Dismiss",
        title: "Dismiss",
        onclick: () => {
          if (gone) return;
          dismiss();
          handBack();
          onDismiss?.();
        },
      }),
  );

  // Never armed for a sticky toast: a timer of Infinity is clamped to a
  // moment by every runtime, and would take the toast away at once.
  const arm = (t) => {
    if (sticky) return;
    clearTimeout(timer);
    timer = setTimeout(dismiss, t);
  };
  const hold = () => clearTimeout(timer);
  const release = () => {
    if (!gone) arm(1500);
  };
  node.addEventListener("pointerenter", hold);
  node.addEventListener("pointerleave", release);
  node.addEventListener("focusin", hold);
  node.addEventListener("focusout", release);

  ensureRoot().append(node);
  entries.set(node, { dismiss, sticky });
  // Room for this one: the oldest that may go leave first.
  const standing = [...root.querySelectorAll(".toast:not(.leaving)")];
  let over = standing.length - MAX_TOASTS;
  for (const n of standing) {
    if (over <= 0) break;
    const e = entries.get(n);
    if (!e || e.sticky) continue;
    e.dismiss();
    over--;
  }
  arm(ms);
  return { dismiss };
}
