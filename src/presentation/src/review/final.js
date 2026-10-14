// Always Open Read-Only: a presentation marked final (a property saved in
// the file) opens read-only, with a bar saying so and an Edit Anyway button
// that lifts the lock for this session. The mark stays in the file until it
// is turned off.
import { el, icon, toast } from "../ui.js";
import { P } from "../model.js";

export function createFinal(env) {
  let owner = null,
    locked = false;
  const bar = el(
    "div",
    { class: "final-bar", role: "status", hidden: true },
    icon("Lock", 16),
    el("strong", {}, "Read-only."),
    el(
      "span",
      { class: "final-bar-text" },
      "This presentation is marked as final to discourage changes.",
    ),
    el(
      "button",
      {
        type: "button",
        class: "btn secondary small",
        onclick: () => editAnyway(),
      },
      "Edit Anyway",
    ),
  );
  const marked = () => {
    try {
      return !!env.pres() && P.isMarkedFinal(env.pres());
    } catch {
      return false;
    }
  };
  // A presentation opened or switched to takes its own lock.
  function sync() {
    const doc = env.doc();
    if (doc !== owner) {
      owner = doc;
      locked = !!doc && marked();
    }
  }
  function show() {
    bar.hidden = !locked;
    document.querySelector(".editor")?.classList.toggle("marked-final", locked);
  }
  function mount() {
    sync();
    const split = document.querySelector(".editor-split");
    if (split && bar.nextSibling !== split) split.before(bar);
    show();
  }
  function editAnyway() {
    locked = false;
    show();
    env.refreshEditor();
    toast(
      "You can edit this presentation now. It is still marked to open read-only.",
    );
  }
  function blockedEdit() {
    show();
    bar.classList.remove("flash");
    void bar.offsetWidth;
    bar.classList.add("flash");
    toast("This presentation is read-only. Choose Edit Anyway to change it.");
  }
  async function setMarked(on) {
    sync();
    if (locked) {
      locked = false;
      show();
    }
    await env.mutate(() => {
      if (marked() === on) return env.SKIP;
      P.setMarkedFinal(env.pres(), on);
    });
    if (on) {
      locked = true;
      show();
      toast("Marked as final. The presentation now opens read-only.");
    } else toast("The presentation no longer opens read-only.");
    env.refreshEditor();
  }
  return {
    mount,
    blocksEdits: () => (sync(), locked),
    blockedEdit,
    editAnyway,
    marked,
    setMarked,
    toggle: () => setMarked(!marked()),
  };
}
