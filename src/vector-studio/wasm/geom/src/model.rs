//! Input/output records, source-curve registry and flattening.
//!
//! Every input cubic is flattened into a polyline whose vertices remember
//! the curve id and parameter t. Polygon booleans run on those polylines;
//! `recon` then maps each output edge back onto the source curve it lies on
//! and rebuilds exact sub-curves, so results keep their Beziers.

pub type Pt = [f64; 2];

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Anchor {
    pub x: f64,
    pub y: f64,
    pub ix: f64,
    pub iy: f64,
    pub ox: f64,
    pub oy: f64,
}

impl Anchor {
    pub fn at(p: Pt) -> Self {
        Anchor { x: p[0], y: p[1], ix: p[0], iy: p[1], ox: p[0], oy: p[1] }
    }
}

#[derive(Clone, Debug, Default)]
pub struct Subpath {
    pub closed: bool,
    pub anchors: Vec<Anchor>,
}

pub const F_FILLED: u32 = 1;
pub const F_EVENODD: u32 = 2;
pub const F_STRING: u32 = 4;
/// Internal: the contours are simple (no self-crossings), so they need orienting, not normalizing.
pub const F_SIMPLE: u32 = 8;

#[derive(Clone, Debug, Default)]
pub struct Shape {
    pub flags: u32,
    pub key: f64,
    pub subpaths: Vec<Subpath>,
}

impl Shape {
    pub fn filled(&self) -> bool {
        self.flags & F_FILLED != 0
    }
    pub fn evenodd(&self) -> bool {
        self.flags & F_EVENODD != 0
    }
    pub fn string(&self) -> bool {
        self.flags & F_STRING != 0
    }
}

pub const R_UNCHANGED: u32 = 1;

#[derive(Clone, Debug, Default)]
pub struct OutShape {
    pub owner: i32,
    pub flags: u32,
    pub cover: Vec<u32>,
    pub subpaths: Vec<Subpath>,
}

/// Parse `[paramCount, params..., shapeCount, shapes...]`.
pub fn parse(buf: &[f64]) -> Option<(Vec<f64>, Vec<Shape>)> {
    let mut i = 0usize;
    let next = |i: &mut usize| -> Option<f64> {
        let v = *buf.get(*i)?;
        *i += 1;
        Some(v)
    };
    let pc = next(&mut i)? as usize;
    let mut params = Vec::with_capacity(pc);
    for _ in 0..pc {
        params.push(next(&mut i)?);
    }
    let sc = next(&mut i)? as usize;
    let mut shapes = Vec::with_capacity(sc);
    for _ in 0..sc {
        let flags = next(&mut i)? as u32;
        let key = next(&mut i)?;
        let spc = next(&mut i)? as usize;
        let mut subpaths = Vec::with_capacity(spc);
        for _ in 0..spc {
            let closed = next(&mut i)? != 0.0;
            let n = next(&mut i)? as usize;
            let mut anchors = Vec::with_capacity(n);
            for _ in 0..n {
                let x = next(&mut i)?;
                let y = next(&mut i)?;
                let ix = next(&mut i)?;
                let iy = next(&mut i)?;
                let ox = next(&mut i)?;
                let oy = next(&mut i)?;
                if !(x.is_finite() && y.is_finite() && ix.is_finite() && iy.is_finite() && ox.is_finite() && oy.is_finite()) {
                    return None;
                }
                anchors.push(Anchor { x, y, ix, iy, ox, oy });
            }
            subpaths.push(Subpath { closed, anchors });
        }
        shapes.push(Shape { flags, key, subpaths });
    }
    Some((params, shapes))
}

/// Serialize `[count, per record: owner, flags, coverCount, cover..., subpathCount, subpaths...]`.
pub fn write(out: &mut Vec<f64>, shapes: &[OutShape]) {
    out.clear();
    out.push(shapes.len() as f64);
    for s in shapes {
        out.push(s.owner as f64);
        out.push(s.flags as f64);
        out.push(s.cover.len() as f64);
        for &c in &s.cover {
            out.push(c as f64);
        }
        out.push(s.subpaths.len() as f64);
        for sp in &s.subpaths {
            out.push(if sp.closed { 1.0 } else { 0.0 });
            out.push(sp.anchors.len() as f64);
            for a in &sp.anchors {
                out.extend_from_slice(&[a.x, a.y, a.ix, a.iy, a.ox, a.oy]);
            }
        }
    }
}

/// A source cubic: p0, c1, c2, p3. `line` when both handles are retracted.
#[derive(Clone, Debug)]
pub struct Curve {
    pub p: [Pt; 4],
    pub line: bool,
    pub shape: u32,
    pub e0: u32,
    pub e1: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct Edge {
    pub a: Pt,
    pub b: Pt,
    pub ta: f64,
    pub tb: f64,
    pub curve: u32,
}

pub fn lerp(a: Pt, b: Pt, t: f64) -> Pt {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
}

pub fn dist(a: Pt, b: Pt) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

pub fn cubic_at(p: &[Pt; 4], t: f64) -> Pt {
    let mt = 1.0 - t;
    let a = mt * mt * mt;
    let b = 3.0 * mt * mt * t;
    let c = 3.0 * mt * t * t;
    let d = t * t * t;
    [
        a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0],
        a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1],
    ]
}

fn cubic_d1(p: &[Pt; 4], t: f64) -> Pt {
    let mt = 1.0 - t;
    let a = 3.0 * mt * mt;
    let b = 6.0 * mt * t;
    let c = 3.0 * t * t;
    [
        a * (p[1][0] - p[0][0]) + b * (p[2][0] - p[1][0]) + c * (p[3][0] - p[2][0]),
        a * (p[1][1] - p[0][1]) + b * (p[2][1] - p[1][1]) + c * (p[3][1] - p[2][1]),
    ]
}

fn cubic_d2(p: &[Pt; 4], t: f64) -> Pt {
    let mt = 1.0 - t;
    [
        6.0 * mt * (p[2][0] - 2.0 * p[1][0] + p[0][0]) + 6.0 * t * (p[3][0] - 2.0 * p[2][0] + p[1][0]),
        6.0 * mt * (p[2][1] - 2.0 * p[1][1] + p[0][1]) + 6.0 * t * (p[3][1] - 2.0 * p[2][1] + p[1][1]),
    ]
}

/// Newton refinement of t so cubic(t) is closest to q.
pub fn refine_t(p: &[Pt; 4], q: Pt, mut t: f64) -> f64 {
    for _ in 0..4 {
        let c = cubic_at(p, t);
        let d1 = cubic_d1(p, t);
        let d2 = cubic_d2(p, t);
        let fx = c[0] - q[0];
        let fy = c[1] - q[1];
        let num = fx * d1[0] + fy * d1[1];
        let den = d1[0] * d1[0] + d1[1] * d1[1] + fx * d2[0] + fy * d2[1];
        if den.abs() < 1e-12 {
            break;
        }
        let nt = (t - num / den).clamp(0.0, 1.0);
        if (nt - t).abs() < 1e-12 {
            t = nt;
            break;
        }
        t = nt;
    }
    t
}

/// The part of a cubic between t0 < t1.
pub fn sub_cubic(p: &[Pt; 4], t0: f64, t1: f64) -> [Pt; 4] {
    fn split(p: &[Pt; 4], t: f64) -> ([Pt; 4], [Pt; 4]) {
        let p01 = lerp(p[0], p[1], t);
        let p12 = lerp(p[1], p[2], t);
        let p23 = lerp(p[2], p[3], t);
        let a = lerp(p01, p12, t);
        let b = lerp(p12, p23, t);
        let m = lerp(a, b, t);
        ([p[0], p01, a, m], [m, b, p23, p[3]])
    }
    let mut q = *p;
    if t1 < 1.0 {
        q = split(&q, t1).0;
    }
    if t0 > 0.0 && t1 > 0.0 {
        q = split(&q, t0 / t1).1;
    }
    q
}

/// Segments of a subpath as cubics (closing segment included when closed or `close_for_fill`).
pub fn segments(sp: &Subpath, close: bool) -> Vec<[Pt; 4]> {
    let n = sp.anchors.len();
    let mut out = Vec::new();
    if n < 2 {
        return out;
    }
    let count = if close { n } else { n - 1 };
    for i in 0..count {
        let a = &sp.anchors[i];
        let b = &sp.anchors[(i + 1) % n];
        let mut seg = [[a.x, a.y], [a.ox, a.oy], [b.ix, b.iy], [b.x, b.y]];
        if close && i == n - 1 && !sp.closed {
            // Implicit closing segment of an open path used as a fill: a straight line.
            seg = [[a.x, a.y], [a.x, a.y], [b.x, b.y], [b.x, b.y]];
        }
        out.push(seg);
    }
    out
}

pub fn is_line(p: &[Pt; 4]) -> bool {
    let e = 1e-9;
    (p[1][0] - p[0][0]).abs() < e && (p[1][1] - p[0][1]).abs() < e && (p[2][0] - p[3][0]).abs() < e && (p[2][1] - p[3][1]).abs() < e
}

/// Registry of source curves and their flattened edges with a uniform grid
/// for "which source edge does this point lie on" queries.
pub struct Registry {
    pub tol: f64,
    pub curves: Vec<Curve>,
    pub edges: Vec<Edge>,
    grid: Vec<Vec<u32>>,
    gx: f64,
    gy: f64,
    cell: f64,
    nx: usize,
    ny: usize,
    pub eps: f64,
}

impl Registry {
    pub fn new(tol: f64) -> Self {
        Registry { tol: tol.max(1e-6), curves: Vec::new(), edges: Vec::new(), grid: Vec::new(), gx: 0.0, gy: 0.0, cell: 1.0, nx: 0, ny: 0, eps: 1e-9 }
    }

    /// Flatten one cubic into the registry; returns the polyline points after the start point.
    fn add_curve(&mut self, p: [Pt; 4], shape: u32, out: &mut Vec<Pt>) {
        if dist(p[0], p[3]) < 1e-12 && dist(p[0], p[1]) < 1e-12 && dist(p[0], p[2]) < 1e-12 {
            return;
        }
        let line = is_line(&p);
        let id = self.curves.len() as u32;
        let e0 = self.edges.len() as u32;
        let n = if line {
            1
        } else {
            let ddx = (p[0][0] - 2.0 * p[1][0] + p[2][0]).abs().max((p[1][0] - 2.0 * p[2][0] + p[3][0]).abs());
            let ddy = (p[0][1] - 2.0 * p[1][1] + p[2][1]).abs().max((p[1][1] - 2.0 * p[2][1] + p[3][1]).abs());
            let dd = (ddx * ddx + ddy * ddy).sqrt();
            ((3.0 * dd / (4.0 * self.tol)).sqrt().ceil() as usize).clamp(1, 2000)
        };
        let mut prev = p[0];
        let mut tp = 0.0;
        for i in 1..=n {
            let t = i as f64 / n as f64;
            let q = if i == n { p[3] } else { cubic_at(&p, t) };
            if dist(prev, q) > 0.0 {
                self.edges.push(Edge { a: prev, b: q, ta: tp, tb: t, curve: id });
                out.push(q);
                prev = q;
                tp = t;
            } else if i == n {
                // Keep the exact end parameter on the last edge.
                if let Some(e) = self.edges.last_mut() {
                    if e.curve == id {
                        e.tb = 1.0;
                    }
                }
            }
        }
        let e1 = self.edges.len() as u32;
        self.curves.push(Curve { p, line, shape, e0, e1 });
    }

    /// Flatten a subpath: a polygon contour (implicitly closed) or an open polyline.
    pub fn add_subpath(&mut self, sp: &Subpath, shape: u32, close: bool) -> Vec<Pt> {
        let mut out = Vec::new();
        if sp.anchors.is_empty() {
            return out;
        }
        out.push([sp.anchors[0].x, sp.anchors[0].y]);
        for seg in segments(sp, close) {
            self.add_curve(seg, shape, &mut out);
        }
        if close && out.len() > 1 && dist(out[0], out[out.len() - 1]) < 1e-12 {
            out.pop();
        }
        out
    }

    /// Build the lookup grid. Call after all curves are added.
    pub fn build(&mut self) {
        let mut minx = f64::INFINITY;
        let mut miny = f64::INFINITY;
        let mut maxx = f64::NEG_INFINITY;
        let mut maxy = f64::NEG_INFINITY;
        for e in &self.edges {
            for p in [e.a, e.b] {
                minx = minx.min(p[0]);
                miny = miny.min(p[1]);
                maxx = maxx.max(p[0]);
                maxy = maxy.max(p[1]);
            }
        }
        if !minx.is_finite() {
            self.nx = 0;
            return;
        }
        let w = (maxx - minx).max(1e-9);
        let h = (maxy - miny).max(1e-9);
        let diag = (w * w + h * h).sqrt();
        self.eps = diag * 2e-7 + 1e-9;
        let n = self.edges.len().max(1) as f64;
        let mut cell = ((w * h) / (2.0 * n)).sqrt().max(w.max(h) / 2048.0).max(self.eps * 4.0);
        loop {
            let nx = (w / cell).ceil() as usize + 3;
            let ny = (h / cell).ceil() as usize + 3;
            if nx * ny <= 1 << 21 {
                self.nx = nx;
                self.ny = ny;
                break;
            }
            cell *= 1.5;
        }
        self.cell = cell;
        self.gx = minx - cell;
        self.gy = miny - cell;
        self.grid = vec![Vec::new(); self.nx * self.ny];
        for (idx, e) in self.edges.iter().enumerate() {
            let len = dist(e.a, e.b);
            let steps = ((len / (cell * 0.5)).ceil() as usize).max(1);
            for s in 0..=steps {
                let p = lerp(e.a, e.b, s as f64 / steps as f64);
                let cx = ((p[0] - self.gx) / cell) as isize;
                let cy = ((p[1] - self.gy) / cell) as isize;
                for dy in -1..=1isize {
                    for dx in -1..=1isize {
                        let x = cx + dx;
                        let y = cy + dy;
                        if x < 0 || y < 0 || x as usize >= self.nx || y as usize >= self.ny {
                            continue;
                        }
                        let bucket = &mut self.grid[y as usize * self.nx + x as usize];
                        if bucket.last() != Some(&(idx as u32)) {
                            bucket.push(idx as u32);
                        }
                    }
                }
            }
        }
    }

    pub fn candidates(&self, p: Pt) -> &[u32] {
        if self.nx == 0 {
            return &[];
        }
        let cx = ((p[0] - self.gx) / self.cell) as isize;
        let cy = ((p[1] - self.gy) / self.cell) as isize;
        if cx < 0 || cy < 0 || cx as usize >= self.nx || cy as usize >= self.ny {
            return &[];
        }
        &self.grid[cy as usize * self.nx + cx as usize]
    }
}

/// Distance from p to segment ab and the projection parameter u in [0, 1].
pub fn seg_dist(p: Pt, a: Pt, b: Pt) -> (f64, f64) {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let l2 = dx * dx + dy * dy;
    let u = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    let q = [a[0] + dx * u, a[1] + dy * u];
    (dist(p, q), u)
}

/// Signed area of a polygon contour (shoelace).
pub fn area(c: &[Pt]) -> f64 {
    let n = c.len();
    let mut s = 0.0;
    for i in 0..n {
        let p = c[i];
        let q = c[(i + 1) % n];
        s += p[0] * q[1] - q[0] * p[1];
    }
    s * 0.5
}

/// Winding number of point p against a set of contours.
pub fn winding(contours: &[Vec<Pt>], p: Pt) -> i32 {
    let mut w = 0;
    for c in contours {
        let n = c.len();
        if n < 3 {
            continue;
        }
        for i in 0..n {
            let a = c[i];
            let b = c[(i + 1) % n];
            if a[1] <= p[1] {
                if b[1] > p[1] && cross(a, b, p) > 0.0 {
                    w += 1;
                }
            } else if b[1] <= p[1] && cross(a, b, p) < 0.0 {
                w -= 1;
            }
        }
    }
    w
}

fn cross(a: Pt, b: Pt, p: Pt) -> f64 {
    (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1])
}

/// A point strictly inside a polygon with holes (scanline through the widest strip).
pub fn interior_point(contours: &[Vec<Pt>]) -> Option<Pt> {
    let mut ys: Vec<f64> = contours.iter().flat_map(|c| c.iter().map(|p| p[1])).collect();
    if ys.len() < 3 {
        return None;
    }
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    ys.dedup();
    let mut gaps: Vec<(f64, f64)> = ys.windows(2).map(|w| (w[1] - w[0], (w[0] + w[1]) * 0.5)).collect();
    gaps.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(core::cmp::Ordering::Equal));
    let mut best: Option<(f64, Pt)> = None;
    for &(gh, y) in gaps.iter().take(8) {
        let mut xs = Vec::new();
        for c in contours {
            let n = c.len();
            for i in 0..n {
                let a = c[i];
                let b = c[(i + 1) % n];
                if (a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y) {
                    xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
                }
            }
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
        let mut k = 0;
        while k + 1 < xs.len() {
            let wdt = xs[k + 1] - xs[k];
            let score = wdt.min(gh);
            if best.map_or(true, |(s, _)| score > s) {
                best = Some((score, [(xs[k] + xs[k + 1]) * 0.5, y]));
            }
            k += 2;
        }
    }
    best.map(|b| b.1)
}
