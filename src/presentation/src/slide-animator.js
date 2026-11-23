// Plays a slide's animations during a slide show. The show asks the animator
// for each advance before it moves to the next slide, so a slide with click
// steps uses its clicks first.
//
//   createSlideAnimator({ pres, slide, frame, image, reducedMotion, onMedia })
//
// `frame` is the show's slide container and `image` the slide's rendered
// picture inside it; the animator may lay pictures of its own over or in
// place of `image`, and must remove them in `destroy()`. `onMedia(effect)`
// plays, pauses or stops a video or sound when its click step comes.
//
// The returned animator:
//   steps          the number of click steps on the slide
//   step           the click steps played so far
//   start()        shows the slide's opening state (objects that enter later
//                  are hidden) and plays what runs before the first click
//   next()         plays the next click step; false when none is left, so
//                  the show moves on to the next slide
//   played         settles when the step last started by next() ends
//   playing        whether effects (other than endless repeats) are running
//   snapshot()     a picture of the slide as it now stands
//   shownParts()   what of each shape is in view as the slide now stands,
//                  as a layer's shape filter (null: everything)
//   nextPicture()  a picture of the slide once its next click step has
//                  played (null when none is left)
//   previous()     returns to the state before the last step; false at the
//                  first step, so the show goes back a slide
//   finish()       shows the slide's final state at once, as a slide reached
//                  by going back is shown
//   triggers       shapes whose click plays effects: [{ shapeId, box }]
//   playTrigger(id) plays the next effects of a trigger shape
//   destroy()      removes whatever the animator added
//
// Until start() or finish(), `image` shows the slide as it opens, so a
// transition into the slide shows the right picture.
import { P, preview } from "./model.js";
import {
  createAnimationPlayer,
  prefersReducedMotion,
} from "./animations/player.js";
import "./animations/animations.css";

const NONE = {
  steps: 0,
  step: 0,
  triggers: [],
  start() {},
  next: () => false,
  previous: () => false,
  played: Promise.resolve(),
  playing: false,
  snapshot: () => null,
  shownParts: () => null,
  nextPicture: () => null,
  finish() {},
  playTrigger: () => false,
  destroy() {},
};

export function createSlideAnimator({
  pres,
  slide,
  frame,
  image,
  reducedMotion = prefersReducedMotion(),
  onMedia = null,
}) {
  let effects;
  try {
    // Media in the click sequence takes its click among the animations'.
    // Media that plays by itself or when clicked belongs to the show's media
    // players (src/insert/show.js).
    effects = P.getSlideAnimations(slide).filter(
      (e) =>
        e.presetClass !== "mediacall" ||
        (!!onMedia && e.trigger === undefined && e.start === "click"),
    );
  } catch {
    effects = [];
  }
  if (!effects.length || !frame) return { ...NONE };
  let player;
  try {
    player = createAnimationPlayer({
      pres,
      slide,
      frame,
      effects,
      reducedMotion,
      onMedia,
      renderLayer: (layer) => preview(pres, slide, layer),
    });
  } catch {
    return { ...NONE };
  }
  const stage = player.element;
  // The stage sits just over the slide picture, under links and controls.
  if (stage && image?.parentNode === frame) image.after(stage);
  const finalSrc = image?.getAttribute("src");
  stage?.classList.add("waiting");
  // The opening picture: what the stage shows before anything plays.
  if (image) image.src = player.snapshot(preview.bind(null, pres, slide));
  let active = false;
  const nextPictures = new Map(); // click steps played -> picture

  const activate = () => {
    if (active) return;
    active = true;
    stage?.classList.remove("waiting");
    image?.classList.add("anim-covered");
  };
  return {
    steps: player.steps,
    get step() {
      return player.step;
    },
    triggers: player.triggers,
    start() {
      activate();
      player.start();
    },
    next() {
      activate();
      return player.next();
    },
    get played() {
      return player.played;
    },
    get playing() {
      return player.playing;
    },
    snapshot() {
      return player.snapshot(preview.bind(null, pres, slide));
    },
    shownParts() {
      return player.shownParts();
    },
    nextPicture() {
      const n = player.step + 1;
      if (n > player.steps) return null;
      let src = nextPictures.get(n);
      if (!src)
        nextPictures.set(
          n,
          (src = player.pictureAfter(n, preview.bind(null, pres, slide))),
        );
      return src;
    },
    previous() {
      activate();
      return player.previous();
    },
    finish() {
      activate();
      player.finish();
    },
    playTrigger(id) {
      activate();
      return player.playTrigger(id);
    },
    destroy() {
      // Leave the picture showing where the slide got to, for a transition
      // out of it.
      if (image) {
        image.src = active
          ? player.snapshot(preview.bind(null, pres, slide))
          : finalSrc;
        image.classList.remove("anim-covered");
      }
      player.destroy();
    },
  };
}

/**
 * How a slide stands as it opens (objects that enter later are hidden) and
 * once all its animations have played: `{ opening, ending }`, each
 * `{ picture, parts }` (parts as shownParts()), or null for a slide without
 * animations. Used where a slide is shown arriving or leaving outside a
 * show, as a transition's preview does.
 */
export function slideStates(pres, slide) {
  let effects;
  try {
    effects = P.getSlideAnimations(slide).filter(
      (e) => e.presetClass !== "mediacall",
    );
  } catch {
    effects = [];
  }
  if (!effects.length) return null;
  const render = preview.bind(null, pres, slide);
  let player;
  try {
    player = createAnimationPlayer({
      pres,
      slide,
      frame: document.createElement("div"),
      effects,
      reducedMotion: true,
      sounds: false,
      renderLayer: (layer) => preview(pres, slide, layer),
    });
    const opening = {
      picture: player.snapshot(render),
      parts: player.shownParts(),
    };
    player.finish();
    const ending = {
      picture: player.snapshot(render),
      parts: player.shownParts(),
    };
    return { opening, ending };
  } catch {
    return null;
  } finally {
    player?.destroy();
  }
}
