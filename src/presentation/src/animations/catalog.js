// The animation effects the editor offers: their names, families, options
// and pictures. Effects are stored in the file by preset (class, id and
// subtype — see lib/pptx/.../animation-presets.ts); this catalog names them
// and says what can be changed about each.

export const CATEGORIES = [
  { id: "entr", label: "Entrance", hue: "g" },
  { id: "emph", label: "Emphasis", hue: "y" },
  { id: "exit", label: "Exit", hue: "r" },
  { id: "path", label: "Motion Paths", hue: "b" },
];
export const categoryOf = (cls) =>
  CATEGORIES.find((c) => c.id === cls) || {
    id: cls,
    label: cls === "mediacall" ? "Media" : "Other",
    hue: "n",
  };

const DIR8 = [
  [4, "From Bottom"],
  [12, "From Bottom-Left"],
  [8, "From Left"],
  [9, "From Top-Left"],
  [1, "From Top"],
  [3, "From Top-Right"],
  [2, "From Right"],
  [6, "From Bottom-Right"],
];
const DIR4 = [
  [4, "From Bottom"],
  [8, "From Left"],
  [2, "From Right"],
  [1, "From Top"],
];
const toDir = (list) =>
  list.map(([subtype, label]) => [subtype, label.replace("From", "To")]);
const SPLIT = [
  [26, "Horizontal In"],
  [42, "Horizontal Out"],
  [21, "Vertical In"],
  [37, "Vertical Out"],
];
const WHEEL = [
  [1, "1 Spoke"],
  [2, "2 Spokes"],
  [3, "3 Spokes"],
  [4, "4 Spokes"],
  [8, "8 Spokes"],
];
const BARS = [
  [10, "Horizontal"],
  [5, "Vertical"],
];
const PATH4 = [
  [4, "Down"],
  [8, "Left"],
  [2, "Right"],
  [1, "Up"],
];

// family: basic | subtle | moderate | exciting (the More Effects dialog's
// sections). gallery: shown in the ribbon's gallery. text: needs text.
const entranceAndExit = (cls) => {
  const exit = cls === "exit";
  const name = (enter, leave) => (exit ? leave : enter);
  return [
    {
      id: 1,
      name: name("Appear", "Disappear"),
      family: "basic",
      gallery: true,
      duration: 0,
      mark: "appear",
    },
    {
      id: 10,
      name: "Fade",
      family: "subtle",
      gallery: true,
      mark: "fade",
    },
    {
      id: 2,
      name: name("Fly In", "Fly Out"),
      family: "basic",
      gallery: true,
      options: exit ? toDir(DIR8) : DIR8,
      subtype: 4,
      mark: "fly",
    },
    {
      id: 42,
      name: name("Float In", "Float Out"),
      family: "moderate",
      gallery: true,
      variants: [
        [42, 0, exit ? "Float Down" : "Float Up"],
        [47, 0, exit ? "Float Up" : "Float Down"],
      ],
      alias: [47],
      mark: "float",
    },
    {
      id: 16,
      name: "Split",
      family: "basic",
      gallery: true,
      options: SPLIT,
      subtype: 37,
      mark: "split",
    },
    {
      id: 22,
      name: "Wipe",
      family: "basic",
      gallery: true,
      options: exit ? toDir(DIR4) : DIR4,
      subtype: 4,
      mark: "wipe",
    },
    {
      id: 6,
      name: "Shape",
      family: "basic",
      gallery: true,
      variants: [
        [6, 32, "Circle"],
        [4, 32, "Box"],
        [8, 32, "Diamond"],
        [13, 32, "Plus"],
      ],
      directions: [
        [16, "In"],
        [32, "Out"],
      ],
      alias: [4, 8, 13],
      subtype: 32,
      mark: "shape",
    },
    {
      id: 21,
      name: "Wheel",
      family: "basic",
      gallery: true,
      options: WHEEL,
      subtype: 1,
      mark: "wheel",
    },
    {
      id: 14,
      name: "Random Bars",
      family: "basic",
      gallery: true,
      options: BARS,
      subtype: 10,
      mark: "bars",
    },
    {
      id: 31,
      name: name("Grow & Turn", "Shrink & Turn"),
      family: "moderate",
      gallery: true,
      mark: "turn",
    },
    {
      id: 53,
      name: "Zoom",
      family: "subtle",
      gallery: true,
      options: [
        [16, "Object Center"],
        [528, "Slide Center"],
      ],
      subtype: 16,
      mark: "zoom",
    },
    {
      id: 19,
      name: "Swivel",
      family: "exciting",
      gallery: true,
      duration: 1000,
      mark: "swivel",
    },
    {
      id: 26,
      name: "Bounce",
      family: "exciting",
      gallery: true,
      duration: 1000,
      mark: "bounce",
    },
    {
      id: 3,
      name: "Blinds",
      family: "basic",
      options: BARS,
      subtype: 10,
      mark: "bars",
    },
    {
      id: 5,
      name: "Checkerboard",
      family: "basic",
      options: [
        [10, "Across"],
        [5, "Down"],
      ],
      subtype: 10,
      mark: "checker",
    },
    {
      id: 9,
      name: name("Dissolve In", "Dissolve Out"),
      family: "basic",
      mark: "dissolve",
    },
    {
      id: 12,
      name: name("Peek In", "Peek Out"),
      family: "basic",
      options: exit ? toDir(DIR4) : DIR4,
      subtype: 4,
      mark: "fly",
    },
    {
      id: 18,
      name: "Strips",
      family: "basic",
      options: [
        [12, "Left Down"],
        [9, "Left Up"],
        [6, "Right Down"],
        [3, "Right Up"],
      ],
      subtype: 6,
      mark: "wipe",
    },
    { id: 20, name: "Wedge", family: "basic", mark: "wheel" },
    {
      id: 17,
      name: name("Stretch", "Collapse"),
      family: "moderate",
      mark: "zoom",
    },
    { id: 23, name: "Basic Zoom", family: "moderate", mark: "zoom" },
    {
      id: 37,
      name: name("Rise Up", "Sink Down"),
      family: "moderate",
      mark: "float",
    },
    { id: 43, name: "Center Revolve", family: "moderate", mark: "turn" },
    { id: 49, name: "Spinner", family: "exciting", mark: "turn" },
    {
      id: 55,
      name: name("Expand", "Contract"),
      family: "subtle",
      mark: "zoom",
    },
  ].map((e) => ({ cls, duration: 500, subtype: 0, ...e }));
};

const COLOR = "color";
export const EFFECTS = [
  ...entranceAndExit("entr"),
  ...[
    { id: 26, name: "Pulse", family: "basic", gallery: true, mark: "pulse" },
    {
      id: 27,
      name: "Color Pulse",
      family: "basic",
      gallery: true,
      color: true,
      mark: "colorPulse",
    },
    {
      id: 32,
      name: "Teeter",
      family: "moderate",
      gallery: true,
      duration: 1000,
      mark: "teeter",
    },
    {
      id: 8,
      name: "Spin",
      family: "basic",
      gallery: true,
      duration: 2000,
      amounts: [
        [90, "Quarter Spin"],
        [180, "Half Spin"],
        [360, "Full Spin"],
        [720, "Two Spins"],
      ],
      amount: 360,
      spin: true,
      mark: "spin",
    },
    {
      id: 6,
      name: "Grow/Shrink",
      family: "basic",
      gallery: true,
      duration: 2000,
      amounts: [
        [25, "Tiny"],
        [50, "Smaller"],
        [150, "Larger"],
        [400, "Huge"],
      ],
      amount: 150,
      mark: "grow",
    },
    {
      id: 25,
      name: "Desaturate",
      family: "subtle",
      gallery: true,
      mark: "desaturate",
    },
    { id: 24, name: "Darken", family: "subtle", gallery: true, mark: "darken" },
    {
      id: 30,
      name: "Lighten",
      family: "subtle",
      gallery: true,
      mark: "lighten",
    },
    {
      id: 9,
      name: "Transparency",
      family: "basic",
      gallery: true,
      amounts: [
        [25, "25%"],
        [50, "50%"],
        [75, "75%"],
        [100, "100%"],
      ],
      amount: 50,
      mark: "transparency",
    },
    {
      id: 19,
      name: "Object Color",
      family: "subtle",
      gallery: true,
      color: true,
      mark: COLOR,
    },
    {
      id: 3,
      name: "Font Color",
      family: "basic",
      gallery: true,
      color: true,
      text: true,
      mark: "fontColor",
    },
    {
      id: 18,
      name: "Underline",
      family: "subtle",
      gallery: true,
      text: true,
      mark: "underline",
    },
    {
      id: 10,
      name: "Bold Flash",
      family: "moderate",
      gallery: true,
      text: true,
      mark: "bold",
    },
    {
      id: 34,
      name: "Wave",
      family: "exciting",
      gallery: true,
      text: true,
      mark: "wave",
    },
    {
      id: 1,
      name: "Fill Color",
      family: "basic",
      color: true,
      mark: COLOR,
    },
    {
      id: 7,
      name: "Line Color",
      family: "basic",
      color: true,
      mark: "lineColor",
    },
    {
      id: 15,
      name: "Bold Reveal",
      family: "moderate",
      text: true,
      mark: "bold",
    },
    { id: 35, name: "Blink", family: "exciting", mark: "pulse" },
  ].map((e) => ({ cls: "emph", duration: 500, subtype: 0, ...e })),
  ...entranceAndExit("exit"),
  ...[
    {
      id: 42,
      name: "Lines",
      family: "lines",
      gallery: true,
      options: PATH4,
      subtype: 4,
      mark: "lines",
    },
    {
      id: 37,
      name: "Arcs",
      family: "lines",
      gallery: true,
      options: PATH4,
      subtype: 4,
      mark: "arcs",
    },
    {
      id: 36,
      name: "Turns",
      family: "lines",
      gallery: true,
      options: [
        [4, "Down"],
        [6, "Down Right"],
        [1, "Up"],
        [3, "Up Right"],
      ],
      subtype: 4,
      mark: "turns",
    },
    {
      id: 35,
      name: "Shapes",
      family: "shapes",
      gallery: true,
      options: [
        [0, "Circle"],
        [1, "Diamond"],
        [2, "Triangle"],
        [3, "Square"],
        [4, "Hexagon"],
      ],
      subtype: 0,
      mark: "shapes",
    },
    {
      id: 50,
      name: "Loops",
      family: "shapes",
      gallery: true,
      mark: "loops",
    },
    {
      id: 0,
      name: "Custom Path",
      family: "custom",
      gallery: true,
      custom: true,
      mark: "custom",
    },
  ].map((e) => ({ cls: "path", duration: 2000, subtype: 0, ...e })),
];

export const FAMILIES = {
  basic: "Basic",
  subtle: "Subtle",
  moderate: "Moderate",
  exciting: "Exciting",
  lines: "Lines and Curves",
  shapes: "Shapes",
  custom: "Draw Your Own",
};

export const effectKey = (entry) => `${entry.cls}:${entry.id}`;

/** The catalog entry for an effect read from a slide (or null). */
export function entryFor(effect) {
  if (!effect) return null;
  return (
    EFFECTS.find(
      (e) =>
        e.cls === effect.presetClass &&
        (e.id === effect.presetId || e.alias?.includes(effect.presetId)),
    ) || null
  );
}

/** A name for any effect, including ones the catalog does not offer. */
export function effectName(effect) {
  const entry = entryFor(effect);
  if (!entry)
    return effect.presetClass === "path"
      ? "Custom Path"
      : `${categoryOf(effect.presetClass).label} effect`;
  const variant = entry.variants?.find(
    ([id]) => id === effect.presetId && entry.id !== 6,
  );
  if (entry.id === 42 && variant && entry.cls !== "path") return entry.name;
  if (entry.cls === "entr" && entry.id === 6 && effect.presetId !== 6)
    return "Shape";
  return entry.name;
}

/** A new effect of this catalog entry on a shape. */
export function newEffect(entry, shapeId, extra = {}) {
  const effect = {
    shapeId: String(shapeId),
    presetClass: entry.cls,
    presetId: entry.variants ? entry.variants[0][0] : entry.id,
    presetSubtype: entry.variants ? entry.variants[0][1] : entry.subtype,
    start: "click",
    delayMs: 0,
    durationMs: entry.duration,
    ...(entry.amount !== undefined ? { amount: entry.amount } : {}),
    ...(entry.color ? { color: "E81224" } : {}),
    ...(entry.cls === "path"
      ? { smoothStart: 0.5, smoothEnd: 0.5 }
      : entry.id === 42 && entry.cls !== "path"
        ? { smoothEnd: 1 }
        : {}),
    ...extra,
  };
  return effect;
}

// Picture of an effect: a star (entrance green, emphasis gold, exit red) or a
// path, with a mark for what the effect does, on a 20-unit grid in the
// command icons' classes so themes recolor them.
const starPath = (cx, cy, s) => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const rad = (i % 2 ? 2.3 : 5.2) * s;
    pts.push(
      `${+(cx + rad * Math.cos(a)).toFixed(2)} ${+(cy + rad * Math.sin(a)).toFixed(2)}`,
    );
  }
  return `M${pts.join("L")}z`;
};
const path = (d, c) => `<path class="${c}" d="${d}"/>`;
const dot = (cx, cy, r, c) =>
  `<circle class="${c}" cx="${cx}" cy="${cy}" r="${r}"/>`;
const starAt = (cx, cy, s, hue, glassy = false) => {
  const d = starPath(cx, cy, s);
  return (
    path(d, `${hue}s${glassy ? " glassy" : ""}`) +
    path(d, hue === "y" ? "n" : hue) +
    dot(cx - s, cy - 0.6 * s, 0.7 * s, "glint")
  );
};
const MARKS = {
  appear: (h) => starAt(10, 10.5, 1.35, h),
  fade: (h) =>
    starAt(10, 10.5, 1.35, h, true) +
    path("M3 17.5h2M7 17.5h2M11 17.5h2M15 17.5h2", "o ln"),
  fly: (h) =>
    starAt(10, 8, 1.1, h) + path("M7 15v3M10 14.5v4M13 15v3", `${h} thick`),
  float: (h) =>
    starAt(10, 8.5, 1.1, h, true) +
    path("M6.5 17.5 10 14.5l3.5 3", `${h} thick`),
  split: (h) =>
    starAt(10, 10.5, 1.35, h) +
    path("M10 2v17", "knock thick") +
    path("M10 3v15", "o dash"),
  wipe: (h) =>
    starAt(10, 10.5, 1.35, h, true) +
    path("M3 12.5h14", "o dash") +
    path("M10 15.5v3m-1.5-1.5 1.5 1.5 1.5-1.5", "o"),
  shape: (h) => starAt(10, 10.5, 1.05, h) + dot(10, 10.2, 8, "o dash"),
  wheel: (h) =>
    starAt(10, 10.5, 1.2, h, true) +
    path("M10 10.5V2.5A8 8 0 0 1 18 10.5z", "o"),
  bars: (h) =>
    starAt(10, 10.5, 1.35, h) +
    path("M2 6h16M2 10.5h16M2 15h16", "knock thick"),
  checker: (h) =>
    starAt(10, 10.5, 1.35, h) +
    path("M2 7h6M12 7h6M6 11h6M2 15h6M12 15h6", "knock thick"),
  dissolve: (h) =>
    starAt(10, 10.5, 1.35, h, true) +
    dot(4, 4, 0.9, `${h}s`) +
    dot(16, 5, 0.9, `${h}s`) +
    dot(16.5, 16, 0.9, `${h}s`) +
    dot(3.5, 16.5, 0.9, `${h}s`),
  turn: (h) =>
    starAt(10, 11, 1.05, h) +
    path("M3.5 8A7 7 0 0 1 15 4.5", "o thick") +
    path("M15 2v3h-3", "o"),
  zoom: (h) =>
    starAt(10, 10.5, 0.9, h) +
    path("M2.5 6.5v-4h4M13.5 2.5h4v4M17.5 13.5v4h-4M6.5 17.5h-4v-4", "o"),
  swivel: (h) =>
    starAt(10, 10.5, 1.2, h) +
    `<ellipse class="o dash" cx="10" cy="10.5" rx="8.5" ry="3"/>`,
  bounce: (h) =>
    starAt(13, 12.5, 0.95, h) + path("M2 4c2 0 3 12 5 12s2-6 3.5-6", "o dash"),
  pulse: (h) =>
    starAt(10, 10.5, 1.1, h) +
    dot(10, 10.2, 8.2, "o ln") +
    dot(10, 10.2, 6.6, "o dash"),
  colorPulse: (h) => starAt(10, 10.5, 1.2, h) + dot(10, 10.2, 8, "rs glassy"),
  teeter: (h) =>
    `<g transform="rotate(-14 10 10)">${starAt(10, 10.5, 1.3, h)}</g>` +
    path("M3 18.5h14", "o"),
  spin: (h) =>
    starAt(10, 10.5, 1.05, h) +
    path("M17 10.5A7 7 0 1 1 13.5 4.4", "o thick") +
    path("M11 3.5l2.8.8-.9 2.7", "o"),
  grow: (h) =>
    starAt(7.5, 12.5, 0.75, h) + path(starPath(10, 10, 1.55), "o dash"),
  desaturate: () => starAt(10, 10.5, 1.35, "n", true),
  darken: (h) =>
    starAt(10, 10.5, 1.35, h) + path(starPath(10, 10.5, 1.35), "s glassy"),
  lighten: (h) =>
    starAt(10, 10.5, 1.35, h, true) + path(starPath(10, 10.5, 1.35), "wh"),
  transparency: (h) =>
    starAt(10, 10.5, 1.35, h, true) +
    path("M4 15.5h3v3H4zM10 15.5h3v3h-3z", "o ln"),
  color: (h) =>
    starAt(9, 9.5, 1.1, h) +
    `<rect class="bs" x="3" y="16" width="14" height="2.6" rx="1"/>`,
  lineColor: (h) =>
    path(starPath(10, 9.5, 1.15), "b thick") +
    `<rect class="rs" x="3" y="16" width="14" height="2.6" rx="1"/>` +
    (h ? "" : ""),
  fontColor: () =>
    path("M5.5 14 10 3l4.5 11M7.2 10h5.6", "o thick") +
    `<rect class="rs" x="3" y="16" width="14" height="2.6" rx="1"/>`,
  underline: (h) => starAt(10, 8.5, 1.1, h) + path("M3 17h14", "o thick"),
  bold: (h) =>
    starAt(10, 10.5, 1.4, h) + path(starPath(10, 10.5, 1.4), "o thick"),
  wave: (h) =>
    starAt(10, 7.5, 0.95, h) +
    path("M2 15.5c2-3 4-3 6 0s4 3 6 0 3-2 4-1", "o thick"),
  lines: () =>
    path("M10 3v13", "o dash") +
    dot(10, 3, 1.8, "gs") +
    dot(10, 16.5, 1.8, "rs"),
  arcs: () =>
    path("M3 6c0 11 14 11 14 0", "o dash") +
    dot(3, 6, 1.8, "gs") +
    dot(17, 6, 1.8, "rs"),
  turns: () =>
    path("M4 3v6.5a4 4 0 0 0 4 4h8", "o dash") +
    dot(4, 3, 1.8, "gs") +
    dot(16, 13.5, 1.8, "rs"),
  shapes: () => dot(10, 10, 7, "o dash") + dot(10, 3, 1.8, "gs"),
  loops: () =>
    path("M2 14c5 0 9-1 9-6s-5-5-5-1 6 7 12 7", "o dash") +
    dot(2, 14, 1.8, "gs") +
    dot(18, 14, 1.8, "rs"),
  custom: () =>
    path("M3 15c2-8 5 2 7-5s4-6 7-5", "o dash") +
    dot(3, 15, 1.8, "gs") +
    path("M13 12l4 4m-1.5-5.5 2 2-5.5 5.5H10v-2z", "o"),
  none: () =>
    path(starPath(10, 10.5, 1.35), "of") + path("M3 17 17 3", "r thick"),
};

export function effectIcon(entryOrEffect, size = 32) {
  const entry =
    entryOrEffect && "cls" in entryOrEffect
      ? entryOrEffect
      : entryFor(entryOrEffect);
  const cls = entry?.cls || entryOrEffect?.presetClass || "none";
  const hue = categoryOf(cls).hue;
  const mark = entry
    ? MARKS[entry.mark] || MARKS.appear
    : cls === "path"
      ? MARKS.custom
      : cls === "none"
        ? MARKS.none
        : MARKS.appear;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ico anim-ico");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = mark(hue);
  return svg;
}
export const noneIcon = (size = 32) => effectIcon(null, size);
