//! Geometry operations: shape modes, pathfinders (faces), slicing, erasing,
//! stroke outlining, offsetting and simplification.

use crate::model::*;
use crate::recon::{outline, rebuild};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay::ShapeType;
use i_overlay::i_float::adapter::FloatPointAdapter;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::core::solver::Solver;
use i_overlay::float::clip::FloatClip;
use i_overlay::float::overlay::{FloatOverlay, OverlayOptions};
use i_overlay::float::slice::FloatSlice;
use i_overlay::string::clip::ClipRule;
use kurbo::{BezPath, Cap, Join, PathEl, Point, Stroke, StrokeOpts};

pub type Contours = Vec<Vec<Pt>>;
pub type Shapes = Vec<Contours>;

pub const OP_UNITE: u32 = 0;
pub const OP_INTERSECT: u32 = 1;
pub const OP_EXCLUDE: u32 = 2;
pub const OP_MINUS_FRONT: u32 = 3;
pub const OP_MINUS_BACK: u32 = 4;
pub const OP_DIVIDE: u32 = 5;
pub const OP_TRIM: u32 = 6;
pub const OP_MERGE: u32 = 7;
pub const OP_CROP: u32 = 8;
pub const OP_OUTLINE: u32 = 9;
pub const OP_SUBTRACT_EACH: u32 = 10;
pub const OP_DIVIDE_BELOW: u32 = 11;
pub const OP_SLICE_EACH: u32 = 12;
pub const OP_STROKE: u32 = 13;
pub const OP_OFFSET: u32 = 14;
pub const OP_SIMPLIFY: u32 = 15;
pub const OP_NORMALIZE: u32 = 16;
pub const OP_UNITE_GROUPS: u32 = 17;

fn opts() -> OverlayOptions<f64> {
    let mut o = OverlayOptions::<f64>::default();
    o.preserve_output_collinear = false;
    o.preserve_input_collinear = false;
    o.clean_result = true;
    o
}

/// Options for uniting stroke pieces: vertices on straight runs are kept, so
/// a piece united later still finds the vertices it shares with them.
fn keep_opts() -> OverlayOptions<f64> {
    let mut o = opts();
    o.preserve_output_collinear = true;
    o.preserve_input_collinear = true;
    o
}

fn overlay(subj: &Contours, clip: &Contours, rule: OverlayRule, fill: FillRule) -> Shapes {
    if subj.is_empty() && clip.is_empty() {
        return Vec::new();
    }
    FloatOverlay::with_subj_and_clip_custom(subj, clip, opts(), Solver::default()).overlay(rule, fill)
}

fn flat(shapes: &Shapes) -> Contours {
    shapes.iter().flat_map(|s| s.iter().cloned()).collect()
}

fn bbox(c: &Contours) -> Option<[f64; 4]> {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in c.iter().flatten() {
        b[0] = b[0].min(p[0]);
        b[1] = b[1].min(p[1]);
        b[2] = b[2].max(p[0]);
        b[3] = b[3].max(p[1]);
    }
    if b[0].is_finite() {
        Some(b)
    } else {
        None
    }
}

fn boxes_touch(a: &Option<[f64; 4]>, b: &Option<[f64; 4]>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3],
        _ => false,
    }
}

/// Flattened and normalized (non-overlapping, consistently oriented) input shapes.
pub struct Prepared {
    pub reg: Registry,
    pub raw: Vec<Contours>,
    pub norm: Vec<Contours>,
    pub strings: Vec<Vec<Vec<Pt>>>,
    pub boxes: Vec<Option<[f64; 4]>>,
    pub adapter: FloatPointAdapter<Pt, i32>,
}

pub fn prepare(shapes: &[Shape], tol: f64) -> Prepared {
    let mut reg = Registry::new(tol);
    let mut raw = Vec::with_capacity(shapes.len());
    let mut strings = Vec::with_capacity(shapes.len());
    for (i, s) in shapes.iter().enumerate() {
        let mut contours = Vec::new();
        let mut lines = Vec::new();
        for sp in &s.subpaths {
            if s.string() {
                let pl = reg.add_subpath(sp, i as u32, sp.closed);
                if pl.len() >= 2 {
                    let mut pl = pl;
                    if sp.closed {
                        pl.push(pl[0]);
                    }
                    lines.push(pl);
                }
            } else {
                let c = reg.add_subpath(sp, i as u32, true);
                if c.len() >= 3 {
                    contours.push(c);
                }
            }
        }
        raw.push(contours);
        strings.push(lines);
    }
    reg.build();
    // Normalize every shape on one shared integer grid: per-shape grids round
    // each shape's vertices differently, so edges two shapes share exactly
    // (Divide faces, snapped artwork) would stop coinciding and later unions
    // would keep them as slivers.
    let adapter: FloatPointAdapter<Pt, i32> = FloatPointAdapter::with_iter_conservative(raw.iter().flatten().flatten());
    let norm: Vec<Contours> = shapes
        .iter()
        .zip(raw.iter())
        .map(|(s, c)| {
            if s.string() || c.is_empty() {
                Vec::new()
            } else if s.flags & F_SIMPLE != 0 {
                // Simple pieces (stroke coverage) only need a common orientation.
                c.iter().map(|k| if area(k) < 0.0 { k.iter().rev().copied().collect() } else { k.clone() }).collect()
            } else {
                let fill = if s.evenodd() { FillRule::EvenOdd } else { FillRule::NonZero };
                let cap = c.iter().map(|k| k.len()).sum();
                let shapes = FloatOverlay::new_custom(adapter.clone(), opts(), Solver::default(), cap)
                    .unsafe_add_source(c, ShapeType::Subject)
                    .overlay(OverlayRule::Subject, fill);
                flat(&shapes)
            }
        })
        .collect();
    let boxes = norm.iter().map(bbox).collect();
    Prepared { reg, raw, norm, strings, boxes, adapter }
}

fn rebuild_shape(reg: &Registry, shape: &Contours) -> Vec<Subpath> {
    shape.iter().filter_map(|c| rebuild(reg, c, true)).collect()
}

fn out_all(reg: &Registry, shapes: &Shapes, owner: i32) -> OutShape {
    let mut subpaths = Vec::new();
    for s in shapes {
        subpaths.extend(rebuild_shape(reg, s));
    }
    OutShape { owner, flags: 0, cover: Vec::new(), subpaths }
}

fn out_each(reg: &Registry, shapes: &Shapes, owner: i32, out: &mut Vec<OutShape>) {
    for s in shapes {
        let subpaths = rebuild_shape(reg, s);
        if !subpaths.is_empty() {
            out.push(OutShape { owner, flags: 0, cover: Vec::new(), subpaths });
        }
    }
}

fn unchanged(owner: usize) -> OutShape {
    OutShape { owner: owner as i32, flags: R_UNCHANGED, cover: Vec::new(), subpaths: Vec::new() }
}

/// Indices of shapes that take part in area operations.
fn areas(shapes: &[Shape], p: &Prepared) -> Vec<usize> {
    (0..shapes.len()).filter(|&i| !shapes[i].string() && !p.norm[i].is_empty()).collect()
}

pub fn shape_mode(op: u32, shapes: &[Shape], tol: f64) -> Vec<OutShape> {
    let p = prepare(shapes, tol);
    let idx = areas(shapes, &p);
    if idx.is_empty() {
        return Vec::new();
    }
    let nz = FillRule::NonZero;
    let result: Shapes = match op {
        OP_UNITE => {
            let all: Contours = idx.iter().flat_map(|&i| p.norm[i].iter().cloned()).collect();
            overlay(&all, &Vec::new(), OverlayRule::Subject, nz)
        }
        OP_INTERSECT => {
            let mut acc = p.norm[idx[0]].clone();
            for &i in &idx[1..] {
                acc = flat(&overlay(&acc, &p.norm[i], OverlayRule::Intersect, nz));
                if acc.is_empty() {
                    break;
                }
            }
            overlay(&acc, &Vec::new(), OverlayRule::Subject, nz)
        }
        OP_EXCLUDE => {
            let mut acc = p.norm[idx[0]].clone();
            for &i in &idx[1..] {
                acc = flat(&overlay(&acc, &p.norm[i], OverlayRule::Xor, nz));
            }
            overlay(&acc, &Vec::new(), OverlayRule::Subject, nz)
        }
        OP_MINUS_FRONT | OP_MINUS_BACK => {
            let keep = if op == OP_MINUS_FRONT { idx[0] } else { idx[idx.len() - 1] };
            let rest: Contours = idx.iter().filter(|&&i| i != keep).flat_map(|&i| p.norm[i].iter().cloned()).collect();
            overlay(&p.norm[keep], &rest, OverlayRule::Difference, nz)
        }
        _ => Vec::new(),
    };
    let owner = match op {
        OP_MINUS_FRONT => idx[0] as i32,
        _ => idx[idx.len() - 1] as i32,
    };
    let o = out_all(&p.reg, &result, owner);
    if o.subpaths.is_empty() {
        Vec::new()
    } else {
        vec![o]
    }
}

pub struct Face {
    pub contours: Contours,
    pub cover: Vec<u32>,
    pub owner: i32,
}

/// Faces of the planar arrangement of all shapes (and cutting strings).
pub fn faces(shapes: &[Shape], p: &Prepared) -> Vec<Face> {
    let idx = areas(shapes, p);
    if idx.is_empty() {
        return Vec::new();
    }
    let nz = FillRule::NonZero;
    let all: Contours = idx.iter().flat_map(|&i| p.norm[i].iter().cloned()).collect();
    let union = flat(&overlay(&all, &Vec::new(), OverlayRule::Subject, nz));
    let mut lines: Vec<Vec<Pt>> = Vec::new();
    for &i in &idx {
        for c in &p.norm[i] {
            let mut l = c.clone();
            l.push(c[0]);
            lines.push(l);
        }
    }
    for s in &p.strings {
        lines.extend(s.iter().cloned());
    }
    let sliced: Shapes = if lines.is_empty() { overlay(&union, &Vec::new(), OverlayRule::Subject, nz) } else { union.slice_by(&lines, nz) };
    let min_area = (p.reg.tol * p.reg.tol).max(p.reg.eps * p.reg.eps * 100.0);
    let mut out = Vec::new();
    for f in sliced {
        let a: f64 = f.iter().map(|c| area(c)).sum::<f64>().abs();
        if a < min_area {
            continue;
        }
        let ip = match interior_point(&f) {
            Some(q) => q,
            None => continue,
        };
        let mut cover = Vec::new();
        for &i in &idx {
            if let Some(b) = p.boxes[i] {
                if ip[0] < b[0] || ip[0] > b[2] || ip[1] < b[1] || ip[1] > b[3] {
                    continue;
                }
            }
            let w = winding(&p.raw[i], ip);
            let inside = if shapes[i].evenodd() { w % 2 != 0 } else { w != 0 };
            if inside {
                cover.push(i as u32);
            }
        }
        if cover.is_empty() {
            continue;
        }
        let owner = cover.iter().rev().find(|&&i| shapes[i as usize].filled()).or(cover.last()).map(|&i| i as i32).unwrap_or(-1);
        out.push(Face { contours: f, cover, owner });
    }
    out
}

/// Union faces grouped by a key; each group yields one record per resulting shape.
fn union_groups(reg: &Registry, groups: Vec<(i64, i32, Contours)>, out: &mut Vec<OutShape>) {
    for (_, owner, contours) in groups {
        let u = overlay(&contours, &Vec::new(), OverlayRule::Subject, FillRule::NonZero);
        out_each(reg, &u, owner, out);
    }
}

fn group_faces(fs: &[Face], key: impl Fn(&Face) -> Option<(i64, i32)>) -> Vec<(i64, i32, Contours)> {
    let mut groups: Vec<(i64, i32, Contours)> = Vec::new();
    for f in fs {
        if let Some((k, owner)) = key(f) {
            if let Some(g) = groups.iter_mut().find(|g| g.0 == k) {
                g.1 = g.1.max(owner);
                g.2.extend(f.contours.iter().cloned());
            } else {
                groups.push((k, owner, f.contours.clone()));
            }
        }
    }
    groups
}

pub fn pathfinder(op: u32, shapes: &[Shape], tol: f64) -> Vec<OutShape> {
    let p = prepare(shapes, tol);
    let fs = faces(shapes, &p);
    let mut out = Vec::new();
    match op {
        OP_DIVIDE => {
            for f in &fs {
                let subpaths = rebuild_shape(&p.reg, &f.contours);
                if !subpaths.is_empty() {
                    out.push(OutShape { owner: f.owner, flags: 0, cover: f.cover.clone(), subpaths });
                }
            }
        }
        OP_TRIM => {
            let groups = group_faces(&fs, |f| Some((f.owner as i64, f.owner)));
            union_groups(&p.reg, groups, &mut out);
        }
        OP_MERGE => {
            // Same key (solid fill color chosen by the caller) merges; a negative key never merges.
            let groups = group_faces(&fs, |f| {
                let k = shapes[f.owner as usize].key;
                Some(if k >= 0.0 { (k as i64, f.owner) } else { (-1 - f.owner as i64, f.owner) })
            });
            union_groups(&p.reg, groups, &mut out);
        }
        OP_CROP => {
            let top = match areas(shapes, &p).last() {
                Some(&t) => t as u32,
                None => return out,
            };
            let groups = group_faces(&fs, |f| {
                if !f.cover.contains(&top) {
                    return None;
                }
                let o = f.cover.iter().rev().filter(|&&i| i != top).find(|&&i| shapes[i as usize].filled()).copied()?;
                Some((o as i64, o as i32))
            });
            union_groups(&p.reg, groups, &mut out);
        }
        OP_OUTLINE => {
            let input: Vec<(Contours, i32)> = fs.iter().map(|f| (f.contours.clone(), f.owner)).collect();
            for (owner, sp) in outline(&p.reg, &input) {
                out.push(OutShape { owner, flags: 0, cover: Vec::new(), subpaths: vec![sp] });
            }
        }
        _ => {}
    }
    out
}

/// Eraser and similar: subtract the last shape from each of the others.
pub fn subtract_each(shapes: &[Shape], tol: f64, keep_inside: bool) -> Vec<OutShape> {
    let p = prepare(shapes, tol);
    let n = shapes.len();
    if n < 2 {
        return Vec::new();
    }
    let cutter = &p.norm[n - 1];
    let cb = p.boxes[n - 1];
    let nz = FillRule::NonZero;
    let mut out = Vec::new();
    for i in 0..n - 1 {
        if shapes[i].string() {
            // Open paths: keep the parts outside the cutter.
            let lines = &p.strings[i];
            let lb = bbox(lines);
            if !boxes_touch(&lb, &cb) {
                out.push(unchanged(i));
                continue;
            }
            let rule = ClipRule { invert: true, boundary_included: false };
            let kept = lines.clip_by(cutter, nz, rule);
            let total_in: usize = lines.iter().map(|l| l.len()).sum();
            let total_out: usize = kept.iter().map(|l| l.len()).sum();
            if kept.len() == lines.len() && total_in == total_out {
                out.push(unchanged(i));
                continue;
            }
            for l in kept {
                if let Some(sp) = rebuild(&p.reg, &l, false) {
                    out.push(OutShape { owner: i as i32, flags: 0, cover: Vec::new(), subpaths: vec![sp] });
                }
            }
            if out.last().map_or(true, |o| o.owner != i as i32) {
                // Everything erased.
                out.push(OutShape { owner: i as i32, flags: 0, cover: Vec::new(), subpaths: Vec::new() });
            }
            continue;
        }
        if p.norm[i].is_empty() || !boxes_touch(&p.boxes[i], &cb) {
            out.push(unchanged(i));
            continue;
        }
        let hit = overlay(&p.norm[i], cutter, OverlayRule::Intersect, nz);
        if hit.is_empty() {
            out.push(unchanged(i));
            continue;
        }
        let before = out.len();
        if keep_inside {
            out_each(&p.reg, &hit, i as i32, &mut out);
            for o in &mut out[before..] {
                o.cover = vec![1];
            }
            let rest = overlay(&p.norm[i], cutter, OverlayRule::Difference, nz);
            let mid = out.len();
            out_each(&p.reg, &rest, i as i32, &mut out);
            for o in &mut out[mid..] {
                o.cover = vec![0];
            }
        } else {
            let rest = overlay(&p.norm[i], cutter, OverlayRule::Difference, nz);
            out_each(&p.reg, &rest, i as i32, &mut out);
        }
        if out.len() == before {
            out.push(OutShape { owner: i as i32, flags: 0, cover: Vec::new(), subpaths: Vec::new() });
        }
    }
    out
}

/// Knife: slice every area shape by the string shapes.
pub fn slice_each(shapes: &[Shape], tol: f64) -> Vec<OutShape> {
    let p = prepare(shapes, tol);
    let lines: Vec<Vec<Pt>> = p.strings.iter().flat_map(|s| s.iter().cloned()).collect();
    let lb = bbox(&lines);
    let mut out = Vec::new();
    for i in 0..shapes.len() {
        if shapes[i].string() {
            continue;
        }
        if p.norm[i].is_empty() || lines.is_empty() || !boxes_touch(&p.boxes[i], &lb) {
            out.push(unchanged(i));
            continue;
        }
        let pieces = p.norm[i].slice_by(&lines, FillRule::NonZero);
        if pieces.len() <= 1 {
            out.push(unchanged(i));
            continue;
        }
        out_each(&p.reg, &pieces, i as i32, &mut out);
    }
    out
}

/// Union shapes that share a key (Blob Brush, Merge helpers); keys < 0 pass through.
pub fn unite_groups(shapes: &[Shape], tol: f64) -> Vec<OutShape> {
    let p = prepare(shapes, tol);
    let mut groups: Vec<(i64, i32, Contours)> = Vec::new();
    for i in areas(shapes, &p) {
        let k = shapes[i].key;
        let key = if k >= 0.0 { k as i64 } else { -1 - i as i64 };
        if let Some(g) = groups.iter_mut().find(|g| g.0 == key) {
            g.1 = g.1.max(i as i32);
            g.2.extend(p.norm[i].iter().cloned());
        } else {
            groups.push((key, i as i32, p.norm[i].clone()));
        }
    }
    let mut out = Vec::new();
    for (_, owner, contours) in groups {
        let u = overlay(&contours, &Vec::new(), OverlayRule::Subject, FillRule::NonZero);
        let o = out_all(&p.reg, &u, owner);
        if !o.subpaths.is_empty() {
            out.push(o);
        }
    }
    out
}

/// Clean up a shape's own overlaps (normalize with its fill rule).
pub fn normalize(shapes: &[Shape], tol: f64) -> Vec<OutShape> {
    let p = prepare(shapes, tol);
    let mut out = Vec::new();
    for i in areas(shapes, &p) {
        let u = overlay(&p.norm[i], &Vec::new(), OverlayRule::Subject, FillRule::NonZero);
        let o = out_all(&p.reg, &u, i as i32);
        if !o.subpaths.is_empty() {
            out.push(o);
        }
    }
    out
}

// ---- kurbo bridges ----

pub fn to_bez(sp: &Subpath) -> BezPath {
    let mut b = BezPath::new();
    let n = sp.anchors.len();
    if n == 0 {
        return b;
    }
    let a0 = &sp.anchors[0];
    b.move_to((a0.x, a0.y));
    for seg in segments(sp, sp.closed) {
        if is_line(&seg) {
            b.line_to((seg[3][0], seg[3][1]));
        } else {
            b.curve_to((seg[1][0], seg[1][1]), (seg[2][0], seg[2][1]), (seg[3][0], seg[3][1]));
        }
    }
    if sp.closed {
        b.close_path();
    }
    b
}

pub fn from_bez(path: &BezPath) -> Vec<Subpath> {
    let mut out: Vec<Subpath> = Vec::new();
    let mut cur: Option<Subpath> = None;
    let mut last = Point::ZERO;
    let pt = |p: Point| [p.x, p.y];
    let finish = |cur: &mut Option<Subpath>, out: &mut Vec<Subpath>, closed: bool| {
        if let Some(mut sp) = cur.take() {
            if closed {
                let n = sp.anchors.len();
                if n > 1 {
                    let f = sp.anchors[0];
                    let l = sp.anchors[n - 1];
                    if (f.x - l.x).abs() < 1e-9 && (f.y - l.y).abs() < 1e-9 {
                        sp.anchors[0].ix = l.ix;
                        sp.anchors[0].iy = l.iy;
                        sp.anchors.pop();
                    }
                }
                sp.closed = true;
            }
            if sp.anchors.len() > 1 || (sp.anchors.len() == 1 && closed) {
                out.push(sp);
            }
        }
    };
    for el in path.elements() {
        match *el {
            PathEl::MoveTo(p) => {
                finish(&mut cur, &mut out, false);
                cur = Some(Subpath { closed: false, anchors: vec![Anchor::at(pt(p))] });
                last = p;
            }
            PathEl::LineTo(p) => {
                if let Some(sp) = cur.as_mut() {
                    if p != last {
                        sp.anchors.push(Anchor::at(pt(p)));
                    }
                }
                last = p;
            }
            PathEl::QuadTo(c, p) => {
                if let Some(sp) = cur.as_mut() {
                    let c1 = last + (c - last) * (2.0 / 3.0);
                    let c2 = p + (c - p) * (2.0 / 3.0);
                    let l = sp.anchors.last_mut().unwrap();
                    l.ox = c1.x;
                    l.oy = c1.y;
                    let mut a = Anchor::at(pt(p));
                    a.ix = c2.x;
                    a.iy = c2.y;
                    sp.anchors.push(a);
                }
                last = p;
            }
            PathEl::CurveTo(c1, c2, p) => {
                if let Some(sp) = cur.as_mut() {
                    let l = sp.anchors.last_mut().unwrap();
                    l.ox = c1.x;
                    l.oy = c1.y;
                    let mut a = Anchor::at(pt(p));
                    a.ix = c2.x;
                    a.iy = c2.y;
                    sp.anchors.push(a);
                }
                last = p;
            }
            PathEl::ClosePath => {
                finish(&mut cur, &mut out, true);
            }
        }
    }
    finish(&mut cur, &mut out, false);
    out
}

fn join_of(v: f64) -> Join {
    match v as i32 {
        1 => Join::Round,
        2 => Join::Bevel,
        _ => Join::Miter,
    }
}

fn cap_of(v: f64) -> Cap {
    match v as i32 {
        1 => Cap::Round,
        2 => Cap::Square,
        _ => Cap::Butt,
    }
}

fn stroke_shape(sps: &[Subpath], st: &Stroke, tol: f64) -> Shape {
    let mut subpaths = Vec::new();
    for sp in sps {
        if sp.anchors.len() < 2 && !(sp.closed && sp.anchors.len() == 1) {
            continue;
        }
        let out = kurbo::stroke(to_bez(sp).elements().iter().copied(), st, &StrokeOpts::default(), tol);
        subpaths.extend(from_bez(&out));
    }
    Shape { flags: F_FILLED, key: 0.0, subpaths }
}

// ---- stroke coverage ----
//
// The stroker draws the inner side of a stroke as one offset curve. Where the
// stroke is wider than the path curves (a tight curve, a short segment
// between turns), that inner curve folds back across the path, and with two
// contours per closed path (outer and inner) the folds cancel out under the
// nonzero rule: a circle with a stroke wider than its diameter keeps a hole,
// a shape offset inward by more than its size stays whole. The stroke as
// drawn is the union of every segment's own stroke plus the joins and caps,
// so near such places the separately stroked pieces are added to the
// stroker's outline, each normalized on its own so they cannot cancel.

fn unit(v: Pt) -> Option<Pt> {
    let l = (v[0] * v[0] + v[1] * v[1]).sqrt();
    if l > 1e-12 && l.is_finite() {
        Some([v[0] / l, v[1] / l])
    } else {
        None
    }
}

fn seg_tangents(p: &[Pt; 4]) -> Option<(Pt, Pt)> {
    let start = if dist(p[0], p[1]) > 1e-9 { [p[1][0] - p[0][0], p[1][1] - p[0][1]] } else if dist(p[0], p[2]) > 1e-9 { [p[2][0] - p[0][0], p[2][1] - p[0][1]] } else { [p[3][0] - p[0][0], p[3][1] - p[0][1]] };
    let end = if dist(p[3], p[2]) > 1e-9 { [p[3][0] - p[2][0], p[3][1] - p[2][1]] } else if dist(p[3], p[1]) > 1e-9 { [p[3][0] - p[1][0], p[3][1] - p[1][1]] } else { [p[3][0] - p[0][0], p[3][1] - p[0][1]] };
    Some((unit(start)?, unit(end)?))
}

fn d1(p: &[Pt; 4], t: f64) -> Pt {
    let mt = 1.0 - t;
    let (a, b, c) = (3.0 * mt * mt, 6.0 * mt * t, 3.0 * t * t);
    [a * (p[1][0] - p[0][0]) + b * (p[2][0] - p[1][0]) + c * (p[3][0] - p[2][0]), a * (p[1][1] - p[0][1]) + b * (p[2][1] - p[1][1]) + c * (p[3][1] - p[2][1])]
}

fn d2(p: &[Pt; 4], t: f64) -> Pt {
    let mt = 1.0 - t;
    [
        6.0 * mt * (p[2][0] - 2.0 * p[1][0] + p[0][0]) + 6.0 * t * (p[3][0] - 2.0 * p[2][0] + p[1][0]),
        6.0 * mt * (p[2][1] - 2.0 * p[1][1] + p[0][1]) + 6.0 * t * (p[3][1] - 2.0 * p[2][1] + p[1][1]),
    ]
}

/// Does a curve bend tighter than `r` anywhere (or have a cusp)?
fn bends_within(p: &[Pt; 4], r: f64) -> bool {
    if is_line(p) {
        return false;
    }
    for i in 0..=16 {
        let t = i as f64 / 16.0;
        let a = d1(p, t);
        let b = d2(p, t);
        let speed = (a[0] * a[0] + a[1] * a[1]).sqrt();
        let cross = (a[0] * b[1] - a[1] * b[0]).abs();
        if speed * speed * speed < r * cross || speed < 1e-9 {
            return true;
        }
    }
    false
}

fn turn(a: Pt, b: Pt) -> f64 {
    (a[0] * b[1] - a[1] * b[0]).atan2(a[0] * b[0] + a[1] * b[1]).abs()
}

fn seg_path(segs: &[[Pt; 4]]) -> BezPath {
    let mut b = BezPath::new();
    b.move_to((segs[0][0][0], segs[0][0][1]));
    for q in segs {
        if is_line(q) {
            b.line_to((q[3][0], q[3][1]));
        } else {
            b.curve_to((q[1][0], q[1][1]), (q[2][0], q[2][1]), (q[3][0], q[3][1]));
        }
    }
    b
}

/// A piece stroked by the stroker; `simple` when its outline cannot cross itself.
fn piece(q: &[Pt; 4], st: &Stroke, tol: f64, simple: bool) -> Option<Shape> {
    let out = kurbo::stroke(seg_path(&[*q]).elements().iter().copied(), st, &StrokeOpts::default(), tol);
    let mut subpaths = from_bez(&out);
    // Put the segment's end points on the butt ends, where joins and
    // neighbouring pieces meet them, so they share vertices exactly.
    for sp in subpaths.iter_mut() {
        let n = sp.anchors.len();
        let mut anchors = Vec::with_capacity(n + 2);
        for k in 0..n {
            let a = sp.anchors[k];
            let b = sp.anchors[(k + 1) % n];
            anchors.push(a);
            let straight = a.ox == a.x && a.oy == a.y && b.ix == b.x && b.iy == b.y;
            if !straight {
                continue;
            }
            let mid = [(a.x + b.x) * 0.5, (a.y + b.y) * 0.5];
            for e in [q[0], q[3]] {
                if dist(mid, e) <= 1e-9 * (1.0 + e[0].abs() + e[1].abs()) && dist([a.x, a.y], e) > 1e-12 {
                    anchors.push(Anchor::at(e));
                    break;
                }
            }
        }
        sp.anchors = anchors;
    }
    if subpaths.is_empty() {
        None
    } else {
        Some(Shape { flags: F_FILLED | if simple { F_SIMPLE } else { 0 }, key: 0.0, subpaths })
    }
}

fn polygon(pts: &[Pt]) -> Shape {
    Subpath { closed: true, anchors: pts.iter().map(|p| Anchor::at(*p)).collect() }.into_simple()
}

impl Subpath {
    fn into_simple(self) -> Shape {
        Shape { flags: F_FILLED | F_SIMPLE, key: 0.0, subpaths: vec![self] }
    }
}

/// A pie slice around `c` from the offset `from` (length = radius), turning by `sweep`.
fn pie(c: Pt, from: Pt, sweep: f64, tol: f64) -> Shape {
    let r = (from[0] * from[0] + from[1] * from[1]).sqrt();
    let mut b = BezPath::new();
    b.move_to((c[0], c[1]));
    b.line_to((c[0] + from[0], c[1] + from[1]));
    let arc = kurbo::Arc::new((c[0], c[1]), (r, r), from[1].atan2(from[0]), sweep, 0.0);
    for el in arc.append_iter(tol.max(1e-6)) {
        b.push(el);
    }
    b.close_path();
    let mut sps = from_bez(&b);
    match sps.pop() {
        Some(sp) => sp.into_simple(),
        None => Shape::default(),
    }
}

fn add(a: Pt, b: Pt) -> Pt {
    [a[0] + b[0], a[1] + b[1]]
}

fn scaled(a: Pt, k: f64) -> Pt {
    [a[0] * k, a[1] * k]
}

/// Segment count above which a subpath keeps the stroker's outline (see stroke_cover).
const PIECES_MAX: usize = 600;

/// An angle difference in (-pi, pi]; a full reversal (a cusp, a hairpin)
/// counts as half a turn.
fn wrap_angle(mut d: f64) -> f64 {
    let tau = 2.0 * std::f64::consts::PI;
    d %= tau;
    if d > std::f64::consts::PI {
        d -= tau;
    } else if d <= -std::f64::consts::PI {
        d += tau;
    }
    d
}

/// Does the stroker's outline risk missing part of this subpath's stroke?
///
/// Its inner contour cancels coverage once it flips over as a whole: where
/// the path turns by about half a turn within a stretch as
/// long as a half circle of the half width (a circle narrower than the
/// stroke, an inset past the shape's size). Wiggles smaller than the stroke
/// only fold the inner contour locally, which the nonzero fill still covers,
/// so directions are taken along secants as long as the stroke is wide.
fn needs_pieces(segs: &[[Pt; 4]], closed: bool, half: f64) -> bool {
    let pi = std::f64::consts::PI;
    // Points along the path and their cumulative lengths.
    let mut pts: Vec<Pt> = Vec::new();
    for q in segs {
        if pts.is_empty() {
            pts.push(q[0]);
        }
        let steps = if is_line(q) { 1 } else { 16 };
        for k in 1..=steps {
            let b = if k == steps { q[3] } else { cubic_at(q, k as f64 / steps as f64) };
            if dist(*pts.last().unwrap(), b) > 1e-12 {
                pts.push(b);
            }
        }
    }
    if closed && pts.len() > 1 && dist(pts[0], *pts.last().unwrap()) <= 1e-12 {
        pts.pop();
    }
    let n = pts.len();
    if n < 3 {
        return false;
    }
    let chords = if closed { n } else { n - 1 };
    let at = |i: usize| pts[i % n];
    let clen = |i: usize| dist(at(i), at(i + 1));
    // Directions of secants spanning the stroke width, by cumulative length.
    let laps = if closed { 2 } else { 1 };
    let span = 2.0 * half;
    let window = pi * half;
    let limit = 0.9 * pi;
    let mut len = Vec::with_capacity(chords * laps + 1);
    let mut s = 0.0;
    for i in 0..chords * laps {
        len.push(s);
        s += clen(i);
    }
    len.push(s);
    let point_at = |k: &mut usize, d: f64| -> Option<Pt> {
        while *k + 1 < len.len() && len[*k + 1] < d {
            *k += 1;
        }
        if *k + 1 >= len.len() {
            return None;
        }
        let l = len[*k + 1] - len[*k];
        let t = if l > 0.0 { (d - len[*k]) / l } else { 0.0 };
        Some(lerp(at(*k), at(*k + 1), t.clamp(0.0, 1.0)))
    };
    let lap = len[chords];
    if span >= if closed { 0.5 * lap } else { lap } {
        // The whole path is short next to the stroke: its net turning decides.
        let mut net = 0.0;
        let turns = if closed { chords } else { chords - 1 };
        for i in 0..turns {
            let (a, b, c) = (at(i), at(i + 1), at(i + 2));
            net += wrap_angle((c[1] - b[1]).atan2(c[0] - b[0]) - (b[1] - a[1]).atan2(b[0] - a[0]));
        }
        return net.abs() > limit;
    }
    let mut dir = Vec::with_capacity(len.len());
    let mut slen = Vec::with_capacity(len.len());
    let mut mlen = Vec::with_capacity(len.len());
    let (mut ka, mut kb) = (0usize, 0usize);
    let mut acc = 0.0;
    let mut prev: Option<f64> = None;
    // Also lengths along the secants' midpoints: the path with its wiggles smoothed out.
    let mut along = 0.0;
    let mut last_mid: Option<Pt> = None;
    for i in 0..len.len() - 1 {
        let d0 = len[i];
        let (Some(p), Some(q)) = (point_at(&mut ka, d0), point_at(&mut kb, d0 + span)) else { break };
        if dist(p, q) <= 1e-12 {
            continue;
        }
        let ang = (q[1] - p[1]).atan2(q[0] - p[0]);
        if let Some(pr) = prev {
            acc += wrap_angle(ang - pr);
        }
        prev = Some(ang);
        let mid = lerp(p, q, 0.5);
        if let Some(m) = last_mid {
            along += dist(m, mid);
        }
        last_mid = Some(mid);
        dir.push(acc);
        slen.push(d0);
        mlen.push(along);
    }
    let turns_within = |at_len: &[f64]| {
        let mut j = 0;
        for i in 0..dir.len() {
            j = j.max(i);
            while j + 1 < dir.len() && at_len[j + 1] - at_len[i] <= window {
                j += 1;
            }
            if (dir[j] - dir[i]).abs() > limit {
                return true;
            }
        }
        false
    };
    if turns_within(&slen) {
        return true;
    }
    // A wiggly path is much longer than its shape, so measured along the path
    // the window can miss the shape turning over. Measured along the secants'
    // midpoints instead (which shortens tight curves too, so only when the
    // stroke is about as wide as the whole shape).
    let (mut lo, mut hi) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for p in &pts {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    half > 0.5 * (hi[0] - lo[0]).min(hi[1] - lo[1]) && turns_within(&mlen)
}

/// Total turning of a curve, sampled.
fn curve_turn(q: &[Pt; 4]) -> f64 {
    let mut total = 0.0;
    let mut prev: Option<Pt> = None;
    for i in 0..=8 {
        if let Some(t) = unit(d1(q, i as f64 / 8.0)) {
            if let Some(p) = prev {
                total += turn(p, t);
            }
            prev = Some(t);
        }
    }
    total
}

/// Split a curve into parts turning by at most `max` (overlapping a little).
fn split_turning(q: &[Pt; 4], max: f64, out: &mut Vec<[Pt; 4]>) {
    let parts = ((curve_turn(q) / max).ceil() as usize).clamp(1, 64);
    if parts == 1 {
        out.push(*q);
        return;
    }
    let pad = 0.02 / parts as f64;
    for k in 0..parts {
        let t0 = k as f64 / parts as f64;
        let t1 = (k + 1) as f64 / parts as f64;
        out.push(sub_cubic(q, (t0 - pad).max(0.0), (t1 + pad).min(1.0)));
    }
}

/// A subpath's stroke as separate pieces, each a shape of its own: every
/// segment (curves split where they turn a lot), every join and the caps.
/// Lines, joins and caps are built directly as simple polygons, so only
/// tightly bent curve parts need normalizing before the union.
fn stroke_pieces(sp: &Subpath, segs: &[[Pt; 4]], tans: &[Option<(Pt, Pt)>], st: &Stroke, tol: f64, out: &mut Vec<Shape>) {
    let h = 0.5 * st.width;
    let n = segs.len();
    let bare = Stroke::new(st.width).with_caps(Cap::Butt).with_join(st.join).with_miter_limit(st.miter_limit);
    let left = |t: Pt| [-t[1] * h, t[0] * h];
    for (k, q) in segs.iter().enumerate() {
        if is_line(q) {
            let Some((t, _)) = tans[k] else { continue };
            let m = left(t);
            out.push(polygon(&[add(q[0], m), add(q[3], m), q[3], add(q[3], scaled(m, -1.0)), add(q[0], scaled(m, -1.0)), q[0]]));
        } else if bends_within(q, h) {
            let mut parts = Vec::new();
            split_turning(q, 0.35, &mut parts);
            for part in parts {
                out.extend(piece(&part, &bare, tol, false));
            }
        } else {
            let mut parts = Vec::new();
            split_turning(q, 1.5, &mut parts);
            for part in parts {
                out.extend(piece(&part, &bare, tol, true));
            }
        }
    }
    let vertices = if sp.closed { n } else { n - 1 };
    for v in 0..vertices {
        let (i, j) = (v, (v + 1) % n);
        let (Some((_, tin)), Some((tout, _))) = (tans[i], tans[j]) else { continue };
        let cross = tin[0] * tout[1] - tin[1] * tout[0];
        let dot = tin[0] * tout[0] + tin[1] * tout[1];
        let p = segs[j][0];
        if cross == 0.0 && dot > 0.0 {
            continue;
        }
        // The outer side of the turn (the right side for a left turn).
        let side = if cross >= 0.0 { -1.0 } else { 1.0 };
        let a = scaled(left(tin), side);
        let b = scaled(left(tout), side);
        match st.join {
            Join::Round => out.push(pie(p, a, cross.atan2(dot), tol)),
            Join::Miter if 2.0 < (1.0 + dot) * st.miter_limit * st.miter_limit => {
                let tip = scaled(add(a, b), 1.0 / (1.0 + dot));
                out.push(polygon(&[p, add(p, a), add(p, tip), add(p, b)]));
            }
            _ => out.push(polygon(&[p, add(p, a), add(p, b)])),
        }
    }
    if !sp.closed {
        if let (Some((t0, _)), Some((_, t1))) = (tans[0], tans[n - 1]) {
            let (p0, p1) = (segs[0][0], segs[n - 1][3]);
            let (m0, m1) = (left(t0), left(t1));
            let (b0, f1) = (scaled(t0, -h), scaled(t1, h));
            match st.start_cap {
                Cap::Round => out.push(pie(p0, m0, std::f64::consts::PI, tol)),
                Cap::Square => out.push(polygon(&[add(p0, m0), add(add(p0, m0), b0), add(add(p0, scaled(m0, -1.0)), b0), add(p0, scaled(m0, -1.0))])),
                Cap::Butt => {}
            }
            match st.end_cap {
                Cap::Round => out.push(pie(p1, scaled(m1, -1.0), std::f64::consts::PI, tol)),
                Cap::Square => out.push(polygon(&[add(p1, m1), add(add(p1, m1), f1), add(add(p1, scaled(m1, -1.0)), f1), add(p1, scaled(m1, -1.0))])),
                Cap::Butt => {}
            }
        }
    }
}

/// Undashed subpaths of a dashed stroke (the dashes as open subpaths).
fn dashed(sps: &[Subpath], st: &Stroke) -> Vec<Subpath> {
    if st.dash_pattern.is_empty() {
        return sps.to_vec();
    }
    let mut out = Vec::new();
    for sp in sps {
        let b = to_bez(sp);
        let d: BezPath = kurbo::dash(b.elements().iter().copied(), st.dash_offset, &st.dash_pattern).collect();
        out.extend(from_bez(&d));
    }
    out
}

/// A stroke as shapes to unite: the stroker's outline of the subpaths it
/// draws whole, then pieces for the subpaths where it could miss coverage.
///
/// Pieces cost more than the stroker's outline on long subpaths, where they
/// are used only with `always` (insets: there the outline both misses
/// coverage and is slow to resolve when the inset passes the shape's size).
fn stroke_cover(sps: &[Subpath], st: &Stroke, tol: f64, always: bool) -> Vec<Shape> {
    let half = 0.5 * st.width;
    if !(half > 0.0) || !half.is_finite() {
        return vec![stroke_shape(sps, st, tol)];
    }
    let plain = dashed(sps, st);
    let mut whole = Vec::new();
    let mut pieces = Vec::new();
    let mut bare = st.clone();
    bare.dash_pattern = Default::default();
    for sp in &plain {
        let segs: Vec<[Pt; 4]> = segments(sp, sp.closed).into_iter().filter(|q| dist(q[0], q[3]) > 1e-12 || !is_line(q)).collect();
        let tans: Vec<Option<(Pt, Pt)>> = segs.iter().map(seg_tangents).collect();
        if !segs.is_empty() && (always || segs.len() <= PIECES_MAX) && needs_pieces(&segs, sp.closed, half) {
            stroke_pieces(sp, &segs, &tans, st, tol, &mut pieces);
        } else {
            whole.push(sp.clone());
        }
    }
    if pieces.is_empty() {
        return vec![stroke_shape(sps, st, tol)];
    }
    let mut v = vec![stroke_shape(&whole, &bare, tol)];
    v.extend(pieces);
    v
}

/// Union of the normalized shapes `from..to` of a prepared set (all with
/// the same orientation). Neighbouring pieces are united in small batches,
/// then the batches in pairs: uniting many overlapping pieces at once makes
/// the overlay split the same crowded crossings over and over, and one
/// overlay per piece costs too much on dense paths.
fn union_norm(p: &Prepared, from: usize, to: usize, width: f64) -> Contours {
    let mut level: Vec<Contours> = Vec::new();
    let mut batch: Contours = Vec::new();
    let mut count = 0;
    let mut bb = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    let reach = 3.0 * width;
    let flush = |batch: &mut Contours, count: &mut usize, level: &mut Vec<Contours>| {
        if *count == 1 {
            level.push(std::mem::take(batch));
        } else if *count > 1 {
            let cap = batch.iter().map(|k| k.len()).sum();
            let shapes = FloatOverlay::new_custom(p.adapter.clone(), keep_opts(), Solver::default(), cap).unsafe_add_source(&*batch, ShapeType::Subject).overlay(OverlayRule::Subject, FillRule::NonZero);
            level.push(flat(&shapes));
            batch.clear();
        }
        *count = 0;
    };
    for k in from..to {
        let c = &p.norm[k];
        let Some(b) = p.boxes[k] else { continue };
        let grown = [bb[0].min(b[0]), bb[1].min(b[1]), bb[2].max(b[2]), bb[3].max(b[3])];
        if count > 0 && (count >= 24 || (grown[2] - grown[0]).max(grown[3] - grown[1]) > reach) {
            flush(&mut batch, &mut count, &mut level);
            bb = b;
        } else {
            bb = grown;
        }
        batch.extend(c.iter().cloned());
        count += 1;
    }
    flush(&mut batch, &mut count, &mut level);
    if level.is_empty() {
        return Vec::new();
    }
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len() / 2 + 1);
        let mut it = level.into_iter();
        while let Some(a) = it.next() {
            match it.next() {
                Some(b) => {
                    // On the shared grid, so edges that pieces share stay shared.
                    let cap = a.iter().chain(b.iter()).map(|k| k.len()).sum();
                    let shapes = FloatOverlay::new_custom(p.adapter.clone(), keep_opts(), Solver::default(), cap).unsafe_add_source(&a, ShapeType::Subject).unsafe_add_source(&b, ShapeType::Clip).overlay(OverlayRule::Union, FillRule::NonZero);
                    next.push(flat(&shapes));
                }
                None => next.push(a),
            }
        }
        level = next;
    }
    // Rounding to the grid where many pieces cross leaves hairline holes;
    // nothing thinner than a fraction of the tolerance is real.
    let thin = 0.1 * p.reg.tol;
    let mut out = level.pop().unwrap();
    if to - from < 2 {
        return out;
    }
    out.retain(|c| {
        let per: f64 = (0..c.len()).map(|i| dist(c[i], c[(i + 1) % c.len()])).sum();
        per > 0.0 && 2.0 * area(c).abs() / per >= thin
    });
    out
}

/// Outline Stroke. params: [width, join, cap, miter, align, dashOffset, dash...]
/// align: 0 center, 1 inside, 2 outside.
pub fn outline_stroke(params: &[f64], shapes: &[Shape], tol: f64) -> Vec<OutShape> {
    let g = |i: usize, d: f64| params.get(i).copied().unwrap_or(d);
    let width = g(0, 1.0).max(0.0);
    let align = g(4, 0.0) as i32;
    let dashes: Vec<f64> = params.iter().skip(6).copied().filter(|d| *d >= 0.0).collect();
    let mut st = Stroke::new(if align == 0 { width } else { width * 2.0 }).with_join(join_of(g(1, 0.0))).with_caps(cap_of(g(2, 0.0))).with_miter_limit(g(3, 10.0).max(1.0));
    if !dashes.is_empty() && dashes.iter().sum::<f64>() > 0.0 {
        st = st.with_dashes(g(5, 0.0), dashes);
    }
    let mut out = Vec::new();
    for (i, s) in shapes.iter().enumerate() {
        let stroked = stroke_cover(&s.subpaths, &st, tol * 0.5, false);
        if stroked.iter().all(|k| k.subpaths.is_empty()) {
            continue;
        }
        let all_closed = s.subpaths.iter().all(|sp| sp.closed);
        let mut base = s.clone();
        base.flags = F_FILLED | (s.flags & F_EVENODD);
        let mut set = vec![base];
        set.extend(stroked);
        let p = prepare(&set, tol);
        let ring = union_norm(&p, 1, set.len(), st.width);
        let nz = FillRule::NonZero;
        let res = if align == 1 && all_closed {
            overlay(&ring, &p.norm[0], OverlayRule::Intersect, nz)
        } else if align == 2 && all_closed {
            overlay(&ring, &p.norm[0], OverlayRule::Difference, nz)
        } else {
            overlay(&ring, &Vec::new(), OverlayRule::Subject, nz)
        };
        let o = out_all(&p.reg, &res, i as i32);
        if !o.subpaths.is_empty() {
            out.push(o);
        }
    }
    out
}

/// Offset Path. params: [delta, join, miter]
pub fn offset_path(params: &[f64], shapes: &[Shape], tol: f64) -> Vec<OutShape> {
    let delta = params.first().copied().unwrap_or(0.0);
    let join = params.get(1).copied().unwrap_or(0.0);
    let miter = params.get(2).copied().unwrap_or(4.0).max(1.0);
    let cap = match join as i32 {
        1 => Cap::Round,
        2 => Cap::Butt,
        _ => Cap::Square,
    };
    let st = Stroke::new(delta.abs() * 2.0).with_join(join_of(join)).with_caps(cap).with_miter_limit(miter);
    let nz = FillRule::NonZero;
    let mut out = Vec::new();
    for (i, s) in shapes.iter().enumerate() {
        let closed: Vec<Subpath> = s.subpaths.iter().filter(|sp| sp.closed && sp.anchors.len() > 1).cloned().collect();
        let open: Vec<Subpath> = s.subpaths.iter().filter(|sp| !sp.closed && sp.anchors.len() > 1).cloned().collect();
        if delta.abs() < 1e-12 {
            out.push(OutShape { owner: i as i32, flags: 0, cover: Vec::new(), subpaths: s.subpaths.clone() });
            continue;
        }
        let base = Shape { flags: F_FILLED | (s.flags & F_EVENODD), key: 0.0, subpaths: closed.clone() };
        let ring = stroke_cover(&closed, &st, tol * 0.5, delta < 0.0);
        let lines = stroke_cover(&open, &st, tol * 0.5, false);
        let (nr, nl) = (ring.len(), lines.len());
        let mut set = vec![base];
        set.extend(ring);
        set.extend(lines);
        let p = prepare(&set, tol);
        let ring = union_norm(&p, 1, 1 + nr, st.width);
        let lines = union_norm(&p, 1 + nr, 1 + nr + nl, st.width);
        let mut res = if closed.is_empty() {
            Vec::new()
        } else if delta > 0.0 {
            flat(&overlay(&p.norm[0], &ring, OverlayRule::Union, nz))
        } else {
            flat(&overlay(&p.norm[0], &ring, OverlayRule::Difference, nz))
        };
        if delta > 0.0 && !lines.is_empty() {
            res = flat(&overlay(&res, &lines, OverlayRule::Union, nz));
        }
        let shaped = overlay(&res, &Vec::new(), OverlayRule::Subject, nz);
        let o = out_all(&p.reg, &shaped, i as i32);
        out.push(o);
    }
    out
}

/// Simplify. params: [accuracy, angleThresholdTangent]
pub fn simplify(params: &[f64], shapes: &[Shape]) -> Vec<OutShape> {
    let accuracy = params.first().copied().unwrap_or(1.0).max(1e-6);
    let angle = params.get(1).copied().unwrap_or(1e-3).max(1e-6);
    let opts = kurbo::simplify::SimplifyOptions::default().angle_thresh(angle);
    let mut out = Vec::new();
    for (i, s) in shapes.iter().enumerate() {
        let mut subpaths = Vec::new();
        for sp in &s.subpaths {
            if sp.anchors.len() < 3 {
                subpaths.push(sp.clone());
                continue;
            }
            let b = to_bez(sp);
            let r = kurbo::simplify::simplify_bezpath(b.elements().iter().copied(), accuracy, &opts);
            let mut got = from_bez(&r);
            if got.len() == 1 && got[0].anchors.len() >= 2 {
                got[0].closed = sp.closed;
                subpaths.push(got.remove(0));
            } else {
                subpaths.push(sp.clone());
            }
        }
        out.push(OutShape { owner: i as i32, flags: 0, cover: Vec::new(), subpaths });
    }
    out
}
