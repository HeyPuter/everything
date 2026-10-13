// The editor's presentation views beside Normal: Outline View, Slide Sorter
// and Notes Page, plus the grid and guides over the slide, the Zoom dialog,
// and the settings each presentation keeps for them on this device.
//
// main.js hands over what the views need through `ctx` and registers the
// returned handlers as its views (see setView there).
import "./views.css";
import { IS_MAC } from "../ui.js";
import { createOutlineView } from "./outline-view.js";
import { createSlideSorter } from "./slide-sorter.js";
import { createNotesPage } from "./notes-page.js";
import { createGridGuides } from "./grid-guides.js";
import { zoomDialog } from "./zoom-dialog.js";
import {
  loadViewSettings,
  saveViewSettings,
  viewFromFile,
} from "./view-settings.js";

export { readingBar, placeReadingDialog } from "./reading-view.js";

export const VIEWS = [
  ["normal", "Normal", "o:normalView", "1"],
  ["sorter", "Slide Sorter", "o:slideSorter", "2"],
  ["notesPage", "Notes Page", "o:notesPage", "3"],
  ["outline", "Outline View", "o:outlineView", "4"],
  ["reading", "Reading View", "o:readingView", "5"],
];

export function createViews(base) {
  const key = () => base.docKey();
  const settings = () => loadViewSettings(key());
  const ctx = {
    ...base,
    settings,
    saveSettings: (patch) => saveViewSettings(key(), patch),
  };
  const outline = createOutlineView(ctx);
  const sorter = createSlideSorter(ctx);
  const notesPage = createNotesPage(ctx);
  const grid = createGridGuides(ctx);
  const handlers = { outline, sorter, notesPage };
  let mountedKey = null;

  // After the editor is drawn: a presentation just opened goes back to the
  // view it was left in here (or that its file records); the same one
  // redrawn keeps its view.
  function mounted() {
    const k = key();
    if (k !== mountedKey) {
      mountedKey = k;
      let wanted = settings().view;
      if (!wanted) {
        try {
          wanted = viewFromFile(
            base.P.getViewProperties(base.doc().pres).lastView,
          );
        } catch {}
      }
      if (wanted && wanted !== "reading" && handlers[wanted]) {
        base.setView(wanted, { remount: true });
        return;
      }
      if (base.currentView() !== "normal")
        base.setView("normal", { remount: true });
      return;
    }
    const current = base.currentView();
    if (current !== "normal") base.setView(current, { remount: true });
  }
  function viewChanged(id) {
    if (id !== "reading") saveViewSettings(key(), { view: id });
  }
  function refresh() {
    handlers[base.currentView()]?.refresh();
  }

  // The view menu's views, with their shortcuts.
  function menuItems() {
    const mod = IS_MAC ? "⌘" : "Ctrl";
    const current = base.currentView();
    return [
      ...VIEWS.map(([id, label, icon, digit]) => ({
        label,
        icon,
        shortcut: `${mod}+${digit}`,
        checked: current === id,
        onSelect: () => base.setView(id),
      })),
      { separator: true },
      {
        label: "Show Outline",
        checked: current === "outline",
        shortcut: IS_MAC ? "⌃⇧Tab" : "Ctrl+Shift+Tab",
        onSelect: () =>
          base.setView(current === "outline" ? "normal" : "outline"),
      },
    ];
  }

  function openZoomDialog() {
    return zoomDialog({
      current: base.zoomFactor(),
      fit: base.zoomIsFit(),
      set: (level) => base.setZoom(level),
      min: base.currentView() === "sorter" ? 33 : 10,
      max: base.currentView() === "sorter" ? 300 : 400,
    });
  }

  // Shortcuts: the views by number, Show Outline, and the gridlines.
  function keydown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && /^Digit[1-5]$/.test(e.code)) {
      e.preventDefault();
      base.setView(VIEWS[Number(e.code.slice(5)) - 1][0]);
      return true;
    }
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.key === "Tab") {
      e.preventDefault();
      base.setView(base.currentView() === "outline" ? "normal" : "outline");
      return true;
    }
    if (
      mod &&
      !e.altKey &&
      !e.shiftKey &&
      (e.key === "'" || e.code === "Quote")
    ) {
      e.preventDefault();
      base.show("gridlines", !base.showing("gridlines"));
      return true;
    }
    return false;
  }

  return {
    handlers,
    grid,
    mounted,
    viewChanged,
    refresh,
    menuItems,
    openZoomDialog,
    keydown,
  };
}
