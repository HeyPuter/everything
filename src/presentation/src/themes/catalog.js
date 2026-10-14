// The built-in themes. Each has a heading and body font, an effect scheme,
// title and body text styles, artwork for the master and its layouts (drawn
// from theme colors, so it follows every color change), and four variants:
// color schemes, light or dark, with their own background.
//
// A variant's colors are twelve hex values in scheme order: dark 1, light 1,
// dark 2, light 2, accents 1-6, hyperlink, followed hyperlink. A dark
// variant paints its background in dark 1 and its text in light 1.
import {
  ellipse,
  hrule,
  levelStyle,
  plainLevels,
  poly,
  rect,
  vrule,
} from "./design.js";
import { schemeFrom } from "./theme-xml.js";

const v = (name, colors, more = {}) => ({
  name,
  colors: schemeFrom(colors),
  ...more,
});

// Placeholder changes shared by several designs.
const titleSlideLeft = (g, box, sub, size = 5400, subColor = "tx2") => [
  {
    type: "ctrTitle",
    box: g.box(...box),
    anchor: "b",
    lstStyle: levelStyle("l", size),
  },
  {
    type: "subTitle",
    box: g.box(...sub),
    anchor: "t",
    lstStyle: plainLevels("l", [2000, 1800, 1600, 1400, 1400], subColor),
  },
];
const titleSlideCentered = (g, box, sub, size = 5400, subColor) => [
  {
    type: "ctrTitle",
    box: g.box(...box),
    anchor: "b",
    lstStyle: levelStyle("ctr", size),
  },
  {
    type: "subTitle",
    box: g.box(...sub),
    anchor: "t",
    lstStyle: plainLevels("ctr", [2000, 1800, 1600, 1400, 1400], subColor),
  },
];
const sectionAt = (g, title, body, size = 4800, algn = "l", bodyColor) => [
  {
    type: "title",
    box: g.box(...title),
    anchor: "b",
    lstStyle: levelStyle(algn, size),
  },
  {
    type: "body",
    box: g.box(...body),
    anchor: "t",
    lstStyle: plainLevels(algn, [2000, 1800, 1600, 1400, 1400], bodyColor),
  },
];
// A circle `d` wide (fraction of the slide width) at x, y.
const circle = (g, x, y, d, fill, more) =>
  ellipse(x, y, d, d * g.aspect, fill, more);

const legacy = (id, name, variants) => ({
  id,
  name,
  legacy: true,
  fonts: ["Arial", "Arial"],
  effects: "flat",
  title: { size: 4400, bold: true },
  body: { bullet: "•", color: "tx2" },
  variants,
});

export const CATALOG = [
  {
    id: "paper",
    name: "Paper",
    fonts: ["Arial", "Arial"],
    effects: "soft",
    title: { size: 4400 },
    body: { bullet: "•" },
    variants: [
      v("Paper", "#000000 #ffffff #44546a #e7e6e6 #4472c4 #ed7d31 #a5a5a5 #ffc000 #5b9bd5 #70ad47 #0563c1 #954f72"),
      v("Paper Warm", "#2b2622 #fffdf8 #5c5248 #efe9df #b0573a #d9a441 #6b8e6b #7d6ba6 #3f7f9c #c76f8f #8f3d24 #6d4f7b"),
      v("Paper Cool", "#1c2833 #f8fafc #4a5d70 #e3e9ef #2f6fb0 #2ea39b #e2a03f #c8504e #6c63b5 #7a8a99 #2f6fb0 #6c63b5"),
      v("Paper Ink", "#1e1f22 #f2f2f2 #34363b #b7bac0 #6ea8fe #f6c35c #7dd3a8 #f08d7e #c3a6f7 #8fc9e8 #8ab8ff #c9b0f5", { dark: true }),
    ],
  },
  legacy("studio", "Studio", [
    v("Studio", "#202420 #f5f3ee #62685e #dce5da #315c48 #c9873b #6d8f7a #a8553d #4f6f8f #8a7f4e #2f6f8f #6d5a7e"),
    v("Studio Sand", "#2a241c #f7f1e6 #6e6252 #eadfcb #8a6a2f #3f6b5a #b5653f #5e6f8f #a08a4e #7a5a6e #6b5222 #5a4a6a"),
    v("Studio Fern", "#1b2a22 #f1f6f1 #55665b #d5e6d8 #2f7a52 #d9a03a #4a8fa8 #b8573f #7a6aa8 #8a9a4e #2f7a52 #6a5a98"),
    v("Studio Night", "#1a1f1b #eef2ec #2d352f #b4c0b4 #8fc7a4 #e8b866 #8ab8d0 #e39a86 #b6a8dc #c8c48a #9fd4e8 #c6b8ec", { dark: true }),
  ]),
  legacy("cobalt", "Cobalt", [
    v("Cobalt", "#15284b #f0f4fc #506581 #dbe5fa #245ce0 #f0a530 #16a3a3 #7a4fd6 #e2574c #5f7a99 #245ce0 #7a4fd6"),
    v("Cobalt Sky", "#122a44 #f2f8fd #4f6b86 #d9eaf7 #1f7ac2 #ef8a3a #2aa876 #8f5ad0 #d84c6a #6b8299 #1f7ac2 #8f5ad0"),
    v("Cobalt Ice", "#1b2533 #f7f9fc #5a6878 #e4e9f0 #3b66b5 #19a5b8 #e0b23c #b5476b #6f58c9 #7d8a99 #3b66b5 #6f58c9"),
    v("Cobalt Deep", "#0e1a33 #eef3fc #1d2f55 #a9bde6 #6f9bff #ffc04d #4fd1c5 #b49aff #ff8a7a #9db4d6 #8fb2ff #c2adff", { dark: true }),
  ]),
  legacy("clay", "Clay", [
    v("Clay", "#44251f #fcf1eb #76594e #efd8cc #ad4930 #d99a3e #6e8b5d #8c5a7a #4f7a8a #b8735c #8c3a26 #6e4a5e"),
    v("Clay Terracotta", "#3d1f18 #fbeee6 #7a5144 #f0d3c4 #c0532f #e0a24a #5f8a6e #7c5c8f #42788f #a3664f #9a3f22 #6a4c7c"),
    v("Clay Blush", "#3f2526 #fdf3f2 #7a5a5c #f3dcdc #b04a5a #d98e4a #6f8f7a #6a64a8 #4a8296 #b07a5a #933848 #5a548f"),
    v("Clay Kiln", "#2a1915 #f8ece6 #44291f #d9b8aa #e58a62 #f2c46d #9cc49a #c79ac0 #86b8c8 #e0a78c #f0a481 #d4b0cc", { dark: true }),
  ]),
  legacy("midnight", "Midnight", [
    v("Midnight", "#18222b #f1f5ee #2c3b45 #bcc8ca #b9d8a0 #f2c879 #7fc4d8 #e89a8c #b6a6e0 #8fb3a3 #8fd0e8 #c9b6f0", { dark: true }),
    v("Midnight Teal", "#10232a #eef7f6 #1f3a42 #b2cfcf #6fd3c2 #f5b971 #8fb8f0 #f28f9c #c4a8f0 #a8c890 #8ee0f0 #d0b8f5", { dark: true }),
    v("Midnight Plum", "#1f1729 #f5f0f8 #33264a #c8bcd6 #d29bf0 #f5c46b #7fd1c8 #f2919a #9cb8f0 #c8c08a #b8a0ff #e0b0f0", { dark: true }),
    v("Midnight Dawn", "#22303a #f6f7f3 #4d5d68 #dfe5e3 #3c7a5f #c9873b #4f7fa3 #b5574a #7a63a8 #8a8a4e #3a6f9a #6e5a90"),
  ]),
  {
    id: "meridian",
    name: "Meridian",
    fonts: ["Trebuchet MS", "Trebuchet MS"],
    effects: "soft",
    title: { size: 4000 },
    body: { bullet: "▪", bulletColor: "accent1" },
    art: ({ g }) => ({
      master: [rect(0.04, 0.09, 0.006, 0.16, "accent1")],
      layouts: {
        title: {
          hideMaster: true,
          shapes: [
            rect(0.72, 0, 0.28, 1, "accent1"),
            rect(0.72, 0, 0.012, 1, "accent2"),
          ],
          placeholders: titleSlideLeft(g, [0.08, 0.16, 0.58, 0.42], [0.08, 0.62, 0.58, 0.2]),
        },
        secHead: {
          hideMaster: true,
          background: "accent1",
          colorMap: "dark",
          shapes: [hrule(0.08, 0.7, 0.18, "accent2", 3)],
          placeholders: sectionAt(g, [0.08, 0.2, 0.84, 0.46], [0.08, 0.74, 0.84, 0.16]),
        },
      },
    }),
    variants: [
      v("Meridian", "#1f2a36 #ffffff #44546a #e9eef3 #1f5f7a #f2a541 #4aa37d #c8553d #6c5b9e #2e4057 #1f6f8b #6c5b9e"),
      v("Meridian Dusk", "#2b2330 #fbf8f5 #5d4e60 #efe7ea #6a3d6e #e8a13a #3f8f8a #c45a4a #4a6fa5 #8c7a5b #6a3d6e #4a6fa5"),
      v("Meridian Coast", "#14303a #f6fbfb #3d6370 #dcecee #0f6b75 #f07b4f #e6b43c #5b7fbf #8a5ba8 #4c9a6a #0f6b75 #8a5ba8"),
      v("Meridian Night", "#121b24 #f0f4f8 #1f2c39 #a9b8c6 #3f8fb0 #f2a541 #5fbf8f #e2735c #9a8ad0 #7aa0c0 #6fc0e0 #b8a8f0", { dark: true }),
    ],
  },
  {
    id: "atlas",
    name: "Atlas",
    fonts: ["Raleway", "Raleway"],
    fontName: "Raleway",
    effects: "flat",
    title: { size: 3600, bold: true, caps: true, spacing: 150 },
    body: { bullet: "—", bulletColor: "accent1" },
    art: ({ g }) => ({
      master: [rect(0, 0, 1, 0.03, "accent1"), rect(0, 0.03, 1, 0.006, "accent2")],
      layouts: {
        title: {
          hideMaster: true,
          background: "accent1",
          colorMap: "dark",
          shapes: [hrule(0.42, 0.56, 0.16, "tx1", 2)],
          placeholders: titleSlideCentered(g, [0.1, 0.16, 0.8, 0.37], [0.1, 0.6, 0.8, 0.18], 4800),
        },
        secHead: {
          shapes: [rect(0.07, 0.3, 0.01, 0.36, "accent2")],
          placeholders: sectionAt(g, [0.1, 0.26, 0.8, 0.4], [0.1, 0.68, 0.8, 0.2], 4400),
        },
      },
    }),
    variants: [
      v("Atlas", "#1d2433 #ffffff #4b5468 #edf0f5 #2d4a8a #e0a43a #3f9e8f #c2504f #7a5ea8 #5a7389 #2d4a8a #7a5ea8"),
      v("Atlas Rust", "#2a201c #fffcf9 #6a574d #f3ebe4 #8a3b22 #d9a441 #46807a #5b6aa8 #a8576e #8f8a5a #8a3b22 #5b6aa8"),
      v("Atlas Pine", "#17271f #fbfdfb #4c6155 #e6efe9 #1f5c45 #e3a23b #3e7fae #b5543f #8a6aa0 #6f8f5a #1f5c45 #8a6aa0"),
      v("Atlas Graphite", "#15171c #eceef2 #23262e #a9afbb #5f86d6 #f0b44a #4fc0ad #e07a6a #ab92e0 #8aa0b8 #86a8ef #c2aef0", { dark: true }),
    ],
  },
  {
    id: "gallery",
    name: "Gallery",
    fonts: ["Playfair Display", "Georgia"],
    effects: "flat",
    title: { size: 4400 },
    body: { bullet: "·", bulletColor: "accent1", bulletFont: "Georgia" },
    art: ({ g }) => ({
      master: [
        hrule(0.06875, 0.04, 0.8625, "tx1", 0.75),
        hrule(0.06875, 0.048, 0.8625, "tx1", 0.75),
        hrule(0.06875, 0.915, 0.8625, "tx2/alpha=60000", 0.5),
      ],
      layouts: {
        title: {
          hideMaster: true,
          shapes: [
            rect(0.04, 0.06, 0.92, 0.88, null, { line: { color: "accent1", width: 1 } }),
            rect(0.05, 0.078, 0.9, 0.844, null, { line: { color: "accent1/alpha=50000", width: 0.5 } }),
            hrule(0.45, 0.555, 0.1, "accent1", 1.5),
          ],
          placeholders: titleSlideCentered(g, [0.12, 0.17, 0.76, 0.36], [0.12, 0.6, 0.76, 0.18], 5400, "tx2"),
        },
        secHead: {
          shapes: [hrule(0.07, 0.69, 0.08, "accent1", 1.5)],
        },
      },
    }),
    variants: [
      v("Gallery", "#262321 #fbf8f2 #6b625a #efe8dc #8c3b2e #b38a3e #4f6e5a #3e5a7a #7a4f6e #8a7a5a #8c3b2e #4f5a7a"),
      v("Gallery Linen", "#2c2a27 #f8f6f1 #6e6a63 #e9e4da #4a5a73 #a8763e #6e7f55 #8f4b4b #6a5d85 #8a8576 #4a5a73 #6a5d85"),
      v("Gallery Rose", "#2f2427 #fcf6f5 #73595f #f3e3e2 #9b4a5d #c08a4b #577a6a #4d628a #8a6fa0 #a08a7a #9b4a5d #4d628a"),
      v("Gallery Noir", "#141414 #f3efe7 #262422 #bdb5a8 #d4b170 #c97b63 #8fb59a #8aa6c8 #b99ac6 #d9cbb0 #e0c48a #c9aed4", { dark: true }),
    ],
  },
  {
    id: "signal",
    name: "Signal",
    fonts: ["Trebuchet MS", "Arial"],
    effects: "lifted",
    title: { size: 4000, bold: true },
    body: { bullet: "›", bulletColor: "accent1", bulletFont: "Arial" },
    art: ({ g }) => ({
      master: [
        poly([[0.45, 0], [1, 0], [0.55, 1], [0, 1]], "accent1", [0.88, 0.8, 0.12, 0.2]),
        poly([[0.45, 0], [1, 0], [0.55, 1], [0, 1]], "accent2", [0.845, 0.8, 0.05, 0.2]),
      ],
      layouts: {
        title: {
          hideMaster: true,
          shapes: [
            poly([[0.4, 0], [1, 0], [0.6, 1], [0, 1]], "accent1", [0.6, 0, 0.4, 1]),
            poly([[0.4, 0], [1, 0], [0.6, 1], [0, 1]], "accent2", [0.53, 0, 0.12, 1]),
            poly([[0.4, 0], [1, 0], [0.6, 1], [0, 1]], "accent1/alpha=40000", [0.49, 0, 0.06, 1]),
          ],
          placeholders: titleSlideLeft(g, [0.07, 0.18, 0.52, 0.42], [0.07, 0.63, 0.48, 0.2], 5400),
        },
        secHead: {
          hideMaster: true,
          shapes: [
            poly([[0.4, 0], [1, 0], [0.6, 1], [0, 1]], "accent1", [0.78, 0, 0.22, 1]),
          ],
          placeholders: sectionAt(g, [0.07, 0.22, 0.66, 0.44], [0.07, 0.69, 0.66, 0.2]),
        },
      },
    }),
    variants: [
      v("Signal", "#101418 #f4f6f8 #1c232b #a9b4bf #ff6a3d #ffc93c #3ec1d3 #9b7bea #6be38c #ff8fb1 #5fd3ff #b9a2ff", { dark: true }),
      v("Signal Lime", "#121512 #f2f5ef #1f251f #b0bba9 #b6e33d #ff7a45 #3fc6c6 #c58cf0 #f4d03f #7aa7ff #8fe0ff #d0a8ff", { dark: true }),
      v("Signal Day", "#161b22 #ffffff #4a5562 #edf1f5 #e8492a #f2a900 #1a9bb0 #6e4fd0 #2e9e5b #d6457d #1a7bc0 #6e4fd0"),
      v("Signal Violet", "#15111f #f4f1fa #241d33 #b8aed0 #a274ff #ff6fa0 #39d0c0 #ffc04d #6fa8ff #8ae07a #9dc0ff #d4b4ff", { dark: true }),
    ],
  },
  {
    id: "lagoon",
    name: "Lagoon",
    fonts: ["Tahoma", "Verdana"],
    effects: "soft",
    title: { size: 4000 },
    body: { bullet: "•", bulletColor: "accent1", sizes: [2200, 2000, 1800, 1600, 1600] },
    art: ({ g }) => {
      const wave = (fill, box, lift = 0) => ({
        x: box[0],
        y: box[1],
        w: box[2],
        h: box[3],
        fill,
        path: [
          ["M", 0, 0.5 - lift],
          ["C", 0.22, 0.05, 0.48, 0.95, 0.74, 0.42],
          ["C", 0.86, 0.18, 0.95, 0.22, 1, 0.3],
          ["L", 1, 1],
          ["L", 0, 1],
          ["Z"],
        ],
      });
      return {
        background: { grad: [[0, "bg1"], [1, "bg2"]], angle: 90 },
        master: [
          wave("accent1/alpha=30000", [0, 0.86, 1, 0.14]),
          wave("accent2/alpha=25000", [0, 0.9, 1, 0.1], 0.2),
        ],
        layouts: {
          title: {
            hideMaster: true,
            shapes: [
              wave("accent1/alpha=45000", [0, 0.62, 1, 0.38]),
              wave("accent2/alpha=35000", [0, 0.72, 1, 0.28], 0.15),
              wave("accent1/alpha=60000", [0, 0.84, 1, 0.16], 0.1),
            ],
            placeholders: titleSlideCentered(g, [0.1, 0.12, 0.8, 0.34], [0.1, 0.48, 0.8, 0.14], 5000, "tx2"),
          },
        },
      };
    },
    variants: [
      v("Lagoon", "#16323a #f6fbfb #3c6670 #d7eef0 #138a96 #41b3a3 #f2a65a #5b7fc7 #e06c75 #8e7cc3 #138a96 #5b7fc7"),
      v("Lagoon Reef", "#1d2b38 #f7fbfd #4a6478 #d9ecf6 #1c74b8 #26b5a6 #ff8c69 #f2c14e #8f6ed5 #63a35c #1c74b8 #8f6ed5"),
      v("Lagoon Mint", "#1a2e29 #f6fcf9 #4a6b60 #d6f0e5 #1f8a63 #5bb5a2 #e8a54a #4a86c7 #c75f7a #8a8f4e #1f8a63 #4a86c7"),
      v("Lagoon Deep", "#0b1f27 #eaf6f7 #133542 #9fc7cf #39c3c6 #7fe0c3 #ffb27a #8fb0ff #ff8f9a #c0a8ff #7fe0ff #c8b8ff", { dark: true }),
    ],
  },
  {
    id: "orbit",
    name: "Orbit",
    fonts: ["Tahoma", "Tahoma"],
    effects: "glow",
    title: { size: 4000 },
    body: { bullet: "●", bulletColor: "accent1", subBullet: "○" },
    art: ({ g }) => ({
      master: [
        circle(g, 0.885, -0.11, 0.17, "accent1/alpha=22000"),
        circle(g, 0.855, -0.16, 0.24, null, { line: { color: "accent2/alpha=70000", width: 1.25 } }),
      ],
      layouts: {
        title: {
          hideMaster: true,
          shapes: [
            circle(g, 0.6, 0.06, 0.48, "accent1"),
            circle(g, 0.56, 0.0, 0.56, null, { line: { color: "accent2", width: 1.5 } }),
            circle(g, 0.88, 0.62, 0.07, "accent2"),
          ],
          placeholders: titleSlideLeft(g, [0.07, 0.2, 0.5, 0.38], [0.07, 0.62, 0.48, 0.2], 5000),
        },
        secHead: {
          shapes: [circle(g, 0.78, 0.18, 0.3, "accent1/alpha=20000")],
        },
      },
    }),
    variants: [
      v("Orbit", "#1b1f3a #ffffff #4c5378 #eceefa #4b4fd1 #00a6a6 #ff8a3d #e0457b #6fbf4e #8a8fb5 #4b4fd1 #e0457b"),
      v("Orbit Sunset", "#2d1b2e #fff9f6 #6e5470 #f7e8e6 #d9485f #f29e4c #4a8fc7 #7b5ea8 #3fa58f #c0a050 #d9485f #7b5ea8"),
      v("Orbit Space", "#0d1024 #eef0ff #191d3d #a8acd6 #7c80ff #3fe0d0 #ffb259 #ff6fa5 #9ae66e #b0b6e8 #9da0ff #ff9ac5", { dark: true }),
      v("Orbit Moss", "#1d2a1f #fafcf7 #4f6352 #e8efe3 #4f8a3a #c9a227 #3a7fa8 #b5573f #7f5aa0 #6a8f8a #4f8a3a #7f5aa0"),
    ],
  },
  {
    id: "ledger",
    name: "Ledger",
    fonts: ["Georgia", "Arial"],
    effects: "flat",
    title: { size: 4000 },
    body: { bullet: "■", bulletColor: "accent1", sizes: [2200, 2000, 1800, 1600, 1600] },
    art: ({ g }) => ({
      master: [vrule(0.042, 0.08, 0.84, "accent1", 1.5)],
      layouts: {
        title: {
          hideMaster: true,
          shapes: [rect(0, 0, 0.36, 1, "accent1"), rect(0.36, 0, 0.008, 1, "accent2")],
          placeholders: titleSlideLeft(g, [0.42, 0.18, 0.52, 0.4], [0.42, 0.62, 0.52, 0.2], 4800),
        },
        secHead: {
          hideMaster: true,
          shapes: [rect(0, 0, 0.36, 1, "bg2"), rect(0.36, 0, 0.008, 1, "accent1")],
          placeholders: sectionAt(g, [0.42, 0.22, 0.52, 0.44], [0.42, 0.69, 0.52, 0.2], 4400),
        },
      },
    }),
    variants: [
      v("Ledger", "#1e2224 #ffffff #4f5a60 #eef1f2 #23463f #b8862b #4d7aa0 #a8483c #6e5a8f #7f8c6a #23463f #6e5a8f"),
      v("Ledger Navy", "#1a2030 #fdfdfc #4b566e #e9edf3 #1f3864 #c08b2c #3f8a7a #a3445a #6a5aa0 #8a8f99 #1f3864 #6a5aa0"),
      v("Ledger Burgundy", "#2a1d20 #fffdfb #6b5257 #f2e9e6 #6e1f2f #b88a3a #4a7a6a #3f5f8f #7a5a8a #8f7f6a #6e1f2f #3f5f8f"),
      v("Ledger Carbon", "#16191b #ebedee #262b2e #aab2b7 #6fb3a4 #e0b65c #7fa6d6 #e08a7a #b4a0d8 #b8c08a #8fc8f0 #c8b4f0", { dark: true }),
    ],
  },
  {
    id: "kite",
    name: "Kite",
    fonts: ["Trebuchet MS", "Georgia"],
    effects: "soft",
    title: { size: 4000, bold: true },
    body: { bullet: "◆", bulletColor: "accent2", sizes: [2200, 2000, 1800, 1600, 1600] },
    art: ({ g }) => ({
      master: [
        { x: 0.9, y: 0, w: 0.1, h: 0.17, preset: "rtTriangle", flipH: true, flipV: true, fill: "accent1" },
        { x: 0.94, y: 0, w: 0.06, h: 0.1, preset: "rtTriangle", flipH: true, flipV: true, fill: "accent2" },
        { x: 0, y: 0.88, w: 0.05, h: 0.12, preset: "rtTriangle", fill: "accent3/alpha=80000" },
      ],
      layouts: {
        title: {
          hideMaster: true,
          shapes: [
            { x: 0.62, y: 0, w: 0.38, h: 0.62, preset: "rtTriangle", flipH: true, flipV: true, fill: "accent1" },
            { x: 0.78, y: 0, w: 0.22, h: 0.36, preset: "rtTriangle", flipH: true, flipV: true, fill: "accent2" },
            { x: 0, y: 0.7, w: 0.18, h: 0.3, preset: "rtTriangle", fill: "accent3" },
          ],
          placeholders: titleSlideLeft(g, [0.08, 0.26, 0.6, 0.34], [0.08, 0.63, 0.56, 0.16], 5000),
        },
      },
    }),
    variants: [
      v("Kite", "#232323 #ffffff #555555 #f0f0ef #e4572e #29335c #f3a712 #669bbc #a8c686 #8c5383 #29335c #8c5383"),
      v("Kite Harbor", "#1c2533 #fbfcfd #4e5d73 #e7ecf2 #2a6f97 #f28f3b #c8553d #5c946e #f6c453 #6a4c93 #2a6f97 #6a4c93"),
      v("Kite Candy", "#2a2230 #fffafc #6a5a70 #f6eaf1 #e05297 #3bb4c1 #f9a03f #7d5ba6 #8bc34a #3f51b5 #3f51b5 #7d5ba6"),
      v("Kite Dusk", "#1a1a24 #f2f0f5 #2a2a3a #b6b3c4 #ff7b54 #ffd56b #7fb8ff #b7e07a #e98aff #8ad9d2 #9cc6ff #e0a8ff", { dark: true }),
    ],
  },
  {
    id: "prism",
    name: "Prism",
    fonts: ["Raleway", "Verdana"],
    effects: "lifted",
    title: { size: 3800, bold: true },
    body: { bullet: "▸", bulletColor: "accent1", bulletFont: "Arial", sizes: [2000, 1800, 1600, 1400, 1400] },
    art: ({ g }) => ({
      master: [
        rect(0, 0.958, 0.4, 0.042, "accent1"),
        rect(0.4, 0.958, 0.3, 0.042, "accent2"),
        rect(0.7, 0.958, 0.3, 0.042, "accent3"),
      ],
      layouts: {
        title: {
          hideMaster: true,
          shapes: [
            poly([[0.55, 0], [0.75, 0], [0.45, 1], [0.25, 1]], "accent1", [0.5, 0, 0.5, 1]),
            poly([[0.75, 0], [0.9, 0], [0.6, 1], [0.45, 1]], "accent2", [0.5, 0, 0.5, 1]),
            poly([[0.9, 0], [1, 0], [1, 0.25], [0.75, 1], [0.6, 1]], "accent3", [0.5, 0, 0.5, 1]),
          ],
          placeholders: titleSlideLeft(g, [0.07, 0.2, 0.55, 0.4], [0.07, 0.63, 0.5, 0.18], 4800),
        },
        secHead: {
          shapes: [
            poly([[0.3, 0], [1, 0], [0.7, 1], [0, 1]], "accent1/alpha=85000", [0.86, 0.2, 0.14, 0.5]),
          ],
        },
      },
    }),
    variants: [
      v("Prism", "#1f1f2e #ffffff #545470 #eeeef6 #5b3cc4 #e94f64 #f7b538 #20a39e #3d7dd8 #8f8fa8 #3d7dd8 #5b3cc4"),
      v("Prism Citrus", "#26261f #fffff9 #62624f #f3f3e6 #e36414 #f6aa1c #3a8a3e #0f7c8c #9a031e #6a6a50 #0f7c8c #9a031e"),
      v("Prism Ocean", "#172a3a #fbfdff #4a6278 #e5eef6 #0b6e99 #00a6a6 #f4a259 #5d6dbd #bc4b51 #7d8ea0 #0b6e99 #5d6dbd"),
      v("Prism Neon", "#120f1e #f3f0ff #221c38 #b2a8d6 #8f6bff #ff5c8a #ffd166 #2ee6c9 #4cc9ff #c2b8e8 #7fd6ff #c6b2ff", { dark: true }),
    ],
  },
  {
    id: "harbor",
    name: "Harbor",
    fonts: ["Georgia", "Verdana"],
    effects: "soft",
    title: { size: 3800 },
    body: { bullet: "•", bulletColor: "accent1", sizes: [2000, 1800, 1600, 1400, 1400] },
    art: ({ g }) => ({
      master: [rect(0, 0, 1, 0.012, "accent1"), hrule(0.06875, 0.262, 0.1, "accent2", 3)],
      layouts: {
        title: {
          hideMaster: true,
          shapes: [rect(0, 0.3, 1, 0.38, "accent1"), rect(0, 0.68, 1, 0.012, "accent2")],
          placeholders: [
            {
              type: "ctrTitle",
              box: g.box(0.08, 0.32, 0.84, 0.34),
              anchor: "ctr",
              lstStyle: levelStyle("l", 5000, "lt1"),
            },
            {
              type: "subTitle",
              box: g.box(0.08, 0.72, 0.84, 0.16),
              anchor: "t",
              lstStyle: plainLevels("l", [2000, 1800, 1600, 1400, 1400], "tx2"),
            },
          ],
        },
        secHead: {
          shapes: [rect(0, 0.62, 1, 0.012, "accent1")],
        },
      },
    }),
    variants: [
      v("Harbor", "#1b2a3a #ffffff #4b5f73 #e8eef4 #1d3f63 #e2913a #3f8f8a #b5473d #6b5fa3 #7a8a99 #1d5f9a #6b5fa3"),
      v("Harbor Fog", "#25303a #f9fafb #5a6773 #e6eaee #3e5a6e #c98f4a #5d8a6e #a65555 #6d6a9c #8a939c #3e6a8e #6d6a9c"),
      v("Harbor Brick", "#2a2220 #fffcfa #6a5a55 #f2ebe8 #7a2e22 #3f6f8f #d9a441 #4f7a5a #7a5a8f #8a7a70 #3f6f8f #7a5a8f"),
      v("Harbor Lights", "#0f1a26 #eef3f8 #1a2b3d #a5b6c8 #f0a85a #5fb3d6 #7fd1a8 #e98a8a #b4a6e8 #c8c8a0 #8ccaf0 #c8b8f5", { dark: true }),
    ],
  },
  {
    id: "ember",
    name: "Ember",
    fonts: ["Palatino", "Arial"],
    effects: "glow",
    title: { size: 4200 },
    body: { bullet: "•", bulletColor: "accent1" },
    art: ({ g }) => ({
      background: { grad: [[0, "bg2"], [1, "bg1"]], path: "circle", focus: [0.3, 0.25] },
      master: [
        circle(g, -0.1, 0.58, 0.32, "accent1/alpha=16000"),
        hrule(0.06875, 0.262, 0.06, "accent1", 2.5),
      ],
      layouts: {
        title: {
          hideMaster: true,
          shapes: [
            circle(g, 0.58, 0.08, 0.5, "accent1/alpha=20000"),
            circle(g, 0.68, 0.24, 0.26, "accent2/alpha=30000"),
            hrule(0.08, 0.58, 0.1, "accent1", 2.5),
          ],
          placeholders: titleSlideLeft(g, [0.08, 0.2, 0.6, 0.36], [0.08, 0.62, 0.55, 0.18], 5400),
        },
      },
    }),
    variants: [
      v("Ember", "#1a1210 #f7ede6 #3a2620 #cdb4a8 #f07c3c #ffc56b #d9534f #8fb6c8 #c79ad0 #a3c48a #ffb27a #e0b0e0", { dark: true }),
      v("Ember Rose", "#1d1016 #f8ecef #3a2230 #d0b2be #f05a7e #ffb36b #b98cf0 #7fc8c0 #f0d080 #9ab0e0 #ffa0b8 #c8a8ff", { dark: true }),
      v("Ember Ash", "#1b1b1d #f0eeeb #33302e #c2bbb3 #e8a33d #d9644a #86b3a0 #8ea2d0 #c5a0c8 #b8b08a #f0c070 #d0b0d8", { dark: true }),
      v("Ember Daylight", "#2a1a14 #fff8f2 #6e5044 #f7e4d8 #c24e1b #e3a33a #7a3f5e #3f7f8f #5f8a3f #8a6a5a #a2401a #7a3f5e"),
    ],
  },
  {
    id: "grove",
    name: "Grove",
    fonts: ["Garamond", "Trebuchet MS"],
    effects: "soft",
    title: { size: 4400 },
    body: { bullet: "❧", bulletColor: "accent1", bulletFont: "Georgia", subBullet: "•" },
    art: ({ g }) => {
      const leaf = (x, y, w, fill, rot) => ({
        x,
        y,
        w,
        h: w * g.aspect * 0.55,
        fill,
        rot,
        path: [["M", 0, 0.5], ["C", 0.3, -0.1, 0.7, -0.1, 1, 0.5], ["C", 0.7, 1.1, 0.3, 1.1, 0, 0.5], ["Z"]],
      });
      return {
        master: [
          leaf(0.88, 0.84, 0.12, "accent1/alpha=55000", -35),
          leaf(0.92, 0.76, 0.09, "accent2/alpha=55000", -70),
          leaf(0.83, 0.9, 0.08, "accent3/alpha=50000", -5),
        ],
        layouts: {
          title: {
            hideMaster: true,
            shapes: [
              leaf(0.66, 0.5, 0.3, "accent1/alpha=70000", -35),
              leaf(0.78, 0.3, 0.22, "accent2/alpha=65000", -70),
              leaf(0.6, 0.72, 0.2, "accent3/alpha=60000", 0),
              leaf(0.86, 0.66, 0.16, "accent1/alpha=40000", -110),
            ],
            placeholders: titleSlideLeft(g, [0.08, 0.16, 0.6, 0.4], [0.08, 0.6, 0.5, 0.18], 5400),
          },
        },
      };
    },
    variants: [
      v("Grove", "#1f2a1f #fbfaf4 #4e5e4a #eaeee0 #3f7a3a #a3b545 #c98b2e #5d8aa8 #8a5a7a #6e6a4a #3f7a3a #8a5a7a"),
      v("Grove Autumn", "#2b2219 #fffaf2 #6a5a48 #f3e9da #b5541f #d99a2b #6f8a3a #8a3f3f #5a6f8a #8a7a5a #8a3f1f #5a6f8a"),
      v("Grove Sage", "#232a26 #f8faf8 #56645c #e4ebe6 #5b8a6e #9aab6a #c4a265 #6a8aa0 #a27a8a #7a8a7a #4a7a5e #7a6a8a"),
      v("Grove Night", "#111a14 #edf2ea #1d2b21 #a7bba5 #8fd08a #d6e07a #f0b866 #8ac0e0 #d0a0c8 #b8c0a0 #a0e0b0 #d8b8e0", { dark: true }),
    ],
  },
  {
    id: "blueprint",
    name: "Blueprint",
    fonts: ["Courier New", "Verdana"],
    effects: "outline",
    title: { size: 3600, bold: true },
    body: { bullet: "+", bulletColor: "accent1", bulletFont: "Courier New", sizes: [2000, 1800, 1600, 1400, 1400] },
    background: { pattern: "smGrid", fg: "bg2", bg: "bg1" },
    art: () => ({
      master: [
        rect(0.03, 0.045, 0.94, 0.91, null, { line: { color: "tx2", width: 0.75, dash: "dash" } }),
        rect(0.03, 0.045, 0.03, 0.006, "accent1"),
        rect(0.94, 0.949, 0.03, 0.006, "accent1"),
      ],
      layouts: {
        title: {
          shapes: [hrule(0.4, 0.517, 0.2, "accent1", 2)],
        },
      },
    }),
    variants: [
      v("Blueprint", "#0f2a4a #f2f7fc #1d4573 #9fc3e6 #ffd166 #7fd8ff #ff8c6b #9be39b #d0a8ff #c8d8e8 #7fd8ff #d0a8ff", { dark: true }),
      v("Blueprint Paper", "#1f3550 #fbfdff #50677f #dde8f3 #1f5fa6 #e08a2b #2f8f6f #b04a4a #6a4fa0 #6f8296 #1f5fa6 #6a4fa0"),
      v("Blueprint Slate", "#1e252b #eef2f4 #2c3740 #a8b8c4 #f2b84b #6ec3e8 #f07f6a #8fd18f #c4a6f0 #b0bec8 #8cd0f0 #c8b0f0", { dark: true }),
      v("Blueprint Red", "#3a1518 #fcf6f5 #7a3a3e #f1dfdd #b3262e #2f5f8f #c98a2b #3f7f5f #6a4f8f #8a6e6e #2f5f8f #6a4f8f"),
    ],
  },
  {
    id: "mosaic",
    name: "Mosaic",
    fonts: ["Verdana", "Tahoma"],
    effects: "flat",
    title: { size: 3600, bold: true },
    body: { bullet: "■", bulletColor: "accent2", sizes: [2000, 1800, 1600, 1400, 1400] },
    art: ({ g }) => {
      const tile = 0.03;
      return {
        master: [1, 2, 3, 4, 5, 6].map((n, i) =>
          rect(0.69 + i * (tile + 0.008), 0.05, tile, tile * g.aspect, `accent${n}`),
        ),
        layouts: {
          title: {
            hideMaster: true,
            shapes: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
              rect(
                0.62 + (i % 3) * 0.12,
                0.12 + Math.floor(i / 3) * 0.12 * g.aspect,
                0.1,
                0.1 * g.aspect,
                `accent${(i % 6) + 1}${i % 4 === 3 ? "/alpha=55000" : ""}`,
              ),
            ),
            placeholders: titleSlideLeft(g, [0.07, 0.2, 0.52, 0.4], [0.07, 0.63, 0.5, 0.18], 4800),
          },
        },
      };
    },
    variants: [
      v("Mosaic", "#202020 #ffffff #505050 #f0f0f0 #e63946 #f4a261 #e9c46a #2a9d8f #457b9d #8d5ba8 #457b9d #8d5ba8"),
      v("Mosaic Pastel", "#2e2a33 #fdfcff #6a6476 #f1eef6 #e07a8f #f2b880 #e8d07a #7cc4a8 #7aa6d9 #b39ddb #5a86c0 #9a7dc8"),
      v("Mosaic Earth", "#2b2620 #fdfbf7 #6a6155 #f0ebe2 #a3492f #c98c2e #8a9a3a #3f7a6a #3f5f8a #7a4f6a #3f5f8a #7a4f6a"),
      v("Mosaic Night", "#161618 #efeff2 #262629 #b0b0b8 #ff6b6b #ffb86b #ffe08a #5fd3b8 #6fb0ff #c49bff #8cc4ff #d0b0ff", { dark: true }),
    ],
  },
  {
    id: "sunbeam",
    name: "Sunbeam",
    fonts: ["Trebuchet MS", "Georgia"],
    effects: "soft",
    title: { size: 4000, bold: true },
    body: { bullet: "•", bulletColor: "accent1", sizes: [2200, 2000, 1800, 1600, 1600] },
    art: ({ g }) => ({
      master: [
        { x: 0.022, y: 0.035, w: 0.956, h: 0.93, preset: "roundRect", adj: { adj: 3500 }, fill: null, line: { color: "accent1", width: 2 } },
      ],
      layouts: {
        title: {
          hideMaster: true,
          shapes: [
            circle(g, 0.74, -0.2, 0.36, "accent1"),
            circle(g, 0.7, -0.26, 0.46, null, { line: { color: "accent1/alpha=60000", width: 2 } }),
            circle(g, 0.66, -0.32, 0.56, null, { line: { color: "accent2/alpha=50000", width: 1.25 } }),
          ],
          placeholders: titleSlideLeft(g, [0.08, 0.3, 0.62, 0.32], [0.08, 0.65, 0.56, 0.16], 5000),
        },
      },
    }),
    variants: [
      v("Sunbeam", "#2e2410 #fffdf6 #6e5e3a #fbf1d6 #f2a900 #e2552c #3a8fb7 #5c9e3f #9a4f9f #a08a5a #2f7aa0 #9a4f9f"),
      v("Sunbeam Coral", "#33201c #fffaf7 #735048 #fde8e0 #f06a4a #f7b32b #2e8fa3 #6aa84f #8e5aa8 #a08070 #2e7f93 #8e5aa8"),
      v("Sunbeam Meadow", "#22301a #fbfdf5 #5a6e46 #eef5dc #8fb82a #f2a93b #3f8fb0 #d0573f #8a5aa8 #7a8a5a #2f7f9a #8a5aa8"),
      v("Sunbeam Dusk", "#1d1a12 #f7f3e8 #302b1e #c8bfa5 #ffc23d #ff7f50 #6fc0e0 #9ad07a #d8a0e8 #d0c090 #8fd0f0 #e0b8f0", { dark: true }),
    ],
  },
  {
    id: "slate",
    name: "Slate",
    fonts: ["Helvetica", "Arial"],
    effects: "lifted",
    title: { size: 4000, bold: true },
    body: { bullet: "–", bulletColor: "accent1", sizes: [2200, 2000, 1800, 1600, 1600] },
    art: ({ g }) => ({
      master: [hrule(0.075, 0.244, 0.07, "accent1", 4)],
      layouts: {
        title: {
          hideMaster: true,
          shapes: [rect(0.07, 0.3, 0.008, 0.34, "accent1"), rect(0, 0.94, 1, 0.06, "bg2")],
          placeholders: titleSlideLeft(g, [0.1, 0.26, 0.8, 0.26], [0.1, 0.54, 0.8, 0.14], 5400),
        },
        secHead: {
          hideMaster: true,
          shapes: [rect(0.07, 0.36, 0.008, 0.3, "accent1")],
          placeholders: sectionAt(g, [0.1, 0.24, 0.8, 0.42], [0.1, 0.68, 0.8, 0.2]),
        },
      },
    }),
    variants: [
      v("Slate", "#1e2124 #eceef0 #2e3236 #a8afb6 #4fb0c6 #f2b84b #e86a5c #8bc78b #a998e0 #c0c8d0 #7fd0e8 #c0b0f0", { dark: true }),
      v("Slate Warm", "#24201e #efebe8 #35302d #b8afa8 #e07a4a #f2c14e #6ab0a0 #8fa8e0 #d08aa8 #c8c0b0 #f0a080 #d0a8c8", { dark: true }),
      v("Slate Light", "#22262a #ffffff #565d64 #e9ecef #2f7f99 #d9921f #c44536 #3f8a4f #6f5fb0 #7a848e #2f7f99 #6f5fb0"),
      v("Slate Indigo", "#181a2a #eceefa #262a42 #a6aad0 #8a9cff #ffc86b #6fd8c8 #ff8a9a #c8a0ff #b8c0e0 #a0b0ff #d8b8ff", { dark: true }),
    ],
  },
  {
    id: "fresco",
    name: "Fresco",
    fonts: ["Georgia", "Georgia"],
    fontName: "Georgia",
    effects: "flat",
    title: { size: 4200 },
    body: { bullet: "•", bulletColor: "accent1" },
    background: { pattern: "pct5", fg: "bg2", bg: "bg1" },
    art: ({ g }) => ({
      master: [rect(0, 0, 1, 0.055, "accent1"), rect(0, 0.055, 1, 0.008, "accent2")],
      layouts: {
        title: {
          hideMaster: true,
          shapes: [rect(0, 0, 1, 0.24, "accent1"), rect(0, 0.24, 1, 0.012, "accent2"), rect(0, 0.95, 1, 0.05, "accent1")],
          placeholders: titleSlideCentered(g, [0.1, 0.3, 0.8, 0.3], [0.1, 0.63, 0.8, 0.16], 5000, "tx2"),
        },
      },
    }),
    variants: [
      v("Fresco", "#2b2420 #fbf6ee #6a5a4e #eadfcd #a8452f #5a7f8a #c9a03e #6a7a4a #8a5a6e #9a8a72 #5a7f8a #8a5a6e"),
      v("Fresco Terra", "#30211b #fcf3ea #725445 #efd9c6 #b3502a #3f6f6a #d8a344 #7a5a8a #5f7f3f #a08068 #3f6f6a #7a5a8a"),
      v("Fresco Azure", "#1f2a33 #f7f9fa #55666f #dfe8ec #2f6f9a #c98a3a #8a4a4a #5a8a5a #7a6aa0 #8a98a0 #2f6f9a #7a6aa0"),
      v("Fresco Night", "#1a1714 #f2ece4 #2c2722 #c4b8a8 #e0915e #8fc0c8 #e8c870 #a8c088 #d0a0c0 #c8b8a0 #9ad0d8 #e0b8d8", { dark: true }),
    ],
  },
  {
    id: "canvas",
    name: "Canvas",
    fonts: ["Raleway", "Georgia"],
    effects: "soft",
    title: { size: 4400, bold: true },
    body: { bullet: "•", bulletColor: "accent1" },
    art: ({ g }) => {
      const blob = (box, fill) => ({
        x: box[0],
        y: box[1],
        w: box[2],
        h: box[3],
        fill,
        path: [
          ["M", 0.1, 0.35],
          ["C", 0.15, 0.05, 0.55, -0.05, 0.75, 0.12],
          ["C", 0.98, 0.3, 1.02, 0.7, 0.8, 0.88],
          ["C", 0.6, 1.04, 0.2, 0.98, 0.08, 0.75],
          ["C", -0.02, 0.6, 0.06, 0.48, 0.1, 0.35],
          ["Z"],
        ],
      });
      return {
        master: [blob([-0.06, -0.12, 0.2, 0.3], "accent1/alpha=22000")],
        layouts: {
          title: {
            hideMaster: true,
            shapes: [
              blob([0.56, 0.04, 0.46, 0.8], "accent1/alpha=30000"),
              blob([0.7, 0.4, 0.32, 0.58], "accent2/alpha=40000"),
              blob([-0.08, 0.7, 0.24, 0.4], "accent3/alpha=30000"),
            ],
            placeholders: titleSlideLeft(g, [0.08, 0.2, 0.56, 0.38], [0.08, 0.61, 0.5, 0.18], 5400),
          },
          secHead: {
            shapes: [blob([0.7, 0.12, 0.36, 0.7], "accent2/alpha=25000")],
          },
        },
      };
    },
    variants: [
      v("Canvas", "#2a2a2a #fdfbf7 #5e5a55 #f1ece4 #d1495b #edae49 #00798c #30638e #66a182 #8a6a9a #00798c #8a6a9a"),
      v("Canvas Lilac", "#2a2533 #fcfaff #625a70 #efe9f6 #8a5cc2 #e6789a #4aa3a3 #e8a84a #5a7fd0 #8a8a6a #5a7fd0 #8a5cc2"),
      v("Canvas Clay", "#2e241f #fffaf5 #6a5a50 #f4e8dc #c2603a #e8b04a #4f8a7a #6a6aa8 #b85a7a #8a7a60 #4f6aa8 #b85a7a"),
      v("Canvas Ink", "#18181b #f2f0ec #27272b #b8b4ae #ff7a8a #ffc76b #4fd0d8 #7fb0f0 #8fe0a8 #d0a8e8 #8fd0ff #d8b0f0", { dark: true }),
    ],
  },
  {
    id: "horizon",
    name: "Horizon",
    fonts: ["Trebuchet MS", "Verdana"],
    effects: "soft",
    title: { size: 4000 },
    body: { bullet: "•", bulletColor: "accent1", sizes: [2000, 1800, 1600, 1400, 1400] },
    art: () => ({
      background: { grad: [[0, "bg2"], [0.7, "bg1"], [1, "bg1"]], angle: 90 },
      master: [hrule(0, 0.905, 1, "accent1/alpha=70000", 1.5)],
      layouts: {
        title: {
          hideMaster: true,
          background: { grad: [[0, "accent1/lumMod=60000/lumOff=40000"], [0.62, "bg1"], [1, "bg2"]], angle: 90 },
          shapes: [hrule(0, 0.62, 1, "accent1", 2), rect(0, 0.62, 1, 0.38, "accent1/alpha=12000")],
        },
      },
    }),
    variants: [
      v("Horizon", "#1d2b3a #ffffff #4f6378 #e3eef8 #2b6cb0 #f6ad55 #38a169 #e53e3e #805ad5 #718096 #2b6cb0 #805ad5"),
      v("Horizon Dawn", "#2d2233 #fffbf8 #6e5a72 #fbe7df #d4547a #f2a65a #4a90a8 #7a6ab8 #5a9a6a #9a8a8a #4a7aa8 #7a6ab8"),
      v("Horizon Desert", "#33261a #fffaf2 #735e48 #f7e6cc #c2692a #d9a03a #5a8a9a #9a4a3a #6a7a4a #8a7a6a #3a7a9a #7a5a8a"),
      v("Horizon Dusk", "#141a28 #eef1f8 #223050 #a8b4d0 #7f9cff #ffb36b #6fd1b0 #ff8a8a #c3a0ff #a0b0c8 #9cb4ff #d0b4ff", { dark: true }),
    ],
  },
];

export const LEGACY_IDS = new Set(CATALOG.filter((t) => t.legacy).map((t) => t.id));
export const themeById = (id) => CATALOG.find((t) => t.id === id) || null;
export const themeByName = (name) =>
  CATALOG.find((t) => t.name === name) || null;

// ---------------------------------------------------------------------------
// Palettes: the five colors the starter slides paint with, read from a
// variant's scheme through its color map.

const luminance = (hex) =>
  hex
    .replace("#", "")
    .match(/../g)
    .map((c) => parseInt(c, 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
export const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** `{ name, bg, ink, accent, muted, panel, onAccent }` for a scheme. */
export function paletteOf(colors, dark, name = "") {
  const bg = dark ? colors.dk1 : colors.lt1;
  const ink = dark ? colors.lt1 : colors.dk1;
  const muted = dark ? colors.lt2 : colors.dk2;
  const panel = dark ? colors.dk2 : colors.lt2;
  const accent = colors.accent1;
  const darkest = luminance(bg) < luminance(ink) ? bg : ink;
  const onAccent =
    contrast(accent, "#ffffff") >= contrast(accent, darkest)
      ? "#ffffff"
      : darkest;
  return { name, bg, ink, accent, muted, panel, onAccent };
}

/** The palette of a theme's variant. */
export function variantPalette(theme, index = 0) {
  const variant = theme.variants[index] || theme.variants[0];
  return paletteOf(variant.colors, !!variant.dark, theme.name);
}

/**
 * Palettes for the starter slides of every theme that is not one of the
 * original four, keyed by theme id, from each theme's first variant.
 */
export function paletteEntries() {
  return Object.fromEntries(
    CATALOG.filter((t) => !t.legacy).map((t) => [t.id, variantPalette(t, 0)]),
  );
}

// ---------------------------------------------------------------------------
// Fonts and color schemes offered on their own (Fonts and Colors menus).

/** Heading and body font pairs, each named for its faces. */
export const FONT_PAIRS = (() => {
  const seen = new Set();
  const out = [];
  const add = (major, minor) => {
    const key = `${major}|${minor}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: major === minor ? major : `${major}-${minor}`,
      major,
      minor,
    });
  };
  for (const t of CATALOG) add(t.fonts[0], t.fonts[1]);
  for (const [a, b] of [
    ["Calibri", "Calibri"],
    ["Cambria", "Calibri"],
    ["Times New Roman", "Arial"],
    ["Playfair Display", "Raleway"],
    ["Impact", "Arial"],
    ["Verdana", "Verdana"],
    ["Palatino", "Palatino"],
    ["Garamond", "Garamond"],
  ])
    add(a, b);
  return out;
})();

/** Every variant's color scheme, named, for the Colors menu. */
export const COLOR_SCHEMES = CATALOG.flatMap((t) =>
  t.variants.map((variant) => ({
    name: variant.name,
    colors: variant.colors,
    dark: !!variant.dark,
  })),
);
