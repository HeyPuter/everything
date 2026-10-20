// Plays a slide's animations during a slide show. The show asks the animator
// for each advance before it moves to the next slide, so a slide with click
// steps uses its clicks first.
//
//   createSlideAnimator({ pres, slide, frame, image, reducedMotion })
//
// `frame` is the show's slide container and `image` the slide's rendered
// picture inside it; the animator may lay pictures of its own over or in
// place of `image`, and must remove them in `destroy()`.
//
// The returned animator:
//   steps          the number of click steps on the slide
//   start()        shows the slide's opening state (objects that enter later
//                  are hidden) and plays what runs before the first click
//   next()         plays the next click step; false when none is left, so
//                  the show moves on to the next slide
//   played         settles when the step last started by next() ends
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
  triggers: [],
  start() {},
  next: () => false,
  previous: () => false,
  played: Promise.resolve(),
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
}) {
  let effects;
  try {
    // Media start and pause steps belong to the show's media players
    // (src/insert/show.js), which take their clicks after the animations'.
    effects = P.getSlideAnimations(slide).filter(
      (e) => e.presetClass !== "mediacall",
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
  const activate = () => {
    if (active) return;
    active = true;
    stage?.classList.remove("waiting");
    image?.classList.add("anim-covered");
  };
  return {
    steps: player.steps,
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
