//! Click detection and repair.
//!
//! `AutoClickRemover` (realtime): an adaptive AR(16) predictor whitens the
//! signal; samples whose prediction error stands far above its running level
//! mark a click region, which is rebuilt by least-squares AR interpolation
//! once enough samples after it have arrived. Latency is `LATENCY` frames.
//! Params: 0 threshold (1..100, lower finds more clicks), 1 complexity
//! (1..100, longer clicks and higher repair orders).
//!
//! `declick` (offline, Click/Pop Eliminator): block-wise AR residual with a
//! robust (median) scale, run grouping, discrimination and multi-pass LSAR
//! repair.

use super::ar::Lsar;
use crate::fx::Effect;

const CAP: usize = 8192;
const LCTX: usize = 256;
const RCTX: usize = 128;
const MAXW: usize = 192;
pub const LATENCY: usize = 336;
const KEEP: usize = LATENCY + LCTX + MAXW + RCTX + 64;
const DET_ORDER: usize = 16;
const DET_WIN: usize = 512;
const MAX_ORDER: usize = 48;

struct Chan {
    buf: Vec<f32>,
    w: usize,
    a: [f64; DET_ORDER + 1],
    since: usize,
    scale: f32,
    ready: bool,
    region: Option<(usize, usize)>,
}

impl Chan {
    fn new() -> Chan {
        let mut a = [0.0; DET_ORDER + 1];
        a[0] = 1.0;
        Chan { buf: vec![0.0; CAP], w: KEEP, a, since: 0, scale: 0.0, ready: false, region: None }
    }
}

pub struct AutoClickRemover {
    rate: f32,
    k: f32,
    max_w: usize,
    order: usize,
    chans: Vec<Chan>,
    lsar: Lsar,
    pub repaired: u32,
}

impl AutoClickRemover {
    pub fn new(rate: f32, channels: usize) -> AutoClickRemover {
        let mut a = AutoClickRemover {
            rate,
            k: 10.0,
            max_w: 64,
            order: 32,
            chans: (0..channels).map(|_| Chan::new()).collect(),
            lsar: Lsar::new(MAXW, MAX_ORDER, LCTX + RCTX + MAXW),
            repaired: 0,
        };
        a.set_param(0, 30.0);
        a.set_param(1, 30.0);
        a
    }
}

impl Effect for AutoClickRemover {
    fn set_param(&mut self, idx: u32, v: f32) {
        match idx {
            0 => self.k = 4.0 + v.clamp(1.0, 100.0) * 0.2,
            1 => {
                let c = v.clamp(1.0, 100.0);
                self.max_w = (16.0 + c * 1.76) as usize;
                self.order = (16.0 + c * 0.32) as usize;
            }
            _ => {}
        }
    }

    fn process(&mut self, buf: &mut [f32], channels: usize, frames: usize) {
        let track = 1.0 / (0.02 * self.rate);
        for c in 0..channels.min(self.chans.len()) {
            let ch = &mut self.chans[c];
            for x in &mut buf[c * frames..(c + 1) * frames] {
                let n = ch.w;
                ch.buf[n] = *x;
                ch.w += 1;
                let mut e = 0.0f64;
                for k in 0..=DET_ORDER {
                    e += ch.a[k] * ch.buf[n - k] as f64;
                }
                let ae = (e as f32).abs();
                let level = ch.scale.max(1e-5);
                if ch.ready && ae > self.k * level {
                    match &mut ch.region {
                        None => ch.region = Some((n - 2, n + 3)),
                        Some((s, end)) => {
                            if n + 3 > *end && n + 3 - *s <= self.max_w {
                                *end = n + 3;
                            }
                        }
                    }
                }
                ch.scale += (ae.min(3.0 * level) - ch.scale) * track;
                if let Some((s, end)) = ch.region {
                    if n + 1 >= end + RCTX {
                        let lo = s - LCTX;
                        let ok = self.lsar.repair(&mut ch.buf[lo..end + RCTX], LCTX, end - s, self.order.min(2 * (end - s) + 16), LCTX);
                        if ok {
                            self.repaired += 1;
                        }
                        ch.region = None;
                    }
                }
                *x = ch.buf[n - LATENCY];
                ch.since += 1;
                if ch.since >= DET_WIN {
                    ch.since = 0;
                    let seg = &ch.buf[n + 1 - DET_WIN..n + 1];
                    let p = self.lsar.burg(seg, &[], DET_ORDER);
                    if p == DET_ORDER {
                        for k in 0..=DET_ORDER {
                            ch.a[k] = self.lsar.a[k];
                        }
                        if !ch.ready {
                            // Seed the error level from this window before detecting anything.
                            let mut sum = 0.0f32;
                            for i in n + 1 - DET_WIN + DET_ORDER..n + 1 {
                                let mut e = 0.0f64;
                                for k in 0..=DET_ORDER {
                                    e += ch.a[k] * ch.buf[i - k] as f64;
                                }
                                sum += (e as f32).abs();
                            }
                            ch.scale = sum / (DET_WIN - DET_ORDER) as f32;
                            ch.ready = true;
                        }
                    }
                }
                if ch.w == CAP {
                    let shift = CAP - KEEP;
                    ch.buf.copy_within(shift..CAP, 0);
                    ch.w = KEEP;
                    if let Some((s, end)) = ch.region {
                        ch.region = Some((s - shift, end - shift));
                    }
                }
            }
        }
    }

    fn reset(&mut self) {
        for ch in &mut self.chans {
            ch.buf.iter_mut().for_each(|v| *v = 0.0);
            ch.w = KEEP;
            ch.a = [0.0; DET_ORDER + 1];
            ch.a[0] = 1.0;
            ch.since = 0;
            ch.scale = 0.0;
            ch.ready = false;
            ch.region = None;
        }
    }

    fn latency(&self) -> u32 {
        LATENCY as u32
    }
}

/// Offline click/pop elimination settings.
pub struct DeclickSettings {
    /// Detection threshold in multiples of the residual's robust level.
    pub k: f32,
    /// Runs whose peak error is below `disc` times the level are left alone.
    pub disc: f32,
    /// Longest run repaired (samples).
    pub max_run: usize,
    /// Extra samples repaired on each side, as a fraction of the run length.
    pub oversample: f32,
    /// Number of detect-and-repair passes.
    pub passes: usize,
}

/// A detected click: `start..start + len` is the region to rebuild (with
/// oversampling), `peak` the strongest residual in multiples of the local
/// robust level.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClickRun {
    pub start: usize,
    pub len: usize,
    pub peak: f32,
}

const DET_BLOCK: usize = 2048;
const DET_ORDER_OFF: usize = 24;

/// Working buffers for click detection, reused across passes.
pub struct ClickScratch {
    resid: Vec<f32>,
    level: Vec<f32>,
    sorted: Vec<f32>,
    /// Robust residual level per detection block.
    meds: Vec<f32>,
}

impl ClickScratch {
    pub fn new(n: usize) -> ClickScratch {
        ClickScratch { resid: vec![0.0; n], level: vec![0.0; n], sorted: vec![0.0; DET_BLOCK], meds: Vec::new() }
    }
}

/// Finds clicks in `x` without changing it. Runs whose peak is below the
/// discrimination level, or that are too long to repair, are left out.
pub fn find_clicks(x: &[f32], s: &DeclickSettings, lsar: &mut Lsar, sc: &mut ClickScratch, out: &mut Vec<ClickRun>) {
    const B: usize = DET_BLOCK;
    const ORDER: usize = DET_ORDER_OFF;
    out.clear();
    let n = x.len();
    if n < 4 * ORDER {
        return;
    }
    let max_run = s.max_run.clamp(2, 1024);
    sc.meds.clear();
    let resid = &mut sc.resid;
    let level = &mut sc.level;
    let sorted = &mut sc.sorted;
    // Residual and robust level, block by block.
    let mut at = 0;
    while at < n {
        let end = (at + B).min(n);
        let lo = at.saturating_sub(B / 2);
        let hi = (end + B / 2).min(n);
        let p = lsar.burg(&x[lo..hi], &[], ORDER);
        for i in at..end {
            let mut e = 0.0f64;
            for k in 0..=p.min(i) {
                e += lsar.a[k] * x[i - k] as f64;
            }
            resid[i] = (e as f32).abs();
        }
        let m = end - at;
        sorted[..m].copy_from_slice(&resid[at..end]);
        sorted[..m].sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        sc.meds.push(sorted[m / 2] * 1.4826);
        at = end;
    }
    // A block's level is at least half its neighbours': where audio starts after
    // digital silence, the onset is not mistaken for a click against a level of zero.
    let meds = &sc.meds;
    for (b, &med) in meds.iter().enumerate() {
        let near = meds[b.saturating_sub(1)].max(*meds.get(b + 1).unwrap_or(&0.0));
        let lv = med.max(0.5 * near).max(1e-6);
        let (a, e) = (b * B, ((b + 1) * B).min(n));
        for v in &mut level[a..e] {
            *v = lv;
        }
    }
    // Group detections into runs.
    let mut i = ORDER;
    while i < n {
        if resid[i] <= s.k * level[i] {
            i += 1;
            continue;
        }
        let start = i;
        let mut end = i + 1;
        let mut peak = resid[i] / level[i];
        let mut j = i + 1;
        // Merge detections closer than the AR order (the error rings for `ORDER` samples).
        while j < n && j < end + ORDER / 2 {
            if resid[j] > s.k * level[j] {
                end = j + 1;
                peak = peak.max(resid[j] / level[j]);
            }
            j += 1;
        }
        i = end + 1;
        // The error after a click includes the predictor's ringing; trim it.
        let len = (end - start).max(1);
        let core_end = start + len.min(len.saturating_sub(ORDER / 2).max(2));
        let pad = ((core_end - start) as f32 * s.oversample).ceil() as usize + 1;
        let a = start.saturating_sub(pad);
        let b = (core_end + pad).min(n);
        let l = b - a;
        if peak < s.disc || l > max_run * 2 + 16 || l > lsar.max_gap {
            continue;
        }
        out.push(ClickRun { start: a, len: l, peak });
    }
}

/// A least-squares AR interpolator sized for the settings.
pub fn click_lsar(s: &DeclickSettings) -> Lsar {
    let max_run = s.max_run.clamp(2, 1024);
    Lsar::new(max_run * 2 + 16, 80, 1024 + 2 * DET_BLOCK)
}

/// Repairs clicks in `x` in place; returns the number of repaired runs.
pub fn declick(x: &mut [f32], s: &DeclickSettings) -> usize {
    let n = x.len();
    if n < 4 * DET_ORDER_OFF {
        return 0;
    }
    let mut lsar = click_lsar(s);
    let mut sc = ClickScratch::new(n);
    let mut runs = Vec::new();
    let mut total = 0;
    for _ in 0..s.passes.max(1) {
        find_clicks(x, s, &mut lsar, &mut sc, &mut runs);
        let mut repaired = 0;
        for r in &runs {
            let order = (3 * r.len + 2).clamp(16, 80);
            if lsar.repair(x, r.start, r.len, order, 512) {
                repaired += 1;
            }
        }
        total += repaired;
        if repaired == 0 {
            break;
        }
    }
    total
}

/// Longest gap `fill_gap` rebuilds (samples).
pub const MAX_FILL: usize = 4096;

/// Rebuilds `x[s .. s + l]` from its surroundings with an AR model whose
/// order grows with the gap. Gaps longer than `MAX_FILL` are left alone.
pub fn fill_gap(x: &mut [f32], s: usize, l: usize) -> bool {
    if l == 0 || l > MAX_FILL || s + l > x.len() {
        return false;
    }
    let order = (3 * l + 2).clamp(16, 80);
    let ctx = 512.max(4 * order);
    let mut lsar = Lsar::new(l, 80, 2 * ctx);
    lsar.repair(x, s, l, order, ctx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fx::testutil::*;

    fn music(n: usize, rate: f32) -> Vec<f32> {
        let a = sine(330.0, rate, n, 0.3);
        let b = sine(1210.0, rate, n, 0.15);
        let r = noise(n, 0.01, 77);
        (0..n).map(|i| a[i] + b[i] + r[i]).collect()
    }

    fn add_clicks(x: &[f32], every: usize) -> Vec<f32> {
        let mut y = x.to_vec();
        let mut i = 1000;
        let mut sign = 1.0;
        while i + 4 < y.len() {
            y[i] += 0.6 * sign;
            y[i + 1] -= 0.4 * sign;
            y[i + 2] += 0.3 * sign;
            sign = -sign;
            i += every;
        }
        y
    }

    #[test]
    fn realtime_removes_clicks_and_leaves_clean_audio_alone() {
        let rate = 48000.0;
        let clean = music(48000, rate);
        let mut fx = make(136, rate, 1);
        let lat = fx.latency() as usize;
        let y = run_mono(fx.as_mut(), &clean);
        for i in lat..clean.len() {
            assert!((y[i] - clean[i - lat]).abs() < 1e-6, "changed clean audio at {i}");
        }
        let clicky = add_clicks(&clean, 3001);
        let mut fx = make(136, rate, 1);
        let y = run_mono(fx.as_mut(), &clicky);
        let range = 2000..clean.len() - lat;
        let err_in: f32 = range.clone().map(|i| (clicky[i] - clean[i]).powi(2)).sum();
        let err_out: f32 = range.clone().map(|i| (y[i + lat] - clean[i]).powi(2)).sum();
        assert!(err_out < err_in * 0.05, "error {err_out} vs {err_in}");
    }

    #[test]
    fn offline_declick_repairs_runs() {
        let rate = 48000.0;
        let clean = music(48000, rate);
        let clicky = add_clicks(&clean, 2500);
        let mut y = clicky.clone();
        let s = DeclickSettings { k: 8.0, disc: 10.0, max_run: 64, oversample: 0.5, passes: 2 };
        let count = declick(&mut y, &s);
        assert!(count >= 15, "repaired {count}");
        let err: f32 = (0..clean.len()).map(|i| (y[i] - clean[i]).powi(2)).sum::<f32>();
        let before: f32 = (0..clean.len()).map(|i| (clicky[i] - clean[i]).powi(2)).sum::<f32>();
        assert!(err < before * 0.05, "{err} vs {before}");
        // Clean audio is left alone.
        let mut c = clean.clone();
        assert_eq!(declick(&mut c, &s), 0);
    }

    #[test]
    fn fill_gap_rebuilds_a_damaged_stretch() {
        let rate = 48000.0;
        let clean = music(8000, rate);
        let mut y = clean.clone();
        for i in 4000..4040 {
            y[i] = 0.8;
        }
        assert!(fill_gap(&mut y, 4000, 40));
        let err: f32 = (4000..4040).map(|i| (y[i] - clean[i]).abs()).fold(0.0, f32::max);
        assert!(err < 0.05, "max error {err}");
        assert!(y[..4000] == clean[..4000] && y[4040..] == clean[4040..]);
        assert!(!fill_gap(&mut y, 10, MAX_FILL + 1));
    }

    #[test]
    fn find_clicks_reports_runs_without_changing_audio() {
        let rate = 48000.0;
        let clean = music(48000, rate);
        let clicky = add_clicks(&clean, 2500);
        let s = DeclickSettings { k: 8.0, disc: 10.0, max_run: 64, oversample: 0.5, passes: 1 };
        let mut lsar = click_lsar(&s);
        let mut sc = ClickScratch::new(clicky.len());
        let mut runs = Vec::new();
        find_clicks(&clicky, &s, &mut lsar, &mut sc, &mut runs);
        assert!(runs.len() >= 15, "found {}", runs.len());
        // Every click position (1000 + k * 2500) lies inside a reported run.
        let mut at = 1000;
        while at + 4 < clicky.len() {
            assert!(runs.iter().any(|r| r.start <= at && at < r.start + r.len), "missed click at {at}");
            at += 2500;
        }
        assert!(runs.iter().all(|r| r.peak >= s.disc));
        find_clicks(&clean, &s, &mut lsar, &mut sc, &mut runs);
        assert!(runs.is_empty(), "false positives: {}", runs.len());
    }
}
