// The editor's side of slide transitions: the Transitions tab's commands
// (gallery, Effect Options, Duration, Sound, advance timing, Apply To All,
// Preview), the slide menu's Transition submenu, the navigator's mark, and
// playing a slide's arrival in the slide show.
import "./transitions.css";
import {
  TRANSITIONS,
  TRANSITION_GROUPS,
  PLAYABLE_EFFECTS,
  identifyTransition,
  transitionDurationMs,
  transitionEntry,
  transitionFor,
} from "./catalog.js";
import { transitionThumbnail } from "./thumbnails.js";
import { playTransition, prefersReducedMotion } from "./player.js";
import { prepareMorph } from "./morph.js";
import { loadImage } from "./player.js";
import {
  BUILT_IN_SOUNDS,
  builtInSoundNamed,
  playSound,
  soundFileName,
  stopSound,
  synthesizeSound,
} from "./sounds.js";

const SVG = "http://www.w3.org/2000/svg";
const AUDIO_TYPES = ".wav,.mp3,.m4a,.aif,.aiff,.ogg,audio/*";

/**
 * Builds the transition tools for the editor.
 *
 *   P              the pptx library
 *   pres()         the open presentation
 *   slide()        the slide being edited
 *   mutateSlide    (slide, fn) → applies an undoable edit; fn may return skip
 *   skip           the value that tells mutateSlide nothing changed
 *   picture(slide) the slide's rendered picture URL
 *   render(slide, layer) a picture URL of part of a slide (RenderSlideOptions)
 *   canvas()       the editing canvas element (for Preview)
 *   chooseFile(accept) → Promise<File | null>
 *   report(error)  shows an error
 */
export function createTransitionTools({
  P,
  pres,
  slide,
  mutateSlide,
  skip,
  picture,
  render,
  canvas,
  chooseFile,
  report = (error) => console.error(error),
}) {
  const details = (target, options) => {
    try {
      return P.getEffectiveSlideTransition(target, options);
    } catch {
      return null;
    }
  };
  const identify = (target) => identifyTransition(details(target));
  /** The gallery id of the slide's transition ("other" for an unknown one). */
  const current = (target = slide()) => identify(target).id;

  function choose(
    target,
    id,
    { option = null, all = false, preview = true } = {},
  ) {
    if (!transitionEntry(id)) return;
    let changed = false;
    mutateSlide(target, (target) => {
      const slides = all ? P.getSlides(pres()) : [target];
      for (const s of slides) {
        const now = details(s);
        const next = transitionFor(id, option, now);
        if (!next) continue;
        // An inherited sound belongs to the layout's relationships.
        if (!P.getSlideTransition(s)) delete next.sound;
        P.setSlideTransition(s, next);
        changed = true;
      }
      if (!changed) return skip;
    });
    if (changed && preview && id !== "none") previewTransition();
  }

  // Effect Options: the current entry's options, the current one checked.
  function optionsMenu(target = slide()) {
    const { id, option } = identify(target);
    const entry = transitionEntry(id);
    if (!entry?.options) return [];
    return [
      { header: entry.label },
      ...entry.options.map((o) => ({
        label: o.label,
        checked: o.id === option,
        onSelect: () => choose(target, id, { option: o.id }),
      })),
    ];
  }

  const timing = (changes) =>
    mutateSlide(slide(), (target) => {
      P.setSlideTransitionTiming(target, changes);
    });

  function duration(target = slide()) {
    const t = details(target);
    if (!t || t.effect === "none") return null;
    return transitionDurationMs(t) / 1000;
  }

  // Apply To All: the effect, its options, duration, sound and advance
  // timing of this slide go to every slide.
  function applyToAll(source = slide()) {
    const t = details(source);
    if (identify(source).id === "other") return;
    mutateSlide(source, (from) => {
      let changed = false;
      for (const s of P.getSlides(pres())) {
        if (s === from) continue;
        const next = { ...(t || { effect: "none" }) };
        if (next.sound?.kind === "start") {
          if (P.getSlideTransition(from))
            next.sound = {
              ...next.sound,
              relId: P.shareSlideTransitionSound(from, next.sound.relId, s),
            };
          else delete next.sound;
        }
        P.setSlideTransition(s, next);
        changed = true;
      }
      if (!changed) return skip;
    });
  }

  /* ---------- Sound ---------- */
  function soundState(target = slide()) {
    const sound = details(target)?.sound;
    if (!sound) return { kind: "none" };
    if (sound.kind === "stop") return { kind: "stop" };
    const builtIn = builtInSoundNamed(sound.name || "");
    return {
      kind: "start",
      id: builtIn?.id || "other",
      name: (sound.name || "Sound").replace(/\.[a-z0-9]+$/i, ""),
      loop: !!sound.loop,
    };
  }
  const soundLabel = () => {
    const s = soundState();
    return s.kind === "none"
      ? "No Sound"
      : s.kind === "stop"
        ? "Stop Previous Sound"
        : s.name;
  };
  function setSound(sound, bytes = null, name = null) {
    mutateSlide(slide(), (target) => {
      const now = details(target) || { effect: "none" };
      const local = !!P.getSlideTransition(target);
      const next = { ...now };
      if (!local) delete next.sound;
      if (sound === null) {
        if (!next.sound && local) return skip;
        delete next.sound;
      } else if (sound === "stop") next.sound = { kind: "stop" };
      else {
        const relId = P.addSlideTransitionSound(target, bytes, name);
        next.sound = { kind: "start", relId, name };
      }
      P.setSlideTransition(target, next);
    });
    if (bytes && !prefersReducedMotion()) playSound(bytes).catch(() => {});
  }
  function setLoop(loop) {
    mutateSlide(slide(), (target) => {
      const now = P.getSlideTransition(target);
      if (now?.sound?.kind !== "start") return skip;
      P.setSlideTransition(target, { ...now, sound: { ...now.sound, loop } });
    });
  }
  async function otherSound() {
    const file = await chooseFile(AUDIO_TYPES);
    if (!file) return;
    if (file.size > 20 * 1024 * 1024)
      throw new Error("Please choose a sound smaller than 20 MB.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    setSound("start", bytes, file.name);
  }
  function soundMenu() {
    const state = soundState();
    return [
      {
        label: "No Sound",
        checked: state.kind === "none",
        onSelect: () => setSound(null),
      },
      {
        label: "Stop Previous Sound",
        checked: state.kind === "stop",
        onSelect: () => setSound("stop"),
      },
      { separator: true },
      ...BUILT_IN_SOUNDS.map((sound) => ({
        label: sound.label,
        checked: state.kind === "start" && state.id === sound.id,
        onSelect: () =>
          setSound("start", synthesizeSound(sound.id), soundFileName(sound)),
      })),
      ...(state.kind === "start" && state.id === "other"
        ? [{ label: state.name, checked: true, onSelect: () => {} }]
        : []),
      { separator: true },
      {
        label: "Other Sound…",
        icon: "Upload",
        onSelect: () => otherSound().catch(report),
      },
      { separator: true },
      {
        label: "Loop Until Next Sound",
        checked: state.kind === "start" && state.loop,
        disabled: state.kind !== "start",
        onSelect: () => setLoop(!(state.kind === "start" && state.loop)),
      },
    ];
  }

  /** Plays (or stops) the sound of the slide arriving in a show. */
  function playArrivalSound(target) {
    const sound = details(target)?.sound;
    if (!sound) return;
    if (sound.kind === "stop") {
      stopSound();
      return;
    }
    let data = null;
    try {
      data = P.getSlideTransitionSoundData(target);
    } catch {
      data = null;
    }
    if (data) playSound(data.bytes, { loop: data.loop }).catch(() => {});
  }

  /* ---------- Playing ---------- */
  // Layers of a slide for the dynamic content effects: its background
  // (with the layout's decorations) and its own content.
  const layersOf = (target) => ({
    bg: render(target, { includeShape: () => false }),
    fg: render(target, { background: false }),
  });

  /**
   * Plays the change from `fromSlide` to `toSlide` over `host`, as
   * `transition` describes. Pictures default to the slides' renders.
   */
  function play({
    host,
    fromSlide,
    toSlide,
    transition,
    backward = false,
    from = fromSlide ? picture(fromSlide) : null,
    to = picture(toSlide),
  }) {
    return playTransition({
      host,
      from: from || blankPicture(),
      to,
      transition,
      backward,
      layers: async () =>
        fromSlide ? { from: layersOf(fromSlide), to: layersOf(toSlide) } : null,
      morph: async (W, H, reversed) => {
        if (!fromSlide) return null;
        const [a, b] = reversed ? [toSlide, fromSlide] : [fromSlide, toSlide];
        return prepareMorph({
          P,
          pres: pres(),
          from: a,
          to: b,
          render,
          load: loadImage,
          W,
          H,
        });
      },
    });
  }

  let previewing = null;
  function previewTransition(target = slide()) {
    const host = canvas();
    const t = details(target);
    if (!host || !t || t.effect === "none") return null;
    previewing?.cancel();
    const slides = P.getSlides(pres());
    const at = slides.indexOf(target);
    const previous = at > 0 ? slides[at - 1] : null;
    playArrivalSound(target);
    if (prefersReducedMotion()) return null;
    const playback = play({
      host,
      fromSlide: previous,
      toSlide: target,
      transition: t,
    });
    previewing = playback;
    playback.finished.then(() => {
      if (previewing === playback) previewing = null;
    });
    return playback;
  }

  /* ---------- Ribbon, menus, navigator ---------- */
  const choices = () =>
    TRANSITIONS.map((entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      group: entry.group,
      render: () => transitionThumbnail(entry.id),
    }));
  const sections = (list) =>
    TRANSITION_GROUPS.map((group) => ({
      label: group.label,
      items: list.filter((choice) => choice.group === group.id),
    }));

  function ribbonApi() {
    return {
      canPreviewTransition: () => !["none"].includes(current()),
      previewTransition: () => previewTransition(),
      transitionChoices: choices,
      transitionSections: sections,
      currentTransition: () => current(),
      setTransition: (id) => choose(slide(), id),
      transitionOptions: () => transitionEntry(current())?.options || [],
      transitionOptionsMenu: () => optionsMenu(),
      transitionDuration: () => duration(),
      setTransitionDuration: (seconds) =>
        timing({ durationMs: Math.round(seconds * 1000) }),
      applyTransitionToAll: () => applyToAll(),
      canApplyTransitionToAll: () => current() !== "other",
      advanceOnClick: () => details(slide())?.advanceOnClick !== false,
      setAdvanceOnClick: (on) => timing({ advanceOnClick: on }),
      advanceAfter: () => {
        const ms = details(slide())?.advanceAfterMs;
        return ms == null ? null : ms / 1000;
      },
      setAdvanceAfter: (seconds) =>
        timing({
          advanceAfterMs: seconds == null ? null : Math.round(seconds * 1000),
        }),
      transitionSoundMenu: () => soundMenu(),
      transitionSoundLabel: () => `Sound: ${soundLabel()}`,
    };
  }

  /** The slide menu's Transition submenu. */
  function menuItems(target) {
    const now = current(target);
    return [
      ...TRANSITION_GROUPS.map((group) => ({
        label: group.label,
        items: TRANSITIONS.filter((entry) => entry.group === group.id).map(
          (entry) => ({
            label: entry.label,
            checked: now === entry.id,
            onSelect: () => choose(target, entry.id),
          }),
        ),
      })),
      { separator: true },
      {
        label: "Apply to all slides",
        icon: "Copy",
        disabled: now === "other",
        onSelect: () => applyToAll(target),
      },
    ];
  }

  /** Whether the navigator marks the slide: it has a transition or sound. */
  const marked = (target) => {
    const t = details(target);
    return !!t && (t.effect !== "none" || !!t.sound);
  };

  /** Adds or removes the navigator's star beside a slide's number. */
  function markRow(row, target, number) {
    const has = marked(target);
    let mark = row.querySelector(":scope > .slide-transition-mark");
    if (!has) {
      mark?.remove();
      return;
    }
    if (!mark) {
      mark = document.createElement("button");
      mark.type = "button";
      mark.className = "slide-transition-mark";
      mark.append(star());
      mark.addEventListener("click", (e) => {
        e.stopPropagation();
        const s = row.__transitionSlide?.();
        if (s) previewTransition(s);
      });
      const label = row.querySelector(".slide-number");
      (label || row).after(mark);
    }
    const name = transitionEntry(current(target))?.label || "A transition";
    const text = `Slide ${number} has ${name === "None" ? "a sound" : `the ${name} transition`}. Play it.`;
    mark.setAttribute("aria-label", text);
    mark.title = text;
    row.__transitionSlide = () =>
      P.getSlides(pres()).find(
        (s) => P.getSlidePartName(s) === row.dataset.slidePart,
      );
  }

  return {
    ribbonApi,
    menuItems,
    current,
    details,
    choose,
    applyToAll,
    previewTransition,
    playArrivalSound,
    stopSound,
    play,
    marked,
    markRow,
    entries: TRANSITIONS,
    playable: PLAYABLE_EFFECTS,
  };
}

function star() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute(
    "d",
    "M6 0.8L7.5 4.2L11.2 4.5L8.4 6.9L9.3 10.6L6 8.6L2.7 10.6L3.6 6.9L0.8 4.5L4.5 4.2Z",
  );
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

// A black slide to come from when there is no previous slide.
let blank = null;
function blankPicture() {
  blank ??=
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="#000"/></svg>',
    );
  return blank;
}
