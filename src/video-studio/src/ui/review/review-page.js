/**
 * The review screen people open from an invite link (#review=...): the
 * video with frame-accurate timecode at the review's frame rate, a strip
 * with comment markers, a comment box that pins comments to the current
 * frame (or a short range), threads with replies, and a version picker.
 *
 * Keys: Space play or pause, K pause, J and L (or the arrow keys) step one
 * frame (Shift: ten), C comment at the current frame.
 */
import '../../styles/review.css';
import { h, announce, clamp } from '../../lib/dom.js';
import { icon, appIcon } from '../../lib/icons.js';
import { ReviewSession } from '../../review/session.js';
import { threadsFor, threadCounts, threadOf } from '../../review/comments.js';
import { canComment, ROLE_LABELS, LIMITS, textProblem, workerURL } from '../../review/protocol.js';
import { reviewFps, reviewTimecode, stepFrames, seekSeconds, fromSeconds, snapToFrame, stripMarkers, spokenAt, frameStart, frameAt } from '../../review/time.js';
import { createThreadList, submitForm } from './threads.js';
import { confirmDialog, toast } from '../dialog.js';

/** The hash a review is reopened with: no invite token (it was used already). */
export function cleanReviewHash(review, server) {
  return `#review=${encodeURIComponent(review)}&server=${encodeURIComponent(new URL(workerURL(server)).host)}`;
}

export class ReviewPage {
  /**
   * opts: { puter, account, link: { review, server, token }, onHome, interval, Session }
   */
  constructor(root, { puter, account = null, link, onHome = null, onSignedIn = null, interval = 8000, Session = ReviewSession } = {}) {
    this.root = root;
    this.puter = puter;
    this.account = account;
    this.link = link;
    this.onHome = onHome;
    this.onSignedIn = onSignedIn;
    this.interval = interval;
    this.Session = Session;
    this.session = null;
    this.version = 0;
    this.t = 0;
    this.showResolved = true;
    this.activeId = null;
    this.pin = { t: 0, end: null, held: false };
    this._disposers = [];
    this._linkTries = 0;
    document.title = 'Review - Video Studio';
    this.start();
  }

  splash(...children) {
    this.root.removeAttribute('aria-busy');
    this.root.replaceChildren(h('main#main.splash.rv-splash', appIcon(48), ...children));
  }

  async start() {
    const { puter } = this;
    if (!puter) {
      this.splash(h('h1.splash-title', 'Sign in needed'), h('p.splash-sub', 'Reviews open in Video Studio with a Puter account. Open this link where Puter is available.'));
      return;
    }
    if (puter.env !== 'app' && !puter.auth.isSignedIn()) {
      const btn = h('button.btn.primary', { type: 'button' }, 'Sign in with Puter');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await puter.auth.signIn();
          if (this.onSignedIn) this.onSignedIn();
          else this.start();
        } catch {
          btn.disabled = false;
        }
      });
      this.splash(h('h1.splash-title', 'You are invited to review a video'), h('p.splash-sub', 'Sign in with Puter to watch it and leave comments. Your Puter username is shown next to your comments.'), btn);
      return;
    }
    this.root.setAttribute('aria-busy', 'true');
    this.root.replaceChildren(h('div.splash', { role: 'status' }, appIcon(56), h('div.spinner'), h('p', 'Opening review...')));
    const { review, server, token } = this.link;
    try {
      this.session = new this.Session({ puter, server, review, interval: this.interval });
      await this.session.open({ token });
    } catch (err) {
      this.session?.dispose();
      this.session = null;
      const retry = h('button.btn', { type: 'button' }, 'Try again');
      retry.addEventListener('click', () => this.start());
      const home = this.onHome ? h('button.btn', { type: 'button' }, 'Go to my projects') : null;
      home?.addEventListener('click', () => this.onHome());
      this.splash(h('h1.splash-title', err.status === 403 || err.status === 404 ? 'This review is not available' : 'Could not open the review'), h('p.splash-sub', err?.message || 'Something went wrong.'), h('div.rv-splash-actions', err.status === 403 || err.status === 404 ? null : retry, home));
      return;
    }
    // The invite was used: keep it out of the address bar and history.
    if (token && typeof history !== 'undefined') history.replaceState(null, '', `${location.pathname}${location.search}${cleanReviewHash(review, server)}`);
    this.version = this.session.latest;
    this.build();
    this.session.start(this.interval);
  }

  get review() {
    return this.session?.review;
  }

  get current() {
    return this.session?.version(this.version) || null;
  }

  get fps() {
    return reviewFps(this.current?.fps);
  }

  get duration() {
    return Math.max(0, Math.round(Number(this.current?.duration) || 0));
  }

  build() {
    const s = this.session;
    const r = s.review;
    this.root.removeAttribute('aria-busy');
    document.title = `${r.title} - Review - Video Studio`;

    /* Header */
    this.versionSelect = h('select.select.rv-version', { 'aria-label': 'Version' });
    this.versionSelect.addEventListener('change', () => this.setVersion(Number(this.versionSelect.value)));
    const who = h('span.rv-who', icon('user', 14), s.me.username);
    const home = this.onHome ? h('button.icon-btn', { type: 'button', 'aria-label': 'My projects', 'data-tip': 'My projects' }, icon('home', 18)) : null;
    home?.addEventListener('click', () => this.onHome());
    this.roleNote = h('p.rv-sub');
    const header = h('header.rv-header', { role: 'banner' },
      h('div.rv-brand', appIcon(28)),
      h('div.rv-heading', h('h1.rv-title', r.title), this.roleNote),
      h('div.rv-header-end', this.versionSelect, who, home));

    /* Player */
    this.video = h('video.rv-video', { playsInline: true, preload: 'auto', 'aria-label': 'Review video' });
    this.video.setAttribute('playsinline', '');
    this.videoState = h('div.rv-video-state', { role: 'status' });
    this.bigPlay = h('button.rv-bigplay', { type: 'button', 'aria-label': 'Play' }, icon('play', 36));
    this.bigPlay.addEventListener('click', () => this.toggle());
    this.video.addEventListener('click', () => this.toggle());
    const wrap = h('div.rv-video-wrap', this.video, this.bigPlay, this.videoState);

    this.stripFill = h('div.rv-strip-fill');
    this.stripHead = h('div.rv-strip-head');
    this.stripMarks = h('div.rv-strip-marks');
    this.strip = h('div.rv-strip', { role: 'slider', tabindex: '0', 'aria-label': 'Position', 'aria-valuemin': '0', 'data-own-arrows': '' }, h('div.rv-strip-track', this.stripFill), this.stripHead);
    // Comment markers sit over the slider, not inside it (controls cannot nest).
    const stripWrap = h('div.rv-strip-wrap', this.strip, this.stripMarks);
    this._wireStrip();

    this.playBtn = h('button.icon-btn.rv-play', { type: 'button', 'aria-label': 'Play', 'data-space-plays': '' }, icon('play', 20));
    this.playBtn.addEventListener('click', () => this.toggle());
    const back = h('button.icon-btn', { type: 'button', 'aria-label': 'Previous frame', title: 'Previous frame (J or Left arrow)' }, icon('stepBack', 18));
    back.addEventListener('click', () => this.step(-1));
    const fwd = h('button.icon-btn', { type: 'button', 'aria-label': 'Next frame', title: 'Next frame (L or Right arrow)' }, icon('stepForward', 18));
    fwd.addEventListener('click', () => this.step(1));
    this.tcEl = h('span.rv-timecode', { 'aria-live': 'off' });
    this.durEl = h('span.rv-duration');
    this.muteBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Mute' }, icon('volume', 18));
    this.muteBtn.addEventListener('click', () => {
      this.video.muted = !this.video.muted;
      this.muteBtn.replaceChildren(icon(this.video.muted ? 'mute' : 'volume', 18));
      this.muteBtn.setAttribute('aria-label', this.video.muted ? 'Unmute' : 'Mute');
    });
    const controls = h('div.rv-controls', back, this.playBtn, fwd, h('div.rv-tc', this.tcEl, h('span.rv-tc-sep', '/'), this.durEl), h('span.spacer'), this.muteBtn);
    const stage = h('section.rv-stage', { 'aria-label': 'Video' }, wrap, stripWrap, controls);

    /* Comments */
    // The comment box is made once the person can comment (also when a role is raised later).
    this.composer = null;
    this.viewerNote = h('p.rv-note', 'You can watch this review and read comments.');
    this.countEl = h('h2.rv-count');
    const resolvedId = 'rv-show-resolved';
    const showResolved = h('input', { type: 'checkbox', id: resolvedId, checked: this.showResolved });
    showResolved.addEventListener('change', () => {
      this.showResolved = showResolved.checked;
      this.renderComments();
    });
    this.threadList = createThreadList({
      onSeek: (t) => this.seekToComment(t),
      onReply: (t, text) => s.addComment({ version: t.version, parent: t.id, text }).then(() => announce('Reply posted')),
      onResolve: (t, resolved) => s.resolve(t.id, resolved).then(() => announce(resolved ? 'Resolved' : 'Reopened'), (err) => toast(err.message, { kind: 'error' })),
      onEdit: (c, text) => s.editComment(c.id, text),
      onDelete: async (c) => {
        if (!(await confirmDialog({ title: 'Delete comment', message: 'Delete this comment? This cannot be undone.', confirm: 'Delete', danger: true }))) return;
        s.deleteComment(c.id).catch((err) => toast(err.message, { kind: 'error' }));
      },
    });
    this.syncNote = h('p.rv-sync', { role: 'status' });
    const side = h('aside.rv-side', { 'aria-label': 'Comments' },
      this.viewerNote,
      h('div.rv-list-head', this.countEl, h('label.rv-toggle', { for: resolvedId }, showResolved, 'Show resolved')),
      this.threadList.el,
      this.syncNote);

    this.side = side;
    this.el = h('div.rv-page', header, h('main#main.rv-body', { tabindex: '-1' }, stage, side));
    this.root.replaceChildren(this.el);

    this._wireVideo();
    this._onKey = (e) => this.onKey(e);
    document.addEventListener('keydown', this._onKey);
    this._disposers.push(() => document.removeEventListener('keydown', this._onKey));
    this._disposers.push(s.on('change', () => this.renderComments()));
    this._disposers.push(s.on('review', () => this.renderHeader()));
    this._disposers.push(s.on('synced', () => (this.syncNote.textContent = '')));
    this._disposers.push(s.on('error', (err) => {
      if (err.status === 403 || err.status === 404) {
        // Removed from the review, or it is gone: stop asking and stop offering to comment.
        s.stop();
        this.video.pause();
        if (this.composer) this.composer.el.hidden = true;
        this.syncNote.textContent = err.message;
        this.el.classList.add('rv-closed');
        return;
      }
      this.syncNote.textContent = 'Could not check for new comments. Retrying...';
    }));
    this.renderHeader();
    this.setVersion(this.version, { force: true });
  }

  renderHeader() {
    const s = this.session;
    const r = s.review;
    this.el.querySelector('.rv-title').textContent = r.title;
    this.roleNote.textContent = `Shared by ${r.owner.username}. ${ROLE_LABELS[s.role] || ''}.`;
    const latest = s.latest;
    this.versionSelect.replaceChildren(...[...r.versions].reverse().map((v) => {
      const c = threadCounts(s.comments, v.n);
      return h('option', { value: String(v.n) }, `Version ${v.n}${v.n === latest ? ' (latest)' : ''}${c.total ? `, ${c.total} comment${c.total === 1 ? '' : 's'}` : ''}`);
    }));
    this.versionSelect.value = String(this.version);
    this.versionSelect.hidden = r.versions.length < 2;
    const can = canComment(s.role) && !this.el.classList.contains('rv-closed');
    if (can && !this.composer) {
      this.composer = this._buildComposer();
      this.side.prepend(this.composer.el);
      this.composer.follow();
    }
    if (this.composer) this.composer.el.hidden = !can;
    this.viewerNote.hidden = canComment(s.role);
  }

  async setVersion(n, { force = false } = {}) {
    if (!force && n === this.version) return;
    this.version = n;
    this.activeId = null;
    this.t = 0;
    this._linkTries = 0;
    this.versionSelect.value = String(n);
    this.strip.setAttribute('aria-valuemax', String(Math.round(this.duration / 1e6)));
    this.durEl.textContent = reviewTimecode(this.duration, this.fps);
    this.renderComments();
    this.renderTime();
    await this.loadVideo();
  }

  async loadVideo({ fresh = false } = {}) {
    const n = this.version;
    this.videoState.textContent = 'Loading video...';
    this.videoState.hidden = false;
    try {
      const link = await this.session.videoLink(n, { fresh });
      if (n !== this.version) return;
      this.video.src = link.url;
    } catch (err) {
      this.videoState.textContent = err?.message || 'The video could not be loaded.';
    }
  }

  _wireVideo() {
    const v = this.video;
    const onFrame = (_now, meta) => {
      this.t = fromSeconds(meta?.mediaTime ?? v.currentTime);
      this.renderTime();
      if (!v.paused) this._rvfc = v.requestVideoFrameCallback(onFrame);
    };
    const tick = () => {
      if (v.requestVideoFrameCallback) {
        this._rvfc = v.requestVideoFrameCallback(onFrame);
        return;
      }
      const loop = () => {
        this.t = fromSeconds(v.currentTime);
        this.renderTime();
        if (!v.paused) this._raf = requestAnimationFrame(loop);
      };
      loop();
    };
    const on = (type, fn) => {
      v.addEventListener(type, fn);
      this._disposers.push(() => v.removeEventListener(type, fn));
    };
    on('loadeddata', () => {
      this.videoState.hidden = true;
      this._linkTries = 0;
    });
    on('waiting', () => {
      this.videoState.textContent = 'Loading...';
      this.videoState.hidden = false;
    });
    on('playing', () => (this.videoState.hidden = true));
    on('play', () => {
      this._played = true;
      this.renderPlay();
      tick();
    });
    on('pause', () => {
      this.renderPlay();
      this.t = snapToFrame(fromSeconds(v.currentTime), this.fps);
      this.renderTime();
    });
    on('seeked', () => {
      if (v.paused) this.t = snapToFrame(fromSeconds(v.currentTime), this.fps);
      this.renderTime();
    });
    // A fallback while playing where frame callbacks are throttled (background tabs).
    on('timeupdate', () => {
      if (v.paused) return;
      this.t = fromSeconds(v.currentTime);
      this.renderTime();
    });
    on('ended', () => this.renderPlay());
    on('error', () => {
      // An expired or revoked link: ask for the current one once.
      if (this._linkTries++ < 1) this.loadVideo({ fresh: true });
      else {
        this.videoState.textContent = 'The video could not be played in this browser.';
        this.videoState.hidden = false;
      }
    });
  }

  _wireStrip() {
    const strip = this.strip;
    const at = (clientX) => {
      const r = strip.getBoundingClientRect();
      return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1) * this.duration;
    };
    strip.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.rv-mark')) return;
      e.preventDefault();
      strip.setPointerCapture?.(e.pointerId);
      this.seek(at(e.clientX));
      const move = (ev) => this.seek(at(ev.clientX));
      const up = () => {
        strip.removeEventListener('pointermove', move);
        strip.removeEventListener('pointerup', up);
        strip.removeEventListener('pointercancel', up);
      };
      strip.addEventListener('pointermove', move);
      strip.addEventListener('pointerup', up);
      strip.addEventListener('pointercancel', up);
    });
    strip.addEventListener('keydown', (e) => {
      const n = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') this.step(-n);
      else if (e.key === 'ArrowRight') this.step(n);
      else if (e.key === 'Home') this.seek(0);
      else if (e.key === 'End') this.seek(this.duration);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  /** Show the frame at time t (microseconds). */
  seek(t) {
    const target = clamp(Math.round(t), 0, this.duration);
    this.t = snapToFrame(target, this.fps);
    if (this.video.readyState >= 1) this.video.currentTime = Math.min(seekSeconds(this.t, this.fps), Math.max(0, this.duration / 1e6 - 0.001));
    this.renderTime();
  }

  step(n) {
    const from = this.t;
    this.video.pause();
    this.seek(stepFrames(from, n, this.fps, this.duration));
  }

  toggle() {
    if (this.video.paused) {
      if (this.video.ended || this.t >= this.duration) this.seek(0);
      this.video.play().catch(() => {});
    } else this.video.pause();
  }

  seekToComment(thread) {
    if (thread.version !== this.version) {
      this.setVersion(thread.version).then(() => this.seekToComment(thread));
      return;
    }
    this.video.pause();
    this.activeId = thread.id;
    this.seek(thread.t ?? 0);
    this.renderComments();
    this.threadList.scrollTo(thread.id);
    announce(`At ${spokenAt(thread.t ?? 0)}`);
  }

  renderPlay() {
    const paused = this.video.paused;
    this.playBtn.replaceChildren(icon(paused ? 'play' : 'pause', 20));
    this.playBtn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    // Only before the first playback: afterwards it would cover the frame being reviewed.
    this.bigPlay.hidden = !paused || this._played;
  }

  renderTime() {
    const fps = this.fps;
    const tc = reviewTimecode(this.t, fps);
    this.tcEl.textContent = tc;
    const frac = this.duration ? clamp(this.t / this.duration, 0, 1) : 0;
    this.stripFill.style.width = `${frac * 100}%`;
    this.stripHead.style.left = `${frac * 100}%`;
    this.strip.setAttribute('aria-valuenow', String(Math.round(this.t / 1e6)));
    this.strip.setAttribute('aria-valuetext', `${tc}, frame ${frameAt(this.t, fps)}`);
    this.composer?.follow();
  }

  renderComments() {
    if (!this.threadList) return;
    const s = this.session;
    const threads = threadsFor(s.comments, this.version, { showResolved: this.showResolved });
    const counts = threadCounts(s.comments, this.version);
    this.countEl.textContent = counts.total ? `${counts.open} open, ${counts.resolved} resolved` : 'Comments';
    this.threadList.update(threads, { fps: this.fps, me: s.me, role: s.role, activeId: this.activeId, empty: canComment(s.role) ? 'No comments yet. Pause on a frame and press C to add one.' : 'No comments yet.' });
    const all = threadsFor(s.comments, this.version);
    this.stripMarks.replaceChildren(...stripMarkers(all.filter((x) => !x.deleted), this.duration).map((m) => {
      const first = s.comments.get(m.ids[0]);
      const label = m.count > 1 ? `${m.count} comments at ${reviewTimecode(m.t, this.fps)}` : `Comment by ${first?.author?.username || 'someone'} at ${reviewTimecode(m.t, this.fps)}`;
      const b = h(`button.rv-mark${m.resolved ? '.resolved' : ''}${m.width ? '.range' : ''}`, { type: 'button', 'aria-label': label, title: label, style: { left: `${m.at * 100}%`, ...(m.width ? { width: `${m.width * 100}%` } : {}) } }, m.count > 1 ? h('span.rv-mark-count', String(m.count)) : null);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = threadOf(s.comments, m.ids[0]);
        if (t) this.seekToComment({ ...t, version: this.version });
      });
      return b;
    }));
    if (this.versionSelect) {
      // Keep the counts in the version picker current without rebuilding it while open.
      for (const o of this.versionSelect.options) {
        const n = Number(o.value);
        const c = threadCounts(s.comments, n);
        o.textContent = `Version ${n}${n === s.latest ? ' (latest)' : ''}${c.total ? `, ${c.total} comment${c.total === 1 ? '' : 's'}` : ''}`;
      }
    }
  }

  _buildComposer() {
    const page = this;
    const pinBtn = h('button.rv-pin-time', { type: 'button', title: 'Go to this time' });
    const repin = h('button.rv-action', { type: 'button' }, icon('mapPin', 14), 'Use current frame');
    const rangeId = 'rv-range';
    const rangeBox = h('input', { type: 'checkbox', id: rangeId });
    const endBtn = h('button.rv-pin-time', { type: 'button', title: 'Go to the end time', hidden: true });
    const setEnd = h('button.rv-action', { type: 'button', hidden: true }, 'Set end to current frame');
    const text = h('textarea.input.rv-textarea.rv-compose-text', { rows: 3, maxLength: LIMITS.text, placeholder: 'Comment on this frame', 'aria-label': 'Comment' });
    const err = h('p.rv-form-error', { role: 'alert' });
    const counter = h('span.rv-counter');
    const post = h('button.btn.primary', { type: 'submit' }, icon('send', 15), 'Post');
    const el = h('form.rv-composer', { 'aria-label': 'Add a comment' },
      h('div.rv-pin', h('span.rv-pin-label', 'At'), pinBtn, repin),
      h('div.rv-pin', h('label.rv-toggle', { for: rangeId }, rangeBox, 'Until'), endBtn, setEnd),
      text,
      h('div.rv-compose-foot', h('span.rv-hint', 'C comments at the current frame. Ctrl+Enter posts.'), counter, post),
      err);
    const pin = this.pin;
    const render = () => {
      pinBtn.textContent = reviewTimecode(pin.t, page.fps);
      pinBtn.setAttribute('aria-label', `Comment time ${reviewTimecode(pin.t, page.fps)}. Go there`);
      endBtn.hidden = setEnd.hidden = !rangeBox.checked;
      if (pin.end !== null) endBtn.textContent = reviewTimecode(pin.end, page.fps);
      const n = text.value.length;
      counter.textContent = n > LIMITS.text - 200 ? `${LIMITS.text - n} left` : '';
    };
    const pinHere = () => {
      pin.t = snapToFrame(page.t, page.fps);
      if (pin.end !== null && pin.end <= pin.t) pin.end = Math.min(page.duration, pin.t + frameStart(Math.round(page.fps), page.fps));
      render();
    };
    const endHere = () => {
      const t = snapToFrame(page.t, page.fps);
      if (t > pin.t) pin.end = t;
      else {
        pin.end = pin.t;
        pin.t = t;
        if (pin.end === pin.t) pin.end = Math.min(page.duration, pin.t + frameStart(Math.round(page.fps), page.fps));
      }
      render();
    };
    pinBtn.addEventListener('click', () => page.seek(pin.t));
    endBtn.addEventListener('click', () => pin.end !== null && page.seek(pin.end));
    repin.addEventListener('click', () => {
      pin.held = true;
      pinHere();
    });
    setEnd.addEventListener('click', endHere);
    rangeBox.addEventListener('change', () => {
      pin.held = true;
      if (rangeBox.checked) {
        pin.end = null;
        const t = snapToFrame(page.t, page.fps);
        pin.end = t > pin.t ? t : Math.min(page.duration, pin.t + frameStart(Math.round(page.fps), page.fps));
      } else pin.end = null;
      render();
    });
    text.addEventListener('input', () => {
      if (text.value && !pin.held) {
        pin.held = true;
        pinHere();
      }
      if (!text.value && !rangeBox.checked) pin.held = false;
      err.textContent = '';
      render();
    });
    text.addEventListener('focus', () => page.video.pause());
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitForm(el);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        text.blur();
      }
    });
    el.addEventListener('submit', async (e) => {
      e.preventDefault();
      const problem = textProblem(text.value);
      if (problem) {
        err.textContent = problem;
        text.focus();
        return;
      }
      const body = text.value;
      const t = pin.t;
      const end = rangeBox.checked && pin.end !== null && pin.end > pin.t ? pin.end : null;
      post.disabled = true;
      text.value = '';
      try {
        await page.session.addComment({ version: page.version, text: body, t, end });
        rangeBox.checked = false;
        pin.end = null;
        pin.held = false;
        pinHere();
        announce('Comment posted');
      } catch (error) {
        text.value = body;
        err.textContent = error?.message || 'Could not post the comment.';
      } finally {
        post.disabled = false;
      }
    });
    render();
    return {
      el,
      text,
      /** While nothing is written, the pin follows the playhead. */
      follow() {
        if (!pin.held) pinHere();
      },
      startHere() {
        pin.held = true;
        pinHere();
        text.focus();
      },
    };
  }

  onKey(e) {
    if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t.matches?.('input:not([type=checkbox]), textarea, select, [contenteditable="true"]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const n = e.shiftKey ? 10 : 1;
    if (key === ' ') {
      // Space presses a focused control (a button, a checkbox...) instead of playing.
      if (t.matches?.('button, a, input, summary, [role=button], [role=checkbox], [role=switch], [role=radio], [role=tab], [role=option], [role=menuitem]') && !t.closest('[data-space-plays]')) return;
      this.toggle();
    } else if (key === 'k') this.video.pause();
    else if (key === 'j' || (key === 'ArrowLeft' && !t.closest?.('[data-own-arrows]'))) this.step(-n);
    else if (key === 'l' || (key === 'ArrowRight' && !t.closest?.('[data-own-arrows]'))) this.step(n);
    else if (key === 'c' && this.composer && !this.composer.el.hidden) {
      this.video.pause();
      this.composer.startHere();
    } else return;
    e.preventDefault();
  }

  dispose() {
    for (const d of this._disposers.splice(0)) d();
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._rvfc && this.video?.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this._rvfc);
    this.video?.pause?.();
    this.video?.removeAttribute('src');
    this.session?.dispose();
  }
}
