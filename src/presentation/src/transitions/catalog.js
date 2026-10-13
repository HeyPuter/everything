// The slide transitions the editor offers, grouped as the gallery shows them,
// with each one's effect options and default duration.
//
// A gallery entry names the file effect it writes (`effect`, plus attributes
// from the chosen option) and recognizes the effects it stands for when a
// deck is read (`matches`). Options are written as partial TransitionOptions
// for lib/pptx `setSlideTransition`; reading compares them after filling in
// the file format's attribute defaults, so an imported `<p:push/>` is "From
// Right" without a `dir` attribute.

const side = (labels = {}) => [
  { id: "u", label: labels.u || "From Bottom", set: { direction: "u" } },
  { id: "r", label: labels.r || "From Left", set: { direction: "r" } },
  { id: "l", label: labels.l || "From Right", set: { direction: "l" } },
  { id: "d", label: labels.d || "From Top", set: { direction: "d" } },
];
const eight = () => [
  { id: "l", label: "From Right", set: { direction: "l" } },
  { id: "d", label: "From Top", set: { direction: "d" } },
  { id: "r", label: "From Left", set: { direction: "r" } },
  { id: "u", label: "From Bottom", set: { direction: "u" } },
  { id: "ld", label: "From Top-Right", set: { direction: "ld" } },
  { id: "lu", label: "From Bottom-Right", set: { direction: "lu" } },
  { id: "rd", label: "From Top-Left", set: { direction: "rd" } },
  { id: "ru", label: "From Bottom-Left", set: { direction: "ru" } },
];
const cubeSides = () => [
  { id: "l", label: "From Right", set: { direction: "l" } },
  { id: "d", label: "From Top", set: { direction: "d" } },
  { id: "r", label: "From Left", set: { direction: "r" } },
  { id: "u", label: "From Bottom", set: { direction: "u" } },
];
const leftRight = (first = "r") =>
  first === "r"
    ? [
        { id: "r", label: "Right", set: { direction: "r" } },
        { id: "l", label: "Left", set: { direction: "l" } },
      ]
    : [
        { id: "l", label: "From Right", set: { direction: "l" } },
        { id: "r", label: "From Left", set: { direction: "r" } },
      ];
const inverted = (first, second) => [
  { id: "a", label: first, set: { invertX: false } },
  { id: "b", label: second, set: { invertX: true } },
];
const orient = (first = "vert") => {
  const items = [
    { id: "vert", label: "Vertical", set: { direction: "vert" } },
    { id: "horz", label: "Horizontal", set: { direction: "horz" } },
  ];
  return first === "vert" ? items : items.reverse();
};

// Attribute defaults the file format gives each effect when an attribute is
// omitted (ECMA-376 pml.xsd and the 2010 extension schema).
const DEFAULTS = {
  push: { direction: "l" },
  wipe: { direction: "l" },
  cover: { direction: "l" },
  pull: { direction: "l" },
  strips: { direction: "lu" },
  split: { orientation: "horz", direction: "out" },
  randomBar: { direction: "horz" },
  blinds: { direction: "horz" },
  checker: { direction: "horz" },
  comb: { direction: "horz" },
  zoom: { direction: "out" },
  warp: { direction: "out" },
  flythrough: { direction: "in", hasBounce: false },
  shred: { pattern: "strip", direction: "in" },
  glitter: { pattern: "diamond", direction: "l" },
  vortex: { direction: "l" },
  prism: { direction: "l", isContent: false, isInverted: false },
  pan: { direction: "l" },
  doors: { direction: "vert" },
  window: { direction: "vert" },
  ripple: { direction: "center" },
  switch: { direction: "r" },
  flip: { direction: "r" },
  gallery: { direction: "l" },
  ferris: { direction: "l" },
  conveyor: { direction: "l" },
  reveal: { direction: "l", thruBlack: false },
  fade: { thruBlack: false },
  cut: { thruBlack: false },
  wheel: { spokes: 4 },
  wheelReverse: { spokes: 4 },
  morph: { morphOption: "byObject" },
};
const PRESET_DEFAULTS = { invertX: false, invertY: false };
const PRESETS = new Set([
  "fallOver",
  "drape",
  "curtains",
  "wind",
  "prestige",
  "fracture",
  "crush",
  "peelOff",
  "pageCurlDouble",
  "pageCurlSingle",
  "airplane",
  "origami",
]);

/** A transition's effect attributes with the format's defaults filled in. */
export function withDefaults(t) {
  if (!t) return t;
  const defaults = PRESETS.has(t.effect)
    ? PRESET_DEFAULTS
    : DEFAULTS[t.effect] || {};
  const out = { ...t };
  for (const [key, value] of Object.entries(defaults))
    if (out[key] === undefined) out[key] = value;
  return out;
}

const is =
  (...effects) =>
  (t) =>
    effects.includes(t.effect);

/** Gallery groups, in order. */
export const TRANSITION_GROUPS = [
  { id: "subtle", label: "Subtle" },
  { id: "exciting", label: "Exciting" },
  { id: "dynamic", label: "Dynamic Content" },
];

// Durations are milliseconds.
export const TRANSITIONS = [
  {
    id: "none",
    label: "None",
    group: "subtle",
    description: "The slide appears without a transition.",
    write: { effect: "none" },
    matches: is("none"),
    duration: 0,
  },
  {
    id: "morph",
    label: "Morph",
    group: "subtle",
    description:
      "Objects glide from where they were on the previous slide to where they are on this one; objects that only one slide has fade. Works best on a duplicated slide with things moved, resized or recolored.",
    write: { effect: "morph" },
    matches: is("morph"),
    options: [
      { id: "byObject", label: "Objects", set: { morphOption: "byObject" } },
      { id: "byWord", label: "Words", set: { morphOption: "byWord" } },
      { id: "byChar", label: "Characters", set: { morphOption: "byChar" } },
    ],
    duration: 2000,
  },
  {
    id: "fade",
    label: "Fade",
    group: "subtle",
    description: "The previous slide dims away as this one comes up.",
    write: { effect: "fade" },
    matches: is("fade"),
    options: [
      { id: "smooth", label: "Smoothly", set: { thruBlack: false } },
      { id: "black", label: "Through Black", set: { thruBlack: true } },
    ],
    duration: 700,
  },
  {
    id: "push",
    label: "Push",
    group: "subtle",
    description: "This slide slides in and pushes the previous one off.",
    write: { effect: "push" },
    matches: is("push"),
    options: side(),
    defaultOption: "u",
    duration: 1000,
  },
  {
    id: "wipe",
    label: "Wipe",
    group: "subtle",
    description: "A soft edge sweeps across, uncovering this slide.",
    write: { effect: "wipe" },
    matches: is("wipe", "strips"),
    options: [
      { id: "l", label: "From Right", set: { effect: "wipe", direction: "l" } },
      { id: "d", label: "From Top", set: { effect: "wipe", direction: "d" } },
      { id: "r", label: "From Left", set: { effect: "wipe", direction: "r" } },
      {
        id: "u",
        label: "From Bottom",
        set: { effect: "wipe", direction: "u" },
      },
      {
        id: "ld",
        label: "From Top-Right",
        set: { effect: "strips", direction: "ld" },
      },
      {
        id: "lu",
        label: "From Bottom-Right",
        set: { effect: "strips", direction: "lu" },
      },
      {
        id: "rd",
        label: "From Top-Left",
        set: { effect: "strips", direction: "rd" },
      },
      {
        id: "ru",
        label: "From Bottom-Left",
        set: { effect: "strips", direction: "ru" },
      },
    ],
    duration: 1000,
  },
  {
    id: "split",
    label: "Split",
    group: "subtle",
    description: "The previous slide opens from the middle onto this one.",
    write: { effect: "split" },
    matches: is("split"),
    options: [
      {
        id: "vert-out",
        label: "Vertical Out",
        set: { orientation: "vert", direction: "out" },
      },
      {
        id: "vert-in",
        label: "Vertical In",
        set: { orientation: "vert", direction: "in" },
      },
      {
        id: "horz-out",
        label: "Horizontal Out",
        set: { orientation: "horz", direction: "out" },
      },
      {
        id: "horz-in",
        label: "Horizontal In",
        set: { orientation: "horz", direction: "in" },
      },
    ],
    duration: 1500,
  },
  {
    id: "reveal",
    label: "Reveal",
    group: "subtle",
    description:
      "The previous slide drifts off and fades, then this slide settles in.",
    write: { effect: "reveal" },
    matches: is("reveal"),
    options: [
      {
        id: "smooth-l",
        label: "Smoothly From Right",
        set: { thruBlack: false, direction: "l" },
      },
      {
        id: "smooth-r",
        label: "Smoothly From Left",
        set: { thruBlack: false, direction: "r" },
      },
      {
        id: "black-l",
        label: "Through Black From Right",
        set: { thruBlack: true, direction: "l" },
      },
      {
        id: "black-r",
        label: "Through Black From Left",
        set: { thruBlack: true, direction: "r" },
      },
    ],
    duration: 2000,
  },
  {
    id: "cut",
    label: "Cut",
    group: "subtle",
    description: "This slide replaces the previous one at once.",
    write: { effect: "cut" },
    matches: is("cut"),
    options: [
      { id: "cut", label: "Cut", set: { thruBlack: false } },
      { id: "black", label: "Through Black", set: { thruBlack: true } },
    ],
    duration: 100,
  },
  {
    id: "randomBar",
    label: "Random Bars",
    group: "subtle",
    description: "Thin bars of this slide fill in at random.",
    write: { effect: "randomBar" },
    matches: is("randomBar"),
    options: orient("vert"),
    duration: 1000,
  },
  {
    id: "shape",
    label: "Shape",
    group: "subtle",
    description: "A growing or shrinking shape opens onto this slide.",
    write: { effect: "circle" },
    matches: is("circle", "diamond", "plus", "zoom"),
    options: [
      { id: "circle", label: "Circle", set: { effect: "circle" } },
      { id: "diamond", label: "Diamond", set: { effect: "diamond" } },
      { id: "plus", label: "Plus", set: { effect: "plus" } },
      { id: "in", label: "In", set: { effect: "zoom", direction: "in" } },
      { id: "out", label: "Out", set: { effect: "zoom", direction: "out" } },
    ],
    duration: 2000,
  },
  {
    id: "uncover",
    label: "Uncover",
    group: "subtle",
    description: "The previous slide slides away, uncovering this one.",
    write: { effect: "pull" },
    matches: is("pull"),
    options: eight(),
    duration: 1000,
  },
  {
    id: "cover",
    label: "Cover",
    group: "subtle",
    description: "This slide slides in over the previous one.",
    write: { effect: "cover" },
    matches: is("cover"),
    options: eight(),
    duration: 1000,
  },
  {
    id: "flash",
    label: "Flash",
    group: "subtle",
    description: "A burst of light carries the show to this slide.",
    write: { effect: "flash" },
    matches: is("flash"),
    duration: 1000,
  },
  {
    id: "fallOver",
    label: "Fall Over",
    group: "exciting",
    description: "The previous slide topples backward, showing this one.",
    write: { effect: "fallOver" },
    matches: is("fallOver"),
    options: inverted("Left", "Right"),
    duration: 2000,
  },
  {
    id: "drape",
    label: "Drape",
    group: "exciting",
    description: "This slide drops over the previous one like fabric.",
    write: { effect: "drape" },
    matches: is("drape"),
    options: inverted("Left", "Right"),
    duration: 2000,
  },
  {
    id: "curtains",
    label: "Curtains",
    group: "exciting",
    description:
      "The previous slide parts in the middle and gathers to each side.",
    write: { effect: "curtains" },
    matches: is("curtains"),
    duration: 2000,
  },
  {
    id: "wind",
    label: "Wind",
    group: "exciting",
    description: "The previous slide ripples and blows off to the side.",
    write: { effect: "wind" },
    matches: is("wind"),
    options: inverted("Right", "Left"),
    duration: 2000,
  },
  {
    id: "prestige",
    label: "Prestige",
    group: "exciting",
    description: "The previous slide is lifted away from its top edge.",
    write: { effect: "prestige" },
    matches: is("prestige"),
    duration: 2000,
  },
  {
    id: "fracture",
    label: "Fracture",
    group: "exciting",
    description: "The previous slide breaks into shards that tumble away.",
    write: { effect: "fracture" },
    matches: is("fracture"),
    duration: 2000,
  },
  {
    id: "crush",
    label: "Crush",
    group: "exciting",
    description: "The previous slide crumples up and is tossed away.",
    write: { effect: "crush" },
    matches: is("crush"),
    duration: 2000,
  },
  {
    id: "peelOff",
    label: "Peel Off",
    group: "exciting",
    description: "The previous slide peels off from a corner.",
    write: { effect: "peelOff" },
    matches: is("peelOff"),
    options: inverted("Left", "Right"),
    duration: 2000,
  },
  {
    id: "pageCurl",
    label: "Page Curl",
    group: "exciting",
    description: "The previous slide turns like a page of a book.",
    write: { effect: "pageCurlDouble" },
    matches: is("pageCurlDouble", "pageCurlSingle"),
    options: [
      {
        id: "double-l",
        label: "Double Left",
        set: { effect: "pageCurlDouble", invertX: false },
      },
      {
        id: "double-r",
        label: "Double Right",
        set: { effect: "pageCurlDouble", invertX: true },
      },
      {
        id: "single-l",
        label: "Single Left",
        set: { effect: "pageCurlSingle", invertX: false },
      },
      {
        id: "single-r",
        label: "Single Right",
        set: { effect: "pageCurlSingle", invertX: true },
      },
    ],
    duration: 2000,
  },
  {
    id: "airplane",
    label: "Airplane",
    group: "exciting",
    description: "The previous slide folds into a paper plane and flies off.",
    write: { effect: "airplane" },
    matches: is("airplane"),
    options: inverted("Right", "Left"),
    duration: 2000,
  },
  {
    id: "origami",
    label: "Origami",
    group: "exciting",
    description: "The previous slide folds up into a paper bird and flies off.",
    write: { effect: "origami" },
    matches: is("origami"),
    options: inverted("Right", "Left"),
    duration: 2000,
  },
  {
    id: "dissolve",
    label: "Dissolve",
    group: "exciting",
    description: "The previous slide breaks into specks that become this one.",
    write: { effect: "dissolve" },
    matches: is("dissolve"),
    duration: 1200,
  },
  {
    id: "checker",
    label: "Checkerboard",
    group: "exciting",
    description: "Squares turn over one after another to show this slide.",
    write: { effect: "checker" },
    matches: is("checker"),
    options: [
      { id: "horz", label: "From Left", set: { direction: "horz" } },
      { id: "vert", label: "From Top", set: { direction: "vert" } },
    ],
    duration: 1600,
  },
  {
    id: "blinds",
    label: "Blinds",
    group: "exciting",
    description: "Slats turn over like window blinds.",
    write: { effect: "blinds" },
    matches: is("blinds"),
    options: orient("vert"),
    duration: 1600,
  },
  {
    id: "clock",
    label: "Clock",
    group: "exciting",
    description: "A sweeping hand uncovers this slide.",
    write: { effect: "wheel", spokes: 1 },
    matches: is("wheel", "wheelReverse", "wedge"),
    options: [
      {
        id: "cw",
        label: "Clockwise",
        set: { effect: "wheel", spokes: 1 },
      },
      {
        id: "ccw",
        label: "Counterclockwise",
        set: { effect: "wheelReverse", spokes: 1 },
      },
      { id: "wedge", label: "Wedge", set: { effect: "wedge" } },
    ],
    duration: 2000,
  },
  {
    id: "ripple",
    label: "Ripple",
    group: "exciting",
    description: "Waves spread across the previous slide as this one appears.",
    write: { effect: "ripple" },
    matches: is("ripple"),
    options: [
      { id: "center", label: "Center", set: { direction: "center" } },
      { id: "lu", label: "From Top-Left", set: { direction: "lu" } },
      { id: "ru", label: "From Top-Right", set: { direction: "ru" } },
      { id: "ld", label: "From Bottom-Left", set: { direction: "ld" } },
      { id: "rd", label: "From Bottom-Right", set: { direction: "rd" } },
    ],
    duration: 1400,
  },
  {
    id: "honeycomb",
    label: "Honeycomb",
    group: "exciting",
    description: "Hexagon cells open across the slide onto this one.",
    write: { effect: "honeycomb" },
    matches: is("honeycomb"),
    duration: 3000,
  },
  {
    id: "glitter",
    label: "Glitter",
    group: "exciting",
    description: "A wave of small sparkling tiles turns over the slide.",
    write: { effect: "glitter" },
    matches: is("glitter"),
    options: [
      ["diamond", "Diamonds"],
      ["hexagon", "Hexagons"],
    ].flatMap(([pattern, name]) =>
      [
        ["r", "From Left"],
        ["d", "From Top"],
        ["l", "From Right"],
        ["u", "From Bottom"],
      ].map(([direction, where]) => ({
        id: `${pattern}-${direction}`,
        label: `${name} ${where}`,
        set: { pattern, direction },
      })),
    ),
    defaultOption: "diamond-r",
    duration: 2500,
  },
  {
    id: "vortex",
    label: "Vortex",
    group: "exciting",
    description:
      "The slide swirls apart in a whirl of tiles and back together.",
    write: { effect: "vortex" },
    matches: is("vortex"),
    options: side(),
    defaultOption: "r",
    duration: 3000,
  },
  {
    id: "shred",
    label: "Shred",
    group: "exciting",
    description: "The previous slide is cut into pieces that become this one.",
    write: { effect: "shred" },
    matches: is("shred"),
    options: [
      {
        id: "strip-in",
        label: "Strips In",
        set: { pattern: "strip", direction: "in" },
      },
      {
        id: "strip-out",
        label: "Strips Out",
        set: { pattern: "strip", direction: "out" },
      },
      {
        id: "rect-in",
        label: "Particles In",
        set: { pattern: "rectangle", direction: "in" },
      },
      {
        id: "rect-out",
        label: "Particles Out",
        set: { pattern: "rectangle", direction: "out" },
      },
    ],
    duration: 2000,
  },
  {
    id: "switch",
    label: "Switch",
    group: "exciting",
    description: "The two slides trade places, front to back.",
    write: { effect: "switch" },
    matches: is("switch"),
    options: leftRight("r"),
    duration: 1250,
  },
  {
    id: "flip",
    label: "Flip",
    group: "exciting",
    description: "The slide turns over to show this one on its back.",
    write: { effect: "flip" },
    matches: is("flip"),
    options: leftRight("r"),
    duration: 1250,
  },
  {
    id: "gallery",
    label: "Gallery",
    group: "exciting",
    description: "Slides swing past like pictures along a wall.",
    write: { effect: "gallery" },
    matches: is("gallery"),
    options: leftRight("l"),
    duration: 1600,
  },
  {
    id: "cube",
    label: "Cube",
    group: "exciting",
    description: "The slides sit on the faces of a turning cube.",
    write: { effect: "prism" },
    matches: (t) => t.effect === "prism" && !t.isContent && !t.isInverted,
    options: cubeSides(),
    duration: 1250,
  },
  {
    id: "doors",
    label: "Doors",
    group: "exciting",
    description: "The previous slide swings open like a pair of doors.",
    write: { effect: "doors" },
    matches: is("doors"),
    options: orient("vert"),
    duration: 1400,
  },
  {
    id: "box",
    label: "Box",
    group: "exciting",
    description: "The slides sit on the inside walls of a turning box.",
    write: { effect: "prism", isInverted: true },
    matches: (t) => t.effect === "prism" && !t.isContent && !!t.isInverted,
    options: cubeSides(),
    duration: 1600,
  },
  {
    id: "comb",
    label: "Comb",
    group: "exciting",
    description: "Teeth of the previous slide slide apart in turn.",
    write: { effect: "comb" },
    matches: is("comb"),
    options: orient("horz"),
    duration: 1000,
  },
  {
    id: "zoom",
    label: "Zoom",
    group: "exciting",
    description: "The view rushes in or out to reach this slide.",
    write: { effect: "warp", direction: "in" },
    matches: is("warp", "newsflash"),
    options: [
      { id: "in", label: "In", set: { effect: "warp", direction: "in" } },
      { id: "out", label: "Out", set: { effect: "warp", direction: "out" } },
      {
        id: "rotate",
        label: "Zoom and Rotate",
        set: { effect: "newsflash" },
      },
    ],
    duration: 1000,
  },
  {
    id: "random",
    label: "Random",
    group: "exciting",
    description: "A different transition is picked each time the show runs.",
    write: { effect: "random" },
    matches: is("random"),
    duration: 2000,
  },
  {
    id: "pan",
    label: "Pan",
    group: "dynamic",
    description:
      "The content glides across while the slide background holds still.",
    write: { effect: "pan" },
    matches: is("pan"),
    options: side(),
    defaultOption: "u",
    duration: 1000,
  },
  {
    id: "ferris",
    label: "Ferris Wheel",
    group: "dynamic",
    description: "The content swings around a wheel and away.",
    write: { effect: "ferris" },
    matches: is("ferris"),
    options: leftRight("l"),
    duration: 2000,
  },
  {
    id: "conveyor",
    label: "Conveyor",
    group: "dynamic",
    description: "The content rides off as if on a belt and the next arrives.",
    write: { effect: "conveyor" },
    matches: is("conveyor"),
    options: leftRight("l"),
    duration: 2000,
  },
  {
    id: "rotate",
    label: "Rotate",
    group: "dynamic",
    description: "The content turns on an axis to show the next.",
    write: { effect: "prism", isContent: true },
    matches: (t) => t.effect === "prism" && !!t.isContent && !t.isInverted,
    options: cubeSides(),
    duration: 1250,
  },
  {
    id: "window",
    label: "Window",
    group: "dynamic",
    description: "The content opens like shutters onto the next.",
    write: { effect: "window" },
    matches: is("window"),
    options: orient("vert"),
    duration: 1250,
  },
  {
    id: "orbit",
    label: "Orbit",
    group: "dynamic",
    description: "The content circles out of view as the next circles in.",
    write: { effect: "prism", isContent: true, isInverted: true },
    matches: (t) => t.effect === "prism" && !!t.isContent && !!t.isInverted,
    options: cubeSides(),
    duration: 1250,
  },
  {
    id: "flythrough",
    label: "Fly Through",
    group: "dynamic",
    description: "The content flies past the viewer and the next flies in.",
    write: { effect: "flythrough" },
    matches: is("flythrough"),
    options: [
      { id: "in", label: "In", set: { direction: "in", hasBounce: false } },
      {
        id: "in-bounce",
        label: "In with Bounce",
        set: { direction: "in", hasBounce: true },
      },
      { id: "out", label: "Out", set: { direction: "out", hasBounce: false } },
      {
        id: "out-bounce",
        label: "Out with Bounce",
        set: { direction: "out", hasBounce: true },
      },
    ],
    duration: 1000,
  },
];

const BY_ID = new Map(TRANSITIONS.map((entry) => [entry.id, entry]));
export const transitionEntry = (id) => BY_ID.get(id) || null;

/** The effect tokens any entry can play. */
export const PLAYABLE_EFFECTS = new Set([
  "none",
  "fade",
  "push",
  "wipe",
  "strips",
  "split",
  "reveal",
  "cut",
  "randomBar",
  "circle",
  "diamond",
  "plus",
  "zoom",
  "pull",
  "cover",
  "flash",
  ...PRESETS,
  "dissolve",
  "checker",
  "blinds",
  "wheel",
  "wheelReverse",
  "wedge",
  "ripple",
  "honeycomb",
  "glitter",
  "vortex",
  "shred",
  "switch",
  "flip",
  "gallery",
  "prism",
  "doors",
  "comb",
  "warp",
  "newsflash",
  "random",
  "pan",
  "ferris",
  "conveyor",
  "window",
  "flythrough",
  "morph",
]);

// An option that names its own effect replaces the entry's whole effect.
const written = (entry, option) =>
  option?.set?.effect
    ? { ...option.set }
    : { ...entry.write, ...(option?.set || {}) };
const optionMatches = (option, t, entry) => {
  const full = withDefaults(written(entry, option));
  const actual = withDefaults(t);
  return Object.keys(full).every((key) => {
    const want = full[key],
      have = actual[key];
    if (typeof want === "boolean") return !!have === want;
    return have === want;
  });
};

/**
 * The gallery entry and option a transition read from a deck stands for.
 * `{ id: "other" }` is a transition no entry knows (kept as authored).
 */
export function identifyTransition(t) {
  if (!t || t.effect === "none") return { id: "none", option: null };
  const entry = TRANSITIONS.find(
    (candidate) => candidate.id !== "none" && candidate.matches(t),
  );
  if (!entry) return { id: "other", option: null };
  const option = entry.options?.find((o) => optionMatches(o, t, entry));
  return { id: entry.id, option: option?.id ?? null };
}

/** The default option of an entry. */
export const defaultOption = (entry) =>
  entry.options?.find((o) => o.id === entry.defaultOption) ||
  entry.options?.[0] ||
  null;

// Effect attributes a transition carries; everything else (timing, sound) is
// kept when the effect changes.
const EFFECT_KEYS = [
  "effect",
  "direction",
  "orientation",
  "thruBlack",
  "invertX",
  "invertY",
  "spokes",
  "pattern",
  "isContent",
  "isInverted",
  "hasBounce",
  "morphOption",
];
export const stripEffect = (t) => {
  const out = { ...(t || {}) };
  for (const key of EFFECT_KEYS) delete out[key];
  return out;
};

/** Speed token that best describes a duration, for readers without p14:dur. */
export const speedFor = (ms) =>
  ms <= 500 ? "fast" : ms <= 750 ? "med" : "slow";

/**
 * The TransitionOptions for choosing `id` (and an option) on a slide whose
 * current transition is `current`: the entry's effect with its default
 * duration, keeping the slide's advance timing and sound.
 */
export function transitionFor(id, optionId, current) {
  const entry = transitionEntry(id);
  if (!entry) return null;
  const keep = stripEffect(current);
  if (id === "none") {
    delete keep.durationMs;
    delete keep.speed;
    return { ...keep, effect: "none" };
  }
  const option =
    entry.options?.find((o) => o.id === optionId) || defaultOption(entry);
  const durationMs =
    optionId != null && current?.durationMs != null
      ? current.durationMs
      : entry.duration;
  return clean({
    ...keep,
    ...written(entry, option),
    durationMs,
    speed: speedFor(durationMs),
  });
}

// Drop false defaults that only make the XML noisier.
function clean(t) {
  const out = {};
  for (const [key, value] of Object.entries(t)) {
    if (value === undefined) continue;
    if (
      value === false &&
      [
        "thruBlack",
        "invertX",
        "invertY",
        "isContent",
        "isInverted",
        "hasBounce",
      ].includes(key)
    )
      continue;
    out[key] = value;
  }
  return out;
}

/** Duration of a transition in ms: the authored one, else its speed. */
export const transitionDurationMs = (t) =>
  t?.durationMs ?? { fast: 500, med: 750, slow: 1000 }[t?.speed ?? "fast"];
