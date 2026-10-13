// Small pictures of each transition for the gallery, drawn on a 44 × 28
// grid: the slide leaving is the pale card ("o"), the slide arriving the
// coloured one ("n"). Colours come from CSS (transitions.css) so that both
// themes read well.

const W = 44,
  H = 28;
const o = (d) => `<path class="tt-o" d="${d}"/>`;
const n = (d) => `<path class="tt-n" d="${d}"/>`;
const line = (d) => `<path class="tt-l" d="${d}"/>`;
const rect = (x, y, w, h) => `M${x} ${y}h${w}v${h}h${-w}z`;
const full = rect(0, 0, W, H);
const arrow = (x, y, dir) => {
  const a = {
    u: `M${x} ${y + 4}V${y - 4}M${x - 3} ${y - 1}L${x} ${y - 4}L${x + 3} ${y - 1}`,
    d: `M${x} ${y - 4}V${y + 4}M${x - 3} ${y + 1}L${x} ${y + 4}L${x + 3} ${y + 1}`,
    l: `M${x + 4} ${y}H${x - 4}M${x - 1} ${y - 3}L${x - 4} ${y}L${x - 1} ${y + 3}`,
    r: `M${x - 4} ${y}H${x + 4}M${x + 1} ${y - 3}L${x + 4} ${y}L${x + 1} ${y + 3}`,
  }[dir];
  return `<path class="tt-a" d="${a}"/>`;
};
const poly = (points) => `M${points.map((p) => p.join(" ")).join("L")}z`;
const hex = (cx, cy, r) =>
  poly(
    [0, 1, 2, 3, 4, 5].map((i) => {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      return [
        +(cx + r * Math.cos(a)).toFixed(1),
        +(cy + r * Math.sin(a)).toFixed(1),
      ];
    }),
  );

const PICTURES = {
  none: () =>
    `<path class="tt-blank" d="${full}"/><path class="tt-none" d="M6 22L38 6"/>`,
  morph: () =>
    n(full) +
    `<circle class="tt-ghost" cx="11" cy="17" r="4"/>` +
    `<circle class="tt-ghost" cx="20" cy="12" r="5"/>` +
    `<circle class="tt-s" cx="31" cy="11" r="7"/>` +
    `<rect class="tt-ghost" x="6" y="5" width="9" height="3" rx="1"/>` +
    `<rect class="tt-s" x="24" y="21" width="15" height="3" rx="1"/>`,
  fade: () =>
    `<defs><linearGradient id="ttfade"><stop offset="0" class="tt-stop-o"/><stop offset="1" class="tt-stop-n"/></linearGradient></defs><path fill="url(#ttfade)" d="${full}"/>`,
  push: () => o(rect(0, 0, W, 9)) + n(rect(0, 9, W, 19)) + arrow(22, 18, "u"),
  wipe: () =>
    `<defs><linearGradient id="ttwipe"><stop offset="0.35" class="tt-stop-o"/><stop offset="0.65" class="tt-stop-n"/></linearGradient></defs><path fill="url(#ttwipe)" d="${full}"/>` +
    arrow(30, 14, "l"),
  split: () =>
    o(full) + n(rect(14, 0, 16, H)) + arrow(9, 14, "l") + arrow(35, 14, "r"),
  reveal: () => n(full) + o(rect(-6, 3, 26, 22)) + arrow(30, 14, "l"),
  cut: () => o(rect(0, 0, 21, H)) + n(rect(23, 0, 21, H)),
  randomBar: () =>
    o(full) +
    [1, 4, 6, 10, 13, 15, 19, 22, 25]
      .map((y, i) => n(rect(0, y, W, i % 3 ? 1.6 : 2.4)))
      .join(""),
  shape: () => o(full) + `<circle class="tt-n" cx="22" cy="14" r="9"/>`,
  uncover: () =>
    n(full) +
    `<path class="tt-shadow" d="${rect(-14, 2, 42, 26)}"/>` +
    o(rect(-16, 0, 42, H)) +
    arrow(34, 14, "l"),
  cover: () =>
    o(full) +
    `<path class="tt-shadow" d="${rect(20, 2, 30, 26)}"/>` +
    n(rect(18, 0, 30, H)) +
    arrow(10, 14, "l"),
  flash: () =>
    n(full) +
    `<path class="tt-glow" d="M22 2L25 11L34 8L27 14L34 20L25 17L22 26L19 17L10 20L17 14L10 8L19 11z"/>`,
  fallOver: () =>
    n(full) +
    o(
      poly([
        [4, 27],
        [40, 27],
        [34, 15],
        [10, 15],
      ]),
    ),
  drape: () =>
    o(full) +
    n(
      "M0 0H44V17C40 21 36 15 32 19C28 23 24 15 20 19C16 23 12 15 8 19C5 22 2 17 0 19Z",
    ),
  curtains: () =>
    n(full) +
    o("M0 0H12C10 6 13 10 10 14C13 18 9 22 12 28H0Z") +
    o("M44 0H32C34 6 31 10 34 14C31 18 35 22 32 28H44Z") +
    line("M4 0V28M8 0V28M40 0V28M36 0V28"),
  wind: () =>
    n(full) +
    o("M0 0H22C26 4 20 8 26 12C30 16 22 20 28 24L30 28H0Z") +
    line("M33 7H41M35 13H43M32 19H40"),
  prestige: () =>
    n(full) +
    o(
      poly([
        [22, 1],
        [36, 22],
        [8, 22],
      ]),
    ),
  fracture: () =>
    n(full) +
    o(
      poly([
        [0, 0],
        [14, 0],
        [9, 11],
        [0, 8],
      ]),
    ) +
    o(
      poly([
        [16, 1],
        [26, 3],
        [20, 12],
        [12, 11],
      ]),
    ) +
    o(
      poly([
        [29, 4],
        [41, 2],
        [38, 13],
        [27, 12],
      ]),
    ) +
    o(
      poly([
        [3, 15],
        [13, 16],
        [9, 26],
        [1, 24],
      ]),
    ) +
    o(
      poly([
        [24, 17],
        [33, 18],
        [30, 27],
        [21, 25],
      ]),
    ),
  crush: () =>
    n(full) +
    o(
      "M15 9C18 5 26 6 28 9C33 9 33 15 30 17C31 22 24 23 21 21C16 23 12 19 14 16C10 14 12 9 15 9Z",
    ) +
    line("M17 12L22 15L26 11M19 18L24 16"),
  peelOff: () =>
    n(full) +
    o("M0 0H44V12L28 28H0Z") +
    `<path class="tt-back" d="M44 12L28 28L34 14Z"/>`,
  pageCurl: () =>
    n(full) +
    o("M0 0H30C26 9 26 19 30 28H0Z") +
    `<path class="tt-back" d="M30 0C38 3 40 7 36 14C40 21 38 25 30 28C26 19 26 9 30 0Z"/>`,
  airplane: () =>
    n(full) +
    o(
      poly([
        [8, 22],
        [38, 5],
        [20, 16],
      ]),
    ) +
    `<path class="tt-back" d="M20 16L38 5L22 24Z"/>`,
  origami: () =>
    n(full) +
    o(
      poly([
        [10, 18],
        [20, 14],
        [16, 4],
        [26, 13],
        [36, 9],
        [28, 20],
        [18, 22],
      ]),
    ) +
    `<path class="tt-back" d="M20 14L26 13L28 20L18 22Z"/>`,
  dissolve: () => {
    let d = "";
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 11; x++)
        if ((x * 7 + y * 13 + x * y) % 5 < 2) d += rect(x * 4, y * 4, 4, 4);
    return o(full) + n(d);
  },
  checker: () => {
    let d = "";
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 6; x++)
        if ((x + y) % 2 === 0 || x < 2) d += rect(x * 7.33, y * 7, 7.33, 7);
    return o(full) + n(d);
  },
  blinds: () =>
    o(full) +
    [0, 1, 2, 3, 4, 5]
      .map((i) =>
        n(
          poly([
            [i * 7.33 + 1, 1],
            [i * 7.33 + 5, 3],
            [i * 7.33 + 5, 25],
            [i * 7.33 + 1, 27],
          ]),
        ),
      )
      .join(""),
  clock: () => o(full) + n("M22 14V-12A30 30 0 0 1 48 29Z") + line("M22 14V0"),
  ripple: () =>
    n(full) +
    [5, 10, 15, 20]
      .map((r) => `<circle class="tt-ring" cx="22" cy="14" r="${r}"/>`)
      .join(""),
  honeycomb: () =>
    o(full) +
    [
      [8, 7],
      [22, 7],
      [36, 7],
      [15, 19],
      [29, 19],
    ]
      .map(([x, y], i) =>
        i % 2
          ? n(hex(x, y, 6.2))
          : `<path class="tt-dark" d="${hex(x, y, 6.2)}"/>`,
      )
      .join(""),
  glitter: () => {
    let d = "";
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 9; x++)
        if (x + (y % 2) * 0.5 < 5 + (y % 3))
          d += `M${x * 5 + 2.5} ${y * 6 + 0.5}l2.5 3l-2.5 3l-2.5 -3z`;
    return (
      n(full) +
      o(d) +
      `<path class="tt-glow" d="M30 4l1 2l2 1l-2 1l-1 2l-1 -2l-2 -1l2 -1z"/>`
    );
  },
  vortex: () =>
    n(full) +
    `<path class="tt-swirl" d="M22 14C22 11 26 11 26 14C26 19 18 19 17 14C16 7 28 6 30 13C32 21 18 25 12 18"/>` +
    o(rect(31, 4, 4, 4)) +
    o(rect(36, 17, 3, 3)) +
    o(rect(6, 6, 4, 4)),
  shred: () =>
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
      .map((i) => (i % 2 ? o(rect(i * 4, -4, 4, H)) : n(rect(i * 4, 4, 4, H))))
      .join(""),
  switch: () =>
    o(rect(2, 2, 26, 18)) +
    `<path class="tt-shadow" d="${rect(17, 9, 26, 18)}"/>` +
    n(rect(16, 8, 26, 18)),
  flip: () =>
    n(
      poly([
        [13, 2],
        [31, 5],
        [31, 23],
        [13, 26],
      ]),
    ) +
    o(
      poly([
        [13, 2],
        [8, 6],
        [8, 22],
        [13, 26],
      ]),
    ),
  gallery: () =>
    o(
      poly([
        [1, 6],
        [14, 3],
        [14, 25],
        [1, 22],
      ]),
    ) +
    n(
      poly([
        [18, 2],
        [43, 5],
        [43, 23],
        [18, 26],
      ]),
    ),
  cube: () =>
    o(
      poly([
        [3, 4],
        [21, 2],
        [21, 26],
        [3, 24],
      ]),
    ) +
    n(
      poly([
        [21, 2],
        [41, 5],
        [41, 23],
        [21, 26],
      ]),
    ),
  doors: () =>
    n(rect(8, 4, 28, 20)) +
    o(
      poly([
        [0, 0],
        [9, 4],
        [9, 24],
        [0, 28],
      ]),
    ) +
    o(
      poly([
        [44, 0],
        [35, 4],
        [35, 24],
        [44, 28],
      ]),
    ),
  box: () =>
    o(
      poly([
        [3, 2],
        [21, 5],
        [21, 23],
        [3, 26],
      ]),
    ) +
    n(
      poly([
        [21, 5],
        [41, 2],
        [41, 26],
        [21, 23],
      ]),
    ),
  comb: () =>
    n(full) +
    [0, 1, 2, 3, 4, 5, 6]
      .map((i) => o(rect(i % 2 ? 10 : -10, i * 4, 44, 4)))
      .join(""),
  zoom: () =>
    o(full) +
    n(rect(10, 6, 24, 16)) +
    line("M2 2L8 6M42 2L36 6M2 26L8 22M42 26L36 22"),
  random: () =>
    o(rect(0, 0, 22, H)) +
    n(rect(22, 0, 22, H)) +
    `<rect class="tt-die" x="15" y="7" width="14" height="14" rx="3"/>` +
    `<circle class="tt-pip" cx="19" cy="11" r="1.5"/><circle class="tt-pip" cx="25" cy="17" r="1.5"/><circle class="tt-pip" cx="22" cy="14" r="1.5"/>`,
  pan: () =>
    `<path class="tt-bg" d="${full}"/>` +
    o(rect(9, -2, 26, 8)) +
    n(rect(9, 10, 26, 14)) +
    arrow(40, 14, "u"),
  ferris: () =>
    `<path class="tt-bg" d="${full}"/>` +
    `<path class="tt-ring" d="M2 30A22 22 0 0 1 42 30"/>` +
    o(
      poly([
        [2, 6],
        [12, 3],
        [14, 10],
        [4, 13],
      ]),
    ) +
    n(rect(16, 9, 18, 12)),
  conveyor: () =>
    `<path class="tt-bg" d="${full}"/>` +
    o(
      poly([
        [1, 9],
        [10, 7],
        [10, 21],
        [1, 19],
      ]),
    ) +
    n(rect(14, 6, 22, 16)) +
    line("M2 25H42"),
  rotate: () =>
    `<path class="tt-bg" d="${full}"/>` +
    o(
      poly([
        [5, 7],
        [19, 5],
        [19, 23],
        [5, 21],
      ]),
    ) +
    n(
      poly([
        [19, 5],
        [39, 7],
        [39, 21],
        [19, 23],
      ]),
    ),
  window: () =>
    `<path class="tt-bg" d="${full}"/>` +
    n(rect(13, 8, 18, 12)) +
    o(
      poly([
        [2, 4],
        [11, 7],
        [11, 21],
        [2, 24],
      ]),
    ) +
    o(
      poly([
        [42, 4],
        [33, 7],
        [33, 21],
        [42, 24],
      ]),
    ),
  orbit: () =>
    `<path class="tt-bg" d="${full}"/>` +
    `<ellipse class="tt-ring" cx="22" cy="15" rx="19" ry="8"/>` +
    o(rect(4, 9, 9, 7)) +
    n(rect(17, 8, 20, 13)),
  flythrough: () =>
    `<path class="tt-bg" d="${full}"/>` +
    o(rect(-4, -2, 52, 32)) +
    `<path class="tt-bg" d="${rect(2, 2, 40, 24)}"/>` +
    n(rect(15, 9, 14, 10)),
};

/** The picture for gallery entry `id`, as an SVG element. */
export function transitionThumbnail(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "transition-thumb");
  svg.dataset.transition = id;
  // Clip to the slide's rounded frame so that moving cards stay inside it.
  const clipId = `tt-clip-${id}-${++serial}`;
  svg.innerHTML =
    `<clipPath id="${clipId}"><rect width="${W}" height="${H}" rx="2.5"/></clipPath>` +
    `<g clip-path="url(#${clipId})">${(PICTURES[id] || PICTURES.fade)()
      .replace(/id="tt(\w+)"/g, `id="tt$1-${serial}"`)
      .replace(/url\(#tt(\w+)\)/g, `url(#tt$1-${serial})`)}</g>` +
    `<rect class="tt-frame" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="2.5"/>`;
  return svg;
}
let serial = 0;

export const THUMBNAIL_IDS = Object.keys(PICTURES);
