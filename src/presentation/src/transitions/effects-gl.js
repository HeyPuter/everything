// Transitions drawn in depth with WebGL (see gl.js). Each effect draws one
// frame from slide A (leaving) to slide B (arriving) at progress q; `g`
// carries the renderer (`g.gl`), the slide pictures (`g.A`, `g.B`), the
// effect attributes (`g.o`), `g.random(i)` and, for dynamic content, the
// background and content layers (`g.layers`).

import { rotateX, rotateY, rotateZ } from "./gl.js";
import {
  clamp,
  easeIn,
  easeInOut,
  easeOut,
  local,
  smooth,
} from "./effects-2d.js";

const flatOf = (g) => g.gl.flat;
const PI = Math.PI;

// Draws a whole slide flat.
function flat(g, image, options) {
  g.gl.grid(image, flatOf(g), { cols: 1, rows: 1, ...options });
}
const translate = ([x, y, z], dx = 0, dy = 0, dz = 0) => [
  x + dx,
  y + dy,
  z + dz,
];

// Content and background for dynamic content effects; without layers the
// whole slide counts as content over black.
function parts(g) {
  const L = g.layers;
  if (L) {
    flat(g, L.A.bg);
    flat(g, L.B.bg, { alpha: smooth(g.q) });
    return [L.A.fg, L.B.fg];
  }
  return [g.A, g.B];
}

// Rolls part of a page around a cylinder: points past the fold line (along
// unit direction d, at offset `line`) wrap around radius R and come back over.
function curl([x, y, z], d, line, R) {
  const s = x * d[0] + y * d[1] - line;
  if (s <= 0) return [x, y, z];
  const phi = s / R;
  let s2, z2;
  if (phi < PI) {
    s2 = R * Math.sin(phi);
    z2 = R * (1 - Math.cos(phi));
  } else {
    s2 = -(s - PI * R);
    z2 = 2 * R;
  }
  const ds = s2 - s;
  return [x + d[0] * ds, y + d[1] * ds, z + z2];
}

// A turning slab (cube, box, rotate, orbit): A on one face and B on the next,
// the slab turning by a quarter about its middle, `depth` behind (cube) or in
// front (box) of the slide plane.
function slab(g, a, b, inside, light = true) {
  const { o } = g;
  const aspect = g.gl.aspect;
  const e = easeInOut(g.q);
  const horizontal = o.direction === "l" || o.direction === "r";
  const sign = o.direction === "l" || o.direction === "u" ? 1 : -1;
  const half = horizontal ? aspect : 1;
  const center = inside ? half : -half;
  const pull = -Math.sin(e * PI) * (inside ? 2.4 : 0.9);
  const turn = (p, angle) =>
    horizontal ? rotateY(p, angle, 0, center) : rotateX(p, -angle, 0, center);
  const quarter = ((inside ? -1 : 1) * sign * PI) / 2;
  const face = (image, base) =>
    g.gl.grid(
      image,
      (u, v) =>
        translate(
          turn(turn(flatOf(g)(u, v), base), quarter * e * -1),
          0,
          0,
          pull,
        ),
      { cols: 8, rows: 6, depth: true, light: light ? 1 : 1.1 },
    );
  face(a, 0);
  face(b, quarter);
}

export const EFFECTS_GL = {
  fallOver(g) {
    const { q, o } = g;
    const e = easeIn(q);
    const sign = o.invertX ? -1 : 1;
    flat(g, g.B);
    // A tips back about its bottom edge and twists toward one side as it
    // goes down.
    g.gl.grid(
      g.A,
      (u, v) => {
        let p = flatOf(g)(u, v);
        p = rotateX(p, -e * PI * 0.5, -1, 0);
        p = rotateZ(p, sign * e * 0.25, sign * g.gl.aspect, -1);
        return p;
      },
      { cols: 6, rows: 10, alpha: 1 - clamp((q - 0.8) * 5) },
    );
  },
  drape(g) {
    const { q, o } = g;
    const e = easeOut(q);
    const sway = o.invertX ? -1 : 1;
    flat(g, g.A);
    g.gl.grid(
      g.B,
      (u, v) => {
        const [x, y] = flatOf(g)(u, v);
        const fall = (1 - e) * 2.2;
        // The lower edge trails and billows; the folds die away as it lands.
        const lag = (1 - v) * (1 - e) * 0.6;
        const fold =
          Math.sin(u * PI * 5 + q * 7 * sway) * 0.18 * (1 - e) * (1 - v * 0.3);
        return [x + sway * (1 - e) * (1 - v) * 0.25, y + fall + lag, fold];
      },
      { cols: 30, rows: 16, light: 1 },
    );
  },
  curtains(g) {
    const { q } = g;
    const e = easeInOut(clamp(q * 1.15));
    const aspect = g.gl.aspect;
    flat(g, g.B);
    for (const side of [-1, 1]) {
      g.gl.grid(
        g.A,
        (u, v) => {
          const [x, y] = flatOf(g)(u, v);
          // Distance from the parting line, 0 at the middle, 1 at the edge.
          const from = 1 - Math.abs(x) / aspect;
          const gather = 1 - e * 0.88 * (0.35 + 0.65 * from) * (1 - v * 0.25);
          const nx = side * aspect * (1 - (1 - Math.abs(x) / aspect) * gather);
          const fold = Math.sin(from * PI * 9) * 0.11 * e * (0.4 + from);
          const lift = e * e * (1 - v) * 0.15 * from;
          return [nx, y + lift, Math.abs(fold)];
        },
        {
          cols: 36,
          rows: 10,
          uv: side < 0 ? [0, 0, 0.5, 1] : [0.5, 0, 1, 1],
          alpha: 1 - clamp((q - 0.82) * 6),
        },
      );
    }
  },
  wind(g) {
    const { q, o } = g;
    // The slide streams off toward the side the wind blows to.
    const sign = o.invertX ? -1 : 1;
    const aspect = g.gl.aspect;
    flat(g, g.B);
    g.gl.grid(
      g.A,
      (u, v) => {
        const [x, y] = flatOf(g)(u, v);
        // The edge facing the wind's destination lets go first.
        const lead = sign > 0 ? u : 1 - u;
        const t = easeIn(local(q, (1 - lead) * 0.4 + v * 0.08, 0.6));
        const flutter =
          Math.sin(u * 8 + v * 3 - q * 20) * 0.1 * Math.sin(q * PI) * (0.3 + t);
        const p = [
          x + sign * t * aspect * 2.6,
          y + t * 0.5 * (0.6 - v) + Math.sin(u * 5 + q * 9) * 0.05 * t,
          flutter + t * 0.35,
        ];
        return rotateY(p, -sign * t * 0.6, x, 0);
      },
      { cols: 30, rows: 12, alpha: 1 - clamp((q - 0.85) * 6) },
    );
  },
  prestige(g) {
    const { q } = g;
    const e = easeInOut(q);
    const aspect = g.gl.aspect;
    flat(g, g.B);
    g.gl.grid(
      g.A,
      (u, v) => {
        const [x, y] = flatOf(g)(u, v);
        // Gathered toward a point above the top middle, the top first.
        const pull = clamp(e * 1.6 - v * 0.6);
        const nx = x * (1 - pull * 0.92);
        const ny =
          y + (1.2 - y) * pull * 0.35 + easeIn(clamp(q * 1.4 - 0.4)) * 2.6;
        const bow = Math.sin(u * PI) * pull * 0.5;
        return [nx, ny, bow + (1 - Math.abs(x) / aspect) * pull * 0.3];
      },
      { cols: 20, rows: 16, alpha: 1 - clamp((q - 0.75) * 4) },
    );
  },
  fracture(g) {
    const { q } = g;
    flat(g, g.B);
    const aspect = g.gl.aspect;
    const cols = 11,
      rows = 7;
    // A jittered grid split into triangles; each shard falls, spins and
    // drifts forward, those nearest the impact first.
    const point = (i, j) => {
      const edge = i === 0 || j === 0 || i === cols || j === rows;
      const jx =
        edge && (i === 0 || i === cols)
          ? 0
          : (g.random(j * 97 + i) - 0.5) * 0.7;
      const jy =
        edge && (j === 0 || j === rows)
          ? 0
          : (g.random(j * 89 + i + 5000) - 0.5) * 0.7;
      return [(i + jx) / cols, (j + jy) / rows];
    };
    const positions = [],
      uvs = [],
      shades = [];
    let n = 0;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++)
        for (const tri of [
          [point(i, j), point(i + 1, j), point(i, j + 1)],
          [point(i + 1, j), point(i + 1, j + 1), point(i, j + 1)],
        ]) {
          const cu = (tri[0][0] + tri[1][0] + tri[2][0]) / 3,
            cv = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
          const d = Math.hypot(cu - 0.5, (cv - 0.45) * 0.6);
          const t = easeIn(
            local(q, 0.1 + d * 0.5 + g.random(n + 3) * 0.12, 0.55),
          );
          const spinX = (g.random(n + 7) - 0.5) * 6 * t,
            spinY = (g.random(n + 11) - 0.5) * 6 * t;
          const center = flatOf(g)(cu, cv);
          const drop = [
            (cu - 0.5) * t * 1.2,
            -t * t * 3.2,
            t * (0.8 + g.random(n + 13) * 1.4),
          ];
          for (const [u, v] of tri) {
            let p = flatOf(g)(u, v);
            p = rotateX(p, spinX, center[1], 0);
            p = rotateY(p, spinY, center[0], 0);
            positions.push(p[0] + drop[0], p[1] + drop[1], p[2] + drop[2]);
            uvs.push(u, v);
            shades.push(1 - t * 0.4 * Math.abs(Math.sin(spinX + spinY)));
          }
          n += 17;
        }
    const crack = clamp(q * 8);
    g.gl.triangles(
      g.A,
      new Float32Array(positions),
      new Float32Array(uvs),
      new Float32Array(shades.map((s) => s * (1 - crack * 0.06))),
      { alpha: 1 - clamp((q - 0.85) * 7), depth: false },
    );
    void aspect;
  },
  crush(g) {
    const { q } = g;
    flat(g, g.B);
    const crumple = easeInOut(clamp(q * 1.6));
    const away = easeIn(clamp(q * 1.6 - 0.6));
    g.gl.grid(
      g.A,
      (u, v) => {
        const [x, y] = flatOf(g)(u, v);
        const nx =
          (g.random(Math.floor(u * 20) * 31 + Math.floor(v * 12)) - 0.5) * 0.5;
        const wobble =
          Math.sin(u * 23 + v * 17) * 0.5 + Math.sin(u * 11 - v * 29) * 0.5;
        const size = 1 - crumple * 0.82;
        return [
          x * size + nx * crumple * 0.3,
          y * size + wobble * crumple * 0.12 - away * 2.2,
          wobble * crumple * 0.35 - away * 1.5,
        ];
      },
      { cols: 26, rows: 16, alpha: 1 - clamp((q - 0.85) * 7) },
    );
  },
  peelOff(g) {
    const { q, o } = g;
    flat(g, g.B);
    const aspect = g.gl.aspect;
    const sign = o.invertX ? 1 : -1;
    // Peeled from a lower corner toward the opposite upper corner.
    const d0 = [-sign * aspect, 1];
    const n = Math.hypot(d0[0], d0[1]);
    const d = [d0[0] / n, d0[1] / n];
    const reach = Math.hypot(aspect, 1);
    const e = easeIn(clamp(q * 1.15));
    const line = reach - e * reach * 2.4;
    const lift = easeIn(clamp(q * 1.6 - 0.6));
    g.gl.grid(
      g.A,
      (u, v) => {
        // Measured from the starting corner along the peel direction.
        const p = curl(flatOf(g)(u, v), [-d[0], -d[1]], line, 0.35);
        return [p[0] - sign * lift * 2, p[1] + lift * 1.8, p[2] + lift * 2];
      },
      { cols: 30, rows: 18, tint: 0 },
    );
  },
  pageCurlSingle(g) {
    const { q, o } = g;
    flat(g, g.B);
    const aspect = g.gl.aspect;
    const sign = o.invertX ? 1 : -1;
    // The page curls in from the trailing edge, slightly askew, and rolls off.
    const tilt = 0.18;
    const d = [-sign * Math.cos(tilt), Math.sin(tilt)];
    const e = easeInOut(q);
    const line = aspect * 1.2 - e * aspect * 3.4;
    g.gl.grid(g.A, (u, v) => curl(flatOf(g)(u, v), [-d[0], -d[1]], line, 0.3), {
      cols: 36,
      rows: 18,
    });
  },
  pageCurlDouble(g) {
    const { q, o } = g;
    const aspect = g.gl.aspect;
    // Two facing pages: one turns over the spine like a book page; its back
    // carries the arriving slide's other half.
    const left = !o.invertX; // turn toward the left
    const e = easeInOut(q);
    const angle = e * PI;
    const turnUv = left ? [0.5, 0, 1, 1] : [0, 0, 0.5, 1];
    const stayA = left ? [0, 0, 0.5, 1] : [0.5, 0, 1, 1];
    flat(g, g.A, { uv: stayA, cols: 1, rows: 1 });
    flat(g, g.B, { uv: turnUv, cols: 1, rows: 1 });
    const place = (u, v) => {
      const [x, y] = flatOf(g)(u, v);
      const r = Math.abs(x) / aspect; // 0 at the spine, 1 at the outer edge
      // A slight bend lags the outer edge behind the spine.
      const a = clamp(angle - Math.sin(angle) * r * 0.35, 0, PI);
      const s = left ? 1 : -1;
      return [s * Math.cos(a) * r * aspect, y, Math.sin(a) * r * aspect * 0.9];
    };
    g.gl.grid(g.A, place, { uv: turnUv, cols: 24, rows: 6, cull: "back" });
    g.gl.grid(g.B, place, {
      uv: turnUv,
      cols: 24,
      rows: 6,
      cull: "front",
      mapUv: (u, v) => [1 - u, v],
    });
  },
  airplane(g) {
    const { q, o } = g;
    const aspect = g.gl.aspect;
    const sign = o.invertX ? -1 : 1;
    flat(g, g.B);
    const fold = easeInOut(clamp(q * 2.2));
    const fly = easeIn(clamp(q * 1.6 - 0.55));
    g.gl.grid(
      g.A,
      (u, v) => {
        let [x, y, z] = flatOf(g)(u, v);
        // Fold the wings up about the middle, narrowing to a dart.
        const nose = 1 - v;
        x *= 1 - fold * 0.75 * (0.4 + nose * 0.6);
        const wing = Math.abs(x);
        z = -wing * Math.sin(fold * 1.1);
        x = Math.sign(x) * wing * Math.cos(fold * 1.1);
        y = y * (1 - fold * 0.35);
        let p = rotateX([x, y, z], -fold * 0.9, 0, 0);
        p = rotateZ(p, -sign * fold * 1.2);
        return [
          p[0] + sign * fly * aspect * 3.5,
          p[1] + fly * 2.2 - fly * fly * 0.5,
          p[2] - fly * 2,
        ];
      },
      { cols: 20, rows: 14, alpha: 1 - clamp((q - 0.9) * 10) },
    );
  },
  origami(g) {
    const { q, o } = g;
    const aspect = g.gl.aspect;
    const sign = o.invertX ? -1 : 1;
    flat(g, g.B);
    const f1 = easeInOut(clamp(q * 3));
    const f2 = easeInOut(clamp(q * 3 - 1));
    const fly = easeIn(clamp(q * 1.7 - 0.7));
    g.gl.grid(
      g.A,
      (u, v) => {
        let [x, y, z] = flatOf(g)(u, v);
        // First fold top to bottom, then side to side, then flap and fly.
        if (y > 0) [, y, z] = rotateX([x, y, z], -f1 * PI * 0.95, 0, 0);
        if (x > 0) [x, , z] = rotateY([x, y, z], f2 * PI * 0.9, 0, 0);
        const flap = Math.sin(q * 30) * 0.4 * fly;
        if (x < 0) [, y, z] = rotateX([x, y, z], flap, 0, 0);
        let p = [x * (1 - f2 * 0.3), y, z];
        p = rotateZ(p, sign * f2 * 0.6);
        return [
          p[0] + sign * fly * aspect * 3.2,
          p[1] + fly * 2.4,
          p[2] - fly * 1.5,
        ];
      },
      { cols: 18, rows: 12, alpha: 1 - clamp((q - 0.9) * 10) },
    );
  },
  checker(g) {
    const { q, o } = g;
    const cols = 10,
      rows = Math.max(4, Math.round(cols / g.gl.aspect + 0.4));
    const across = o.direction !== "vert";
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const at = across ? i / cols : j / rows;
        const t = easeInOut(local(q, at * 0.55 + ((i + j) % 2) * 0.12, 0.33));
        tile(g, i, j, cols, rows, t * PI, across);
      }
  },
  blinds(g) {
    const { q, o } = g;
    const vertical = o.direction === "vert";
    const n = 12;
    for (let k = 0; k < n; k++) {
      const t = easeInOut(local(q, (k / n) * 0.5, 0.5));
      if (vertical) tile(g, k, 0, n, 1, t * PI, true);
      else tile(g, 0, k, 1, n, t * PI, false);
    }
  },
  switch(g) {
    const { q, o } = g;
    const e = easeInOut(q);
    const sign = o.direction === "l" ? -1 : 1;
    const aspect = g.gl.aspect;
    // A slips to one side and behind as B comes forward from the other.
    const arc = Math.sin(e * PI);
    const place = (image, side, out, back) =>
      g.gl.grid(
        image,
        (u, v) => {
          let p = flatOf(g)(u, v);
          p = rotateY(p, side * arc * 0.5, 0, 0);
          return translate(p, side * arc * aspect * 1.1, 0, -arc * 1.6 - back);
        },
        { cols: 6, rows: 4, depth: true, alpha: out },
      );
    if (q < 0.5) {
      place(g.B, -sign, 1, 0.6 * (1 - e));
      place(g.A, sign, 1, 0);
    } else {
      place(g.A, sign, 1, 0.6 * e);
      place(g.B, -sign, 1, 0);
    }
  },
  flip(g) {
    const { q, o } = g;
    const e = easeInOut(q);
    const sign = o.direction === "l" ? -1 : 1;
    const place = (u, v) =>
      translate(
        rotateY(flatOf(g)(u, v), sign * e * PI),
        0,
        0,
        -Math.sin(e * PI) * 1.4,
      );
    g.gl.grid(g.A, place, { cols: 8, rows: 4, cull: "back" });
    g.gl.grid(g.B, place, {
      cols: 8,
      rows: 4,
      cull: "front",
      mapUv: (u, v) => [1 - u, v],
    });
  },
  gallery(g) {
    const { q, o } = g;
    const e = easeInOut(q);
    const sign = o.direction === "r" ? 1 : -1;
    const aspect = g.gl.aspect;
    const pose = (image, t) =>
      g.gl.grid(
        image,
        (u, v) => {
          let p = flatOf(g)(u, v);
          p = rotateY(p, -t * 0.85, 0, 0);
          return translate(p, t * aspect * 2.3, 0, -Math.abs(t) * 1.6);
        },
        { cols: 8, rows: 4, depth: true },
      );
    pose(g.A, sign * e);
    pose(g.B, -sign * (1 - e));
  },
  prism(g) {
    const { o } = g;
    if (o.isContent) {
      const [a, b] = parts(g);
      slab(g, a, b, !!o.isInverted);
    } else slab(g, g.A, g.B, !!o.isInverted);
  },
  doors(g) {
    const { q, o } = g;
    const e = easeInOut(q);
    const aspect = g.gl.aspect;
    const vertical = o.direction !== "horz";
    // B comes forward from behind as the two halves of A swing open.
    const s = 0.6 + 0.4 * e;
    g.gl.grid(
      g.B,
      (u, v) =>
        translate(
          flatOf(g)(u, v).map((c, i) => (i < 2 ? c * s : c)),
          0,
          0,
          -(1 - e) * 1.5,
        ),
      {
        cols: 1,
        rows: 1,
      },
    );
    for (const side of [0, 1]) {
      g.gl.grid(
        g.A,
        (u, v) => {
          const p = flatOf(g)(u, v);
          const angle = (side ? -1 : 1) * e * PI * 0.55;
          return vertical
            ? rotateY(p, angle, (side ? 1 : -1) * aspect, 0)
            : rotateX(p, -angle, side ? -1 : 1, 0);
        },
        {
          cols: 4,
          rows: 4,
          uv: vertical
            ? side
              ? [0.5, 0, 1, 1]
              : [0, 0, 0.5, 1]
            : side
              ? [0, 0.5, 1, 1]
              : [0, 0, 1, 0.5],
          alpha: 1 - clamp((q - 0.8) * 5),
        },
      );
    }
  },
  window(g) {
    const { q, o } = g;
    const e = easeInOut(q);
    const aspect = g.gl.aspect;
    const vertical = o.direction !== "horz";
    const [a, b] = parts(g);
    const s = 0.55 + 0.45 * e;
    g.gl.grid(
      b,
      (u, v) => {
        const [x, y] = flatOf(g)(u, v);
        return [x * s, y * s, -(1 - e) * 2];
      },
      { cols: 1, rows: 1, alpha: smooth(clamp(q * 1.5)) },
    );
    for (const side of [0, 1]) {
      const sign = side ? 1 : -1;
      g.gl.grid(
        a,
        (u, v) => {
          const p = flatOf(g)(u, v);
          const angle = -sign * e * PI * 0.45;
          const q2 = vertical
            ? rotateY(p, angle, sign * aspect, 0)
            : rotateX(p, angle, -sign, 0);
          return vertical
            ? translate(q2, sign * e * aspect * 0.9, 0, e * 0.6)
            : translate(q2, 0, -sign * e * 0.9, e * 0.6);
        },
        {
          cols: 4,
          rows: 4,
          uv: vertical
            ? side
              ? [0.5, 0, 1, 1]
              : [0, 0, 0.5, 1]
            : side
              ? [0, 0.5, 1, 1]
              : [0, 0, 1, 0.5],
          alpha: 1 - clamp((q - 0.6) * 2.5),
        },
      );
    }
  },
  conveyor(g) {
    const { q, o } = g;
    const e = easeInOut(q);
    const sign = o.direction === "r" ? 1 : -1;
    const aspect = g.gl.aspect;
    const [a, b] = parts(g);
    const pose = (image, t, alpha) =>
      g.gl.grid(
        image,
        (u, v) => {
          let p = flatOf(g)(u, v);
          p = rotateY(p, -t * 0.6, 0, 0);
          const depth = Math.min(1, Math.abs(t) * 3) * 1.4;
          return translate(p, t * aspect * 2.6, 0, -depth);
        },
        { cols: 8, rows: 4, depth: true, alpha },
      );
    pose(a, sign * e, 1);
    pose(b, -sign * (1 - e), 1);
  },
  ripple(g) {
    const { q, o } = g;
    const aspect = g.gl.aspect;
    const origin = {
      center: [0, 0],
      lu: [-aspect, 1],
      ru: [aspect, 1],
      ld: [-aspect, -1],
      rd: [aspect, -1],
    }[o.direction] || [0, 0];
    const amplitude = 0.07 * Math.sin(q * PI);
    const place = (u, v) => {
      const [x, y] = flatOf(g)(u, v);
      const d = Math.hypot(x - origin[0], y - origin[1]);
      const z = Math.sin(d * 9 - q * 26) * amplitude * Math.exp(-d * 0.35);
      return [x, y, z];
    };
    const options = { cols: 64, rows: 36 };
    g.gl.grid(g.A, place, options);
    g.gl.grid(g.B, place, { ...options, alpha: smooth(clamp(q * 1.3 - 0.15)) });
  },
};

// One tile of a turning grid: front shows A, and once past edge-on, B.
function tile(g, i, j, cols, rows, angle, aboutVertical) {
  const uv = [i / cols, j / rows, (i + 1) / cols, (j + 1) / rows];
  const cx = ((i + 0.5) / cols) * 2 - 1,
    cy = 1 - ((j + 0.5) / rows) * 2;
  const aspect = g.gl.aspect;
  const back = angle > PI / 2;
  const a = back ? angle - PI : angle;
  const pop = Math.sin(angle) * 0.25;
  g.gl.grid(
    back ? g.B : g.A,
    (u, v) => {
      const p = flatOf(g)(u, v);
      const r = aboutVertical
        ? rotateY(p, a, cx * aspect, 0)
        : rotateX(p, -a, cy, 0);
      return [r[0], r[1], r[2] + pop];
    },
    { cols: 1, rows: 1, uv, depth: false },
  );
}

/** Effects this module draws. */
export const GL_EFFECTS = new Set(Object.keys(EFFECTS_GL));
