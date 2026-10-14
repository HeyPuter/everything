import { addTranslations, t } from "../i18n.js";

// A guided tour of the editor and one-time contextual tips. Progress is a
// per-device preference; nothing here changes boards or history.
export const TOUR_KEY = "whiteboard-tour-v1";
export const TIPS_KEY = "whiteboard-tips-v1";
export const EDITOR_TOUR = [
  {
    target: '[data-action="tool-note"]',
    edits: true,
    title: "Add sticky notes",
    text: "Press N, or choose Sticky note and click the board. Type right away; Tab goes on to the next note, and clicking outside finishes.",
    touch:
      "Choose Sticky note and tap the board. Type right away; tapping outside finishes.",
  },
  {
    target: '.tools [data-action="tool-select"]',
    edits: true,
    title: "Select, move, and connect",
    text: "Drag objects to move them. Hover a selected shape or note and use its blue handles to connect it to another object.",
    touch:
      "Drag objects to move them. Tap a shape or note, then tap one of its blue handles to add a connected object, or drag a handle onto another object to connect them.",
  },
  {
    target: '[data-action="tool-frame"]',
    edits: true,
    title: "Organize with frames",
    text: "Frames group content into sections. They power navigation, presentation, section links, and exports.",
  },
  {
    target: '[data-action="frames"]',
    title: "Navigate large boards",
    text: "Frames and navigation lists every section like a table of contents. The minimap (M) and Find on board (Ctrl/Cmd F) help too.",
    touch:
      "Frames and navigation lists every section like a table of contents. The minimap and Find on board, in the same row, help too.",
  },
  {
    target: '[data-action="comments"]',
    comments: true,
    title: "Discuss asynchronously",
    text: "Pin comments to objects, reply in threads, and mention people with @name so they are notified.",
  },
  {
    target: '[data-action="share"]',
    edits: true,
    title: "Share and collaborate",
    text: "Invite people to edit, comment, or view. Everyone sees live cursors and changes as they happen.",
  },
  {
    target: "[data-timer-access]",
    edits: true,
    title: "Run workshops",
    text: "Use the timer, bring everyone to your view from Participants, and present frames one at a time.",
  },
  {
    target: '[data-action="commands"]',
    title: "Find any command",
    text: "Press Ctrl/Cmd K to search every tool, template, and setting. Open Help and training at any time for guides.",
    touch:
      "Tap the command palette to search every tool, template, and setting. Help and training has guides at any time, beside the zoom controls or under More tools on small screens.",
  },
];
export const TIPS = {
  frame:
    "Tip: drag across the board to draw a frame. Objects inside it move with it.",
  arrow:
    "Tip: start the arrow on an object and end it on another to connect them.",
  pen: "Tip: drawings can be selected, moved, and recolored like any other object.",
  comment:
    "Tip: click an object to pin a comment to it, or empty space for a board comment.",
  text: "Tip: text grows as you type. Select words to format them or add links.",
};
function read(key, storage) {
  try {
    return JSON.parse(storage?.getItem(key) || "null");
  } catch {
    return null;
  }
}
function write(key, value, storage) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* Preferences are optional. */
  }
}
// Reading localStorage itself throws where the browser blocks storage.
function localStore() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}
export function createOnboarding({
  root = () => document,
  storage = localStore(),
  focusCanvas = () => {},
}) {
  let bubble = null,
    step = 0,
    steps = [],
    previous = null;
  // The tour and tips seen this session, for when storage is unavailable.
  const seenNow = new Set();
  function done() {
    seenNow.add(TOUR_KEY);
    write(TOUR_KEY, { done: true, at: Date.now() }, storage);
  }
  // Escape ends the tour from the canvas or the page too, not only from
  // inside the bubble; a dialog open over the tour takes its own Escape.
  function escapeAnywhere(e) {
    if (e.key !== "Escape" || !bubble || e.defaultPrevented) return;
    const doc = root();
    if (doc.querySelector("dialog[open]") || bubble.contains(e.target)) return;
    if (e.target !== doc.body && e.target.id !== "canvas") return;
    e.preventDefault();
    close(true);
  }
  function close(finished = true) {
    if (!bubble) return;
    root().removeEventListener("keydown", escapeAnywhere, true);
    bubble.remove();
    bubble = null;
    root().querySelector(".tour-target")?.classList.remove("tour-target");
    if (finished) done();
    if (previous?.isConnected) previous.focus();
    else focusCanvas();
  }
  function place({ focus = true, announce = false } = {}) {
    const doc = root();
    doc.querySelector(".tour-target")?.classList.remove("tour-target");
    const current = steps[step];
    const target = doc.querySelector(current.target);
    // Touch screens are told to tap, not given keys and hovering.
    const text = t(
      (current.touch &&
        doc.defaultView.matchMedia?.("(pointer: coarse)").matches &&
        current.touch) ||
        current.text,
    );
    bubble.querySelector("#tour-title").textContent = t(current.title);
    bubble.querySelector("#tour-text").textContent = text;
    bubble.querySelector("#tour-count").textContent =
      `${step + 1} / ${steps.length}`;
    bubble.querySelector("#tour-back").disabled = step === 0;
    bubble.querySelector("#tour-next").textContent = t(
      step === steps.length - 1 ? "Finish" : "Next",
    );
    const view = doc.defaultView;
    const width = Math.min(340, view.innerWidth - 32);
    bubble.style.width = `${width}px`;
    if (target) target.classList.add("tour-target");
    if (target && target.getClientRects().length) {
      // A button in a scrolling strip, such as the canvas navigation on a
      // phone, is brought into view before the bubble points at it.
      target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      const r = target.getBoundingClientRect();
      const below = r.bottom + 12 + 220 < view.innerHeight;
      bubble.style.left = `${Math.max(16, Math.min(view.innerWidth - width - 16, r.left + r.width / 2 - width / 2))}px`;
      bubble.style.top = below ? `${r.bottom + 12}px` : "";
      bubble.style.bottom = below
        ? ""
        : `${Math.max(16, view.innerHeight - r.top + 12)}px`;
    } else {
      bubble.style.left = `${Math.max(16, view.innerWidth / 2 - width / 2)}px`;
      bubble.style.top = "30%";
      bubble.style.bottom = "";
    }
    if (focus) bubble.querySelector("#tour-next").focus();
    // Focus stays on Next, so the new step is announced.
    if (announce)
      bubble.querySelector("#tour-live").textContent =
        `${step + 1} / ${steps.length}. ${t(current.title)}. ${text}`;
  }
  const api = {
    get active() {
      return !!bubble;
    },
    shouldStart() {
      return !seenNow.has(TOUR_KEY) && !read(TOUR_KEY, storage)?.done;
    },
    // Viewers and commenters are shown only what they can do: steps about
    // editing, or commenting for viewers, and controls that are disabled
    // or hidden for them, are left out. When the roles are given, steps
    // about editing and commenting follow them rather than whether their
    // controls are disabled for now, as they are while a shared board
    // connects.
    start(list = EDITOR_TOUR, roles) {
      close(false);
      const { canEdit = true, canComment = true } = roles || {};
      const doc = root();
      steps = list.filter((s) => {
        const el = doc.querySelector(s.target);
        return (
          el &&
          (!el.disabled || (roles && (s.edits || s.comments))) &&
          !el.closest("[hidden]") &&
          (canEdit || !s.edits) &&
          (canComment || !s.comments)
        );
      });
      if (!steps.length) return;
      step = 0;
      // Started from the offer that goes away, focus was on the page; the
      // canvas takes it back when the tour ends.
      previous = doc.activeElement === doc.body ? null : doc.activeElement;
      bubble = doc.createElement("div");
      bubble.className = "tour-bubble panel";
      bubble.setAttribute("role", "dialog");
      bubble.setAttribute("aria-modal", "false");
      bubble.setAttribute("aria-labelledby", "tour-title");
      bubble.setAttribute("aria-describedby", "tour-text");
      bubble.innerHTML = `<div class="tour-head"><h2 id="tour-title"></h2><span id="tour-count" class="tour-count"></span></div><p id="tour-text"></p><div class="tour-actions"><button class="text-btn" id="tour-skip">${t("Skip tour")}</button><button class="secondary" id="tour-back">${t("Back")}</button><button class="primary" id="tour-next">${t("Next")}</button></div><p id="tour-live" class="sr-only" role="status"></p>`;
      doc.body.append(bubble);
      doc.addEventListener("keydown", escapeAnywhere, true);
      bubble.querySelector("#tour-skip").onclick = () => close(true);
      bubble.querySelector("#tour-back").onclick = () => {
        step = Math.max(0, step - 1);
        place({ announce: true });
      };
      bubble.querySelector("#tour-next").onclick = () => {
        if (step === steps.length - 1) close(true);
        else {
          step++;
          place({ announce: true });
        }
      };
      bubble.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          close(true);
        } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          // The arrows step through the tour; they must not also move the
          // selected objects on the canvas.
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "ArrowRight")
            bubble.querySelector("#tour-next").click();
          else if (step) bubble.querySelector("#tour-back").click();
        }
      });
      place();
    },
    close,
    // Follow layout changes without taking focus from where it is.
    reposition() {
      if (bubble) place({ focus: false });
    },
    // Show a one-time contextual tip the first time a tool is chosen.
    tip(key, toast) {
      if (!TIPS[key] || api.active || seenNow.has(key)) return;
      const seen = read(TIPS_KEY, storage) || {};
      if (seen[key]) return;
      seenNow.add(key);
      seen[key] = Date.now();
      write(TIPS_KEY, seen, storage);
      toast(TIPS[key]);
    },
    dismiss: done,
    reset() {
      seenNow.clear();
      write(TOUR_KEY, null, storage);
      write(TIPS_KEY, null, storage);
    },
  };
  return api;
}

addTranslations({
  "Add sticky notes": "Ajouter des notes adhésives",
  "Press N, or choose Sticky note and click the board. Type right away; Tab goes on to the next note, and clicking outside finishes.":
    "Appuyez sur N, ou choisissez Note adhésive et cliquez sur le tableau. Tapez tout de suite; Tab passe à la note suivante, et un clic ailleurs termine.",
  "Select, move, and connect": "Sélectionner, déplacer et relier",
  "Drag objects to move them. Hover a selected shape or note and use its blue handles to connect it to another object.":
    "Faites glisser les objets pour les déplacer. Survolez une forme ou une note sélectionnée et utilisez ses poignées bleues pour la relier à un autre objet.",
  "Choose Sticky note and tap the board. Type right away; tapping outside finishes.":
    "Choisissez Note adhésive et touchez le tableau. Écrivez tout de suite; touchez ailleurs pour terminer.",
  "Drag objects to move them. Tap a shape or note, then tap one of its blue handles to add a connected object, or drag a handle onto another object to connect them.":
    "Faites glisser les objets pour les déplacer. Touchez une forme ou une note, puis touchez l’une de ses poignées bleues pour ajouter un objet relié, ou faites glisser une poignée sur un autre objet pour les relier.",
  "Organize with frames": "Organiser avec des cadres",
  "Frames group content into sections. They power navigation, presentation, section links, and exports.":
    "Les cadres regroupent le contenu en sections. Ils servent à la navigation, à la présentation, aux liens de section et aux exportations.",
  "Navigate large boards": "Parcourir les grands tableaux",
  "Frames and navigation lists every section like a table of contents. The minimap (M) and Find on board (Ctrl/Cmd F) help too.":
    "Cadres et navigation énumère chaque section comme une table des matières. La mini-carte (M) et Rechercher dans le tableau (Ctrl/Cmd F) aident aussi.",
  "Frames and navigation lists every section like a table of contents. The minimap and Find on board, in the same row, help too.":
    "Cadres et navigation énumère chaque section comme une table des matières. La mini-carte et Rechercher dans le tableau, dans la même rangée, aident aussi.",
  "Discuss asynchronously": "Discuter en différé",
  "Pin comments to objects, reply in threads, and mention people with @name so they are notified.":
    "Épinglez des commentaires aux objets, répondez dans les fils et mentionnez des personnes avec @nom pour les aviser.",
  "Share and collaborate": "Partager et collaborer",
  "Invite people to edit, comment, or view. Everyone sees live cursors and changes as they happen.":
    "Invitez des personnes à modifier, commenter ou consulter. Tout le monde voit les curseurs et les changements en direct.",
  "Run workshops": "Animer des ateliers",
  "Use the timer, bring everyone to your view from Participants, and present frames one at a time.":
    "Utilisez le minuteur, amenez tout le monde à votre vue depuis Participants et présentez les cadres un à la fois.",
  "Find any command": "Trouver n’importe quelle commande",
  "Press Ctrl/Cmd K to search every tool, template, and setting. Open Help and training at any time for guides.":
    "Appuyez sur Ctrl/Cmd K pour chercher un outil, un modèle ou un paramètre. Ouvrez Aide et formation en tout temps pour consulter les guides.",
  "Tip: drag across the board to draw a frame. Objects inside it move with it.":
    "Astuce : faites glisser sur le tableau pour dessiner un cadre. Les objets qu’il contient se déplacent avec lui.",
  "Tip: start the arrow on an object and end it on another to connect them.":
    "Astuce : commencez la flèche sur un objet et terminez-la sur un autre pour les relier.",
  "Tip: drawings can be selected, moved, and recolored like any other object.":
    "Astuce : les dessins peuvent être sélectionnés, déplacés et recolorés comme tout autre objet.",
  "Tip: click an object to pin a comment to it, or empty space for a board comment.":
    "Astuce : cliquez sur un objet pour y épingler un commentaire, ou sur un espace vide pour un commentaire du tableau.",
  "Tip: text grows as you type. Select words to format them or add links.":
    "Astuce : le texte s’agrandit à mesure que vous tapez. Sélectionnez des mots pour les mettre en forme ou ajouter des liens.",
  "Tap the command palette to search every tool, template, and setting. Help and training has guides at any time, beside the zoom controls or under More tools on small screens.":
    "Touchez la palette de commandes pour chercher un outil, un modèle ou un paramètre. Aide et formation offre des guides en tout temps, à côté des commandes de zoom ou dans Autres outils sur les petits écrans.",
  "Skip tour": "Passer la visite",
  "Getting started": "Premiers pas",
  "New here?": "Nouveau ici?",
  "Take a one-minute tour": "Faire une visite d’une minute",
  Dismiss: "Fermer",
  "Open a board to take the tour.": "Ouvrez un tableau pour faire la visite.",
  "The tour starts once the board connects.":
    "La visite commencera une fois le tableau connecté.",
  "AI assistant": "Assistant IA",
  "Help and training": "Aide et formation",
  "Take the tour": "Faire la visite",
  "Migrate from Miro": "Migrer depuis Miro",
  Back: "Précédent",
  Next: "Suivant",
  Finish: "Terminer",
});
