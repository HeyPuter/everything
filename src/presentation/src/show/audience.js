// The audience's window for Presenter View: a second browser window, placed
// on another screen when the browser says there is one, that shows only the
// slide while the presenter keeps notes and tools in the first. The window
// must be opened straight from the command (a popup needs the click), so it
// is opened here before the show starts and filled when it does.

const NAME = "presentation-audience";

/** Opens an empty audience window, or returns null when it is blocked. */
export function openAudienceWindow() {
  const screen = globalThis.screen;
  const width = Math.round((screen?.availWidth || 1280) * 0.6);
  const height = Math.round(width * 0.5625);
  // A second screen usually extends to the right of the first.
  const left = screen?.isExtended
    ? (screen.availLeft || 0) + screen.availWidth
    : Math.round(((screen?.availWidth || width) - width) / 2);
  const top = Math.round(((screen?.availHeight || height) - height) / 2);
  try {
    const win = globalThis.open(
      "",
      NAME,
      `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
    );
    return win && !win.closed ? win : null;
  } catch {
    return null;
  }
}

/** Fills an audience window: the app's styles, an empty stage, and a
 * full screen button. Returns { win, doc, stage, dispose }. */
export function prepareAudienceWindow(win, { title = "Slide Show" } = {}) {
  const doc = win.document;
  doc.title = `${title} - Audience`;
  doc.head.replaceChildren();
  const meta = doc.createElement("meta");
  meta.setAttribute("charset", "utf-8");
  doc.head.append(meta);
  for (const node of document.querySelectorAll('style, link[rel="stylesheet"]'))
    doc.head.append(doc.importNode(node, true));
  for (const { name, value } of document.documentElement.attributes)
    doc.documentElement.setAttribute(name, value);
  // Fonts the slides use, loaded in this window too.
  try {
    for (const face of document.fonts) doc.fonts.add(face);
  } catch {}
  doc.body.replaceChildren();
  doc.body.className = "show-audience-body";
  const stage = doc.createElement("div");
  stage.className = "presenter-stage show-audience";
  const full = doc.createElement("button");
  full.type = "button";
  full.className = "show-audience-full";
  full.textContent = "Full screen";
  full.setAttribute("aria-label", "Show the slides full screen");
  full.addEventListener("click", (e) => {
    e.stopPropagation();
    if (doc.fullscreenElement) doc.exitFullscreen().catch(() => {});
    else stage.requestFullscreen?.().catch(() => {});
  });
  stage.addEventListener("dblclick", () => {
    if (!doc.fullscreenElement) stage.requestFullscreen?.().catch(() => {});
  });
  doc.body.append(stage, full);
  // Move to another screen when the browser already allows it.
  (async () => {
    try {
      const state = await navigator.permissions?.query({
        name: "window-management",
      });
      if (state?.state !== "granted" || !globalThis.getScreenDetails) return;
      const details = await globalThis.getScreenDetails();
      const other = details.screens.find((s) => s !== details.currentScreen);
      if (!other || win.closed) return;
      win.moveTo(other.availLeft, other.availTop);
      win.resizeTo(other.availWidth, other.availHeight);
    } catch {}
  })();
  return {
    win,
    doc,
    stage,
    dispose() {
      try {
        if (!win.closed) win.close();
      } catch {}
    },
  };
}
