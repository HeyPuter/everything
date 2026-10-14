// Live embeds are sandboxed iframes in a DOM layer over the canvas. They
// follow pan and zoom, and close when scrolled out of view, when another
// object is selected, or with Escape, so in practice one is open at a time;
// MAX_LIVE caps them regardless, so large boards only pay for the frames
// someone is actually using. The same layer holds Open link under a
// selected link card.
import { createElement, ExternalLink } from "lucide";
import { t } from "../i18n.js";
import { authoredTextHTML } from "../accessibility/object-content.js";
import { canonicalLanguage } from "../accessibility/language-tag.js";
import {
  embedSource,
  frameAttributes,
  providerGroup,
  providerName as name,
} from "./providers.js";

// Provider names are shown in the interface language, as on the card.
const providerName = (provider) => t(name(provider));

export const MAX_LIVE = 3;
let nextLabel = 0;

const captionHTML = (i) =>
  i.text ? authoredTextHTML(i) : authoredTextHTML({}, providerName(i.provider));

export function createLiveEmbeds(api) {
  const live = new Map();
  const captions = new WeakMap();
  let layer = null,
    opener = null,
    linkOpener = null;

  function updateCaption(label, i, html = captionHTML(i)) {
    if (captions.get(label) === html) return;
    label.innerHTML = html;
    captions.set(label, html);
  }

  function allowed(i) {
    const group = providerGroup(i.provider);
    if (!group || api.allows(group)) return "";
    return (
      api.offReason?.(group) ||
      (group === "google"
        ? "Your organization has turned off Google Workspace integrations."
        : "Your organization has turned off embedded content.")
    );
  }
  function ensureLayer() {
    const wrap = document.querySelector(".canvas-wrap");
    if (!wrap) return null;
    if (layer?.isConnected && layer.parentNode === wrap) return layer;
    for (const entry of live.values()) entry.node.remove();
    live.clear();
    layer = document.createElement("div");
    layer.className = "embed-layer";
    opener = document.createElement("button");
    opener.type = "button";
    opener.className = "embed-open";
    opener.hidden = true;
    const action = document.createElement("span");
    action.id = `embed-open-action-${++nextLabel}`;
    action.textContent = t("Open live");
    const caption = document.createElement("span");
    caption.id = `embed-open-caption-${++nextLabel}`;
    caption.className = "sr-only";
    opener.setAttribute("aria-labelledby", `${action.id} ${caption.id}`);
    opener.append(action, caption);
    opener.onclick = () => {
      const i = selectedEmbed();
      if (i) open(i);
    };
    // A link card's Open link is a real link to its address, for everyone
    // who can see the card: on a read-only board or with the card locked,
    // the Edit link dialog that also opens it is not available.
    linkOpener = document.createElement("a");
    linkOpener.className = "embed-open link-open";
    linkOpener.target = "_blank";
    linkOpener.rel = "noopener noreferrer";
    linkOpener.hidden = true;
    const linkIcon = createElement(ExternalLink);
    linkIcon.setAttribute("aria-hidden", "true");
    linkIcon.setAttribute("stroke-width", "2");
    const linkAction = document.createElement("span");
    linkAction.id = `link-open-action-${++nextLabel}`;
    linkAction.textContent = t("Open link");
    const linkCaption = document.createElement("span");
    linkCaption.id = `link-open-caption-${++nextLabel}`;
    linkCaption.className = "sr-only";
    linkOpener.setAttribute(
      "aria-labelledby",
      `${linkAction.id} ${linkCaption.id}`,
    );
    linkOpener.append(linkIcon, linkAction, linkCaption);
    layer.append(opener, linkOpener);
    wrap.append(layer);
    return layer;
  }
  function selectedEmbed() {
    const selection = api.selection();
    if (selection.size !== 1) return null;
    const i = api.board()?.items.find((x) => selection.has(x.id));
    return i?.type === "embed" && !api.hidden?.(i.id) ? i : null;
  }
  // A selected link card to a web address, which Open link follows.
  function selectedLink() {
    const selection = api.selection();
    if (selection.size !== 1) return null;
    const i = api.board()?.items.find((x) => selection.has(x.id));
    if (i?.type !== "link" || api.hidden?.(i.id)) return null;
    try {
      return ["http:", "https:"].includes(new URL(i.url).protocol) ? i : null;
    } catch {
      return null;
    }
  }
  function close(id, focus = false) {
    const entry = live.get(id);
    if (!entry) return;
    entry.node.remove();
    live.delete(id);
    if (!focus) return;
    // Focus goes back to the Open live button that opened the embed, which
    // returns while the embed stays selected, and otherwise to the canvas.
    if (!rendering) render();
    if (entry.origin === opener && !opener.hidden)
      opener.focus({ preventScroll: true });
    else document.querySelector("#canvas")?.focus({ preventScroll: true });
  }
  function closeAll(focus = false) {
    for (const id of [...live.keys()]) close(id);
    if (focus)
      document.querySelector("#canvas")?.focus({ preventScroll: true });
  }
  function open(i) {
    if (!i || api.hidden?.(i.id)) return false;
    const origin = document.activeElement;
    if (!ensureLayer()) return false;
    const blocked = allowed(i);
    if (blocked) {
      api.toast(blocked);
      return false;
    }
    const src = embedSource(i),
      attributes = frameAttributes(i.provider);
    if (!src || !attributes) {
      api.toast("This embed link is no longer supported.");
      return false;
    }
    // Never frame this application itself: sandboxed same-origin content
    // could otherwise remove its own sandbox.
    if (new URL(src).origin === location.origin) {
      api.toast("This embed link is no longer supported.");
      return false;
    }
    if (live.has(i.id)) {
      live.get(i.id).node.querySelector(".embed-close").focus();
      return true;
    }
    while (live.size >= MAX_LIVE) close(live.keys().next().value);
    const title = i.text || providerName(i.provider);
    const node = document.createElement("section");
    node.className = "embed-live";
    const prefix = document.createElement("span");
    prefix.id = `embed-live-prefix-${++nextLabel}`;
    prefix.className = "sr-only";
    prefix.textContent = t("Live embed");
    const header = document.createElement("div");
    header.className = "embed-live-header";
    const label = document.createElement("span");
    label.id = `embed-live-caption-${++nextLabel}`;
    updateCaption(label, i);
    label.setAttribute("data-user-content", "");
    node.setAttribute("aria-labelledby", `${prefix.id} ${label.id}`);
    const link = document.createElement("a");
    link.href = i.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    // On narrow screens only the icon shows; the words stay as its name.
    link.title = t("Open in new tab");
    const linkIcon = createElement(ExternalLink);
    linkIcon.setAttribute("aria-hidden", "true");
    const linkText = document.createElement("span");
    linkText.textContent = t("Open in new tab");
    link.append(linkIcon, linkText);
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "embed-close";
    closeButton.textContent = t("Close");
    closeButton.setAttribute("aria-label", t("Close live embed"));
    closeButton.onclick = () => close(i.id, true);
    header.append(label, link, closeButton);
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", attributes.sandbox);
    frame.setAttribute("allow", attributes.allow);
    frame.setAttribute("referrerpolicy", attributes.referrerpolicy);
    frame.setAttribute("loading", "lazy");
    frame.title = title;
    frame.setAttribute("aria-labelledby", label.id);
    const lang = i.text && canonicalLanguage(i.lang);
    if (lang) frame.lang = lang;
    frame.src = src;
    node.append(header, frame, prefix);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(i.id, true);
      }
    });
    layer.append(node);
    live.set(i.id, {
      node,
      frame,
      label,
      prefix,
      url: i.url,
      provider: i.provider,
      origin,
    });
    render();
    closeButton.focus({ preventScroll: true });
    return true;
  }
  // The Open live button hides with its embed's selection, as when Escape
  // clears it or Delete removes the embed; if it had focus, the canvas
  // takes it rather than the page.
  function showOpener(show, button = opener) {
    if (!show && !button.hidden && button.contains(document.activeElement))
      document.querySelector("#canvas")?.focus({ preventScroll: true });
    button.hidden = !show;
  }
  let rendering = false;
  function render() {
    rendering = true;
    try {
      layout();
    } finally {
      rendering = false;
    }
  }
  function layout() {
    const board = api.board();
    if (!board) {
      closeAll();
      return;
    }
    if (!ensureLayer()) return;
    // Runs on every frame: nothing open and no embed or link card selected
    // needs no layout reads.
    const link = selectedLink();
    if (!live.size && !selectedEmbed() && !link) {
      showOpener(false);
      showOpener(false, linkOpener);
      return;
    }
    const view = api.view(),
      canvas = document.querySelector("#canvas");
    const wrapRect = layer.parentNode.getBoundingClientRect(),
      rect = canvas.getBoundingClientRect();
    const ox = rect.left - wrapRect.left,
      oy = rect.top - wrapRect.top;
    const selection = api.selection();
    // A live embed covers its card. On narrow screens, where the header
    // and toolbars are docked above the board, it is kept within the
    // visible board and below the board's top controls, so its header and
    // Close stay in reach when the card is partly off-screen or larger than
    // the phone; wider screens, whose header and tool rail float over the
    // board, keep it exactly over its card.
    const fit = rect.width < 760;
    const margin = 8,
      controls =
        live.size && fit
          ? [...layer.parentNode.querySelectorAll(".canvas-top > *")]
              .map((control) => control.getBoundingClientRect())
              .filter((box) => box.width && box.height)
          : [];
    const place = (node, i) => {
      if (!fit) {
        node.style.left = `${ox + i.x * view.z + view.x}px`;
        node.style.top = `${oy + i.y * view.z + view.y}px`;
        node.style.width = `${Math.max(0, i.w * view.z)}px`;
        node.style.height = `${Math.max(0, i.h * view.z)}px`;
        return;
      }
      const minX = ox + margin,
        maxX = ox + rect.width - margin,
        maxY = oy + rect.height - margin;
      const w = Math.min(Math.max(0, i.w * view.z), Math.max(0, maxX - minX)),
        x = Math.min(Math.max(ox + i.x * view.z + view.x, minX), maxX - w);
      // The top controls only push down an embed that is under them.
      let minY = oy + margin;
      for (const box of controls)
        if (x < box.right - wrapRect.left && x + w > box.left - wrapRect.left)
          minY = Math.max(minY, box.bottom - wrapRect.top + margin);
      const h = Math.min(Math.max(0, i.h * view.z), Math.max(0, maxY - minY)),
        y = Math.min(Math.max(oy + i.y * view.z + view.y, minY), maxY - h);
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.style.width = `${w}px`;
      node.style.height = `${h}px`;
    };
    for (const [id, entry] of live) {
      const i = board.items.find((x) => x.id === id);
      const x = i && i.x * view.z + view.x,
        y = i && i.y * view.z + view.y;
      if (
        !i ||
        i.type !== "embed" ||
        i.url !== entry.url ||
        i.provider !== entry.provider ||
        allowed(i) ||
        (selection.size && !selection.has(id)) ||
        api.hidden?.(id) ||
        x + i.w * view.z < 0 ||
        y + i.h * view.z < 0 ||
        x > rect.width ||
        y > rect.height
      ) {
        const focused = entry.node.contains(document.activeElement);
        close(id, focused);
        continue;
      }
      place(entry.node, i);
      const title = i.text || providerName(i.provider);
      if (entry.frame.title !== title) entry.frame.title = title;
      updateCaption(entry.label, i);
      const lang = i.text && canonicalLanguage(i.lang);
      if (lang) {
        if (entry.frame.lang !== lang) entry.frame.lang = lang;
      } else if (entry.frame.hasAttribute("lang"))
        entry.frame.removeAttribute("lang");
      if (entry.prefix.textContent !== t("Live embed"))
        entry.prefix.textContent = t("Live embed");
    }
    const i = selectedEmbed();
    const show = !!i && !live.has(i.id) && !api.busy?.();
    showOpener(show);
    if (show) {
      const [action, caption] = opener.children;
      if (action.textContent !== t("Open live"))
        action.textContent = t("Open live");
      updateCaption(caption, i);
      const cx = ox + (i.x + i.w / 2) * view.z + view.x,
        cy = oy + (i.y + i.h) * view.z + view.y;
      opener.style.left = `${cx}px`;
      opener.style.top = `${cy + 10}px`;
    }
    const showLink = !!link && !api.busy?.();
    showOpener(showLink, linkOpener);
    if (showLink) {
      const [, action, caption] = linkOpener.children;
      if (action.textContent !== t("Open link"))
        action.textContent = t("Open link");
      updateCaption(
        caption,
        link,
        link.text
          ? authoredTextHTML(link)
          : authoredTextHTML({}, new URL(link.url).hostname),
      );
      if (linkOpener.getAttribute("href") !== link.url) {
        linkOpener.href = link.url;
        linkOpener.title = link.url;
      }
      linkOpener.style.left = `${ox + (link.x + link.w / 2) * view.z + view.x}px`;
      linkOpener.style.top = `${oy + (link.y + link.h) * view.z + view.y + 10}px`;
    }
  }
  return {
    open,
    close,
    closeAll,
    render,
    selectedEmbed,
    isOpen: (id) => (id ? live.has(id) : live.size > 0),
    count: () => live.size,
  };
}
