import { Emitter } from '../lib/emitter.js';

/** What to tell the user when a device can't be acquired. */
const DEVICE_ERRORS = Object.freeze({
  audio: 'Microphone unavailable. Check permissions or pick another device.',
  video: 'Camera unavailable. Check permissions or pick another device.',
  both: 'Camera and microphone are unavailable. Check browser permissions.',
});

/**
 * LocalMedia — owns the user's camera, microphone, and screen capture.
 *
 * Design notes:
 *  - Mic mute toggles `track.enabled` (fast, keeps the track warm).
 *  - Camera off *stops* the video track so the camera light turns off,
 *    like Google Meet; turning it back on re-acquires the device.
 *  - `stream` is a stable MediaStream instance for camera+mic. Its id is
 *    announced to peers, so tracks are added/removed in place.
 *  - Background effects (blur / image replacement) process the raw
 *    camera track through BackgroundEffect and put the *processed* track
 *    into `stream`; the raw track stays private and keeps the device
 *    warm. The camera shows unprocessed for the moment the effect takes
 *    to start (instant once the engine is warm).
 *  - Noise suppression wraps the mic the same way: the raw track feeds
 *    a NoiseSuppression pipeline and the denoised track is published.
 *    Mute toggles the *published* track; the raw one keeps feeding the
 *    pipeline (audio never leaves the machine while muted).
 *
 * Events:
 *  - 'change'             {micOn, camOn}     toggles / availability
 *  - 'audio-track'        {track|null}       mic track replaced
 *  - 'video-track'        {track|null}       camera track replaced/removed
 *  - 'screen'             {on, stream|null}  screen share started/stopped
 *  - 'background'         {background}       background effect changed
 *  - 'noise-suppression'  {on}               denoising toggled
 *  - 'error'              {kind, error, message}
 */
export class LocalMedia extends Emitter {
  /** Stable camera+mic stream (announced to peers as kind 'camera'). */
  stream = new MediaStream();
  /** @type {MediaStream|null} */
  screenStream = null;
  /** @type {Promise<MediaStream>|null} a getDisplayMedia the user has yet to answer */
  #screenRequest = null;

  micOn = false;
  camOn = false;
  micId = undefined;
  camId = undefined;

  #closed = false;

  /** Active background spec ({type:'none'|'blur'|'image', ...}). */
  #background = { type: 'none' };
  /** @type {import('./background-effect.js').BackgroundEffect|null} */
  #effect = null;
  /** The unprocessed camera track (equals videoTrack when no effect). */
  #rawVideoTrack = null;
  /** Invalidates in-flight effect startups when the world changes. */
  #applySeq = 0;

  /** Whether ML noise suppression should be running. */
  #nsOn = false;
  /** @type {import('./noise-suppression.js').NoiseSuppression|null} */
  #nsEffect = null;
  /** The unprocessed mic track (equals audioTrack when no suppression). */
  #rawAudioTrack = null;
  /** Invalidates in-flight suppression startups when the world changes. */
  #nsSeq = 0;

  /**
   * One counter per device kind, bumped by every change the user asks for.
   * Acquiring a device is asynchronous — a permission prompt, a headset that
   * takes a second to open — and the user keeps clicking meanwhile: mute
   * after a pending unmute, a second device after a slow first one. Each
   * call notes the count as it starts and stands down if it has moved by the
   * time the device answers, so what the user did *last* is what holds — a
   * microphone must never end up hot because an older "on" landed late.
   */
  #seq = { audio: 0, video: 0 };

  get audioTrack() {
    return this.stream.getAudioTracks()[0] ?? null;
  }

  get videoTrack() {
    return this.stream.getVideoTracks()[0] ?? null;
  }

  get presenting() {
    return !!this.screenStream;
  }

  get background() {
    return this.#background;
  }

  get noiseSuppression() {
    return this.#nsOn;
  }

  /**
   * Acquire initial devices. Tolerates missing/denied devices: the app
   * proceeds with whatever was granted.
   */
  async init({ micId, camId, micOn = true, camOn = true } = {}) {
    this.micId = micId;
    this.camId = camId;

    // Always warm up the microphone — even when joining muted — so
    // unmuting mid-call is instant instead of hitting a permission
    // prompt; a muted mic is just a disabled track. The camera is only
    // acquired when it should be on (an off camera must not hold the
    // device or keep its light lit).
    try {
      // Ask for both at once first (single permission prompt).
      const gum = await navigator.mediaDevices.getUserMedia({
        audio: this.#audioConstraints(),
        video: camOn ? this.#videoConstraints() : false,
      });
      for (const track of gum.getTracks()) this.#adoptTrack(track);
    } catch (err) {
      // Fall back to acquiring independently, so one blocked device
      // doesn't take the other down with it. The retries stay quiet and
      // one message covers whatever ended up missing: a denied
      // permission prompt fails every request here, and three toasts
      // about a single "no" is noise, not information.
      const gotAudio = await this.#tryAcquire('audio', { quiet: true });
      const gotVideo = camOn ? await this.#tryAcquire('video', { quiet: true }) : true;
      if (!gotAudio || !gotVideo) {
        this.emit('error', {
          kind: !gotAudio && !gotVideo ? 'permissions' : gotAudio ? 'video' : 'audio',
          error: err,
          message: DEVICE_ERRORS[!gotAudio && !gotVideo ? 'both' : gotAudio ? 'video' : 'audio'],
        });
      }
    }

    this.micOn = !!this.audioTrack && micOn;
    this.camOn = !!this.videoTrack && camOn;
    if (this.audioTrack) this.audioTrack.enabled = this.micOn;
    this.emit('change', { micOn: this.micOn, camOn: this.camOn });
  }

  async setMicOn(on) {
    if (this.#closed) return;
    const seq = ++this.#seq.audio;
    // Judge health by the raw device track — with suppression running,
    // audioTrack is a pipeline output that stays 'live' even when the
    // mic itself died (e.g. unplugged).
    if (on && (!this.#rawAudioTrack || this.#rawAudioTrack.readyState !== 'live')) {
      await this.#tryAcquire('audio', { seq });
      if (seq !== this.#seq.audio) return; // the user decided otherwise meanwhile
    }
    if (this.audioTrack) {
      this.audioTrack.enabled = on;
      this.micOn = on && this.#rawAudioTrack?.readyState === 'live';
    } else {
      this.micOn = false;
    }
    this.emit('change', { micOn: this.micOn, camOn: this.camOn });
  }

  async setCamOn(on) {
    if (this.#closed) return;
    const seq = ++this.#seq.video;
    if (on) {
      // Judge health by the raw device track — with an effect running,
      // videoTrack is a canvas capture that stays 'live' even when the
      // camera itself died (e.g. unplugged).
      if (!this.#rawVideoTrack || this.#rawVideoTrack.readyState !== 'live') {
        this.#dropTrack('video');
        await this.#tryAcquire('video', { seq });
        if (seq !== this.#seq.video) return; // turned off again while it opened
      }
      this.camOn = !!this.videoTrack;
    } else {
      this.#dropTrack('video');
      this.camOn = false;
    }
    this.emit('change', { micOn: this.micOn, camOn: this.camOn });
  }

  async setMicDevice(deviceId) {
    if (this.#closed || deviceId === this.micId) return;
    this.micId = deviceId;
    const seq = ++this.#seq.audio;
    const hadTrack = !!this.audioTrack;
    if (hadTrack) this.#dropTrack('audio', /* silent */ true);
    await this.#tryAcquire('audio', { seq }); // also covers "mic was never acquired"
    if (seq !== this.#seq.audio) return; // a later pick owns the microphone now
    if (this.audioTrack) {
      this.audioTrack.enabled = this.micOn;
    } else if (hadTrack && this.micOn) {
      this.micOn = false;
      this.emit('change', { micOn: this.micOn, camOn: this.camOn });
    }
  }

  async setCamDevice(deviceId) {
    if (this.#closed || deviceId === this.camId) return;
    this.camId = deviceId;
    if (!this.camOn) return; // remembered for the next time the camera turns on
    const seq = ++this.#seq.video;
    this.#dropTrack('video');
    await this.#tryAcquire('video', { seq });
    if (seq !== this.#seq.video) return; // a later pick owns the camera now
    const gotIt = !!this.#rawVideoTrack && this.#rawVideoTrack.readyState === 'live';
    if (this.camOn !== gotIt) {
      this.camOn = gotIt;
      this.emit('change', { micOn: this.micOn, camOn: this.camOn });
    }
  }

  /**
   * Apply a background effect to the camera. Takes a *resolved* spec
   * (image specs must carry `src` — see resolveBackground()). Remembered
   * across camera off/on and device switches; applied whenever a camera
   * track is live.
   * @returns {Promise<boolean>} false when the effect failed to start
   *   (the background reverts to 'none' and an 'error' is emitted).
   */
  async setBackground(spec) {
    this.#background = spec ?? { type: 'none' };
    this.#applySeq++;

    if (this.#background.type === 'none') {
      this.#teardownBackground();
      this.emit('background', { background: this.#background });
      return true;
    }

    try {
      if (this.#effect) {
        // Same pipeline, new look — the published track doesn't change.
        await this.#effect.setSpec(this.#background);
      } else {
        await this.#applyBackground();
      }
      this.emit('background', { background: this.#background });
      return true;
    } catch (err) {
      // Back to no effect — in fact, not just in name. A pipeline that was
      // already running (a bad image chosen over a working blur) would
      // otherwise keep publishing the old look under a state that says
      // 'none', with the chooser showing nothing selected.
      this.#background = { type: 'none' };
      this.#teardownBackground();
      this.emit('background', { background: this.#background });
      this.emit('error', {
        kind: 'background',
        error: err,
        // A bad image is the user's file, not the browser — say which.
        message: /image/i.test(err?.message ?? '')
          ? 'That background image couldn’t be loaded.'
          : 'Background effects aren’t available in this browser.',
      });
      return false;
    }
  }

  /** Put the raw camera track back and tear the background pipeline down. */
  #teardownBackground() {
    if (!this.#effect) return;
    const processed = this.videoTrack;
    this.#effect.stop();
    this.#effect = null;
    if (processed) this.stream.removeTrack(processed);
    if (this.#rawVideoTrack?.readyState === 'live') {
      this.stream.addTrack(this.#rawVideoTrack);
      this.emit('video-track', { track: this.#rawVideoTrack });
    }
  }

  /**
   * Turn ML noise suppression (GTCRN) on or off. Remembered across
   * mic re-acquisition and device switches; applied whenever a mic
   * track is live.
   * @returns {Promise<boolean>} false when the pipeline failed to start
   *   (suppression reverts to off and an 'error' is emitted).
   */
  async setNoiseSuppression(on) {
    on = !!on;
    if (on === this.#nsOn) return true;
    this.#nsOn = on;
    this.#nsSeq++;

    if (!on) {
      this.#teardownNoiseSuppression();
      this.emit('noise-suppression', { on });
      return true;
    }

    try {
      await this.#applyNoiseSuppression();
      this.emit('noise-suppression', { on });
      return true;
    } catch (err) {
      this.#nsOn = false;
      this.emit('noise-suppression', { on: false });
      this.emit('error', {
        kind: 'noise-suppression',
        error: err,
        message: 'Noise suppression isn’t available in this browser.',
      });
      return false;
    }
  }

  /**
   * Start sharing the screen. Overlapping calls share one request: the
   * `screenStream` guard below only bites once a capture has landed, and
   * getDisplayMedia is outstanding for as long as the user takes over the
   * picker — so a second press would otherwise open a second picker and
   * leave whichever capture lost the race running, unreachable.
   */
  async startScreenShare() {
    if (this.screenStream) return this.screenStream;
    this.#screenRequest ??= this.#requestScreenShare();
    try {
      return await this.#screenRequest;
    } finally {
      this.#screenRequest = null;
    }
  }

  async #requestScreenShare() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 15, max: 30 },
        width: { max: 1920 },
        height: { max: 1080 },
      },
      audio: false,
      // Where supported, omit this meeting tab from the capture picker.
      selfBrowserSurface: 'exclude',
    });
    // Left the meeting while the picker was up: nothing will ever stop this
    // capture, and the browser would go on telling the user they are
    // sharing their screen with a call that is over.
    if (this.#closed) {
      for (const track of stream.getTracks()) track.stop();
      throw new Error('Screen sharing was cancelled.');
    }
    this.screenStream = stream;
    const [track] = stream.getVideoTracks();
    try {
      track.contentHint = 'detail'; // presentations: sharp text over framerate
    } catch {
      /* unsupported */
    }
    // User can stop sharing from the browser's own UI. Only act for the
    // capture we are actually publishing — an older one ending must not
    // take down its successor.
    track.addEventListener('ended', () => {
      if (this.screenStream === stream) this.stopScreenShare();
    });
    this.emit('screen', { on: true, stream });
    return stream;
  }

  stopScreenShare() {
    if (!this.screenStream) return;
    // Drop the reference before stopping tracks. MediaStreamTrack.stop()
    // fires 'ended' synchronously; the listener below would otherwise see
    // screenStream still set, re-enter, and emit 'screen' off twice —
    // which unpublishes and broadcasts state a second time for no reason.
    const stream = this.screenStream;
    this.screenStream = null;
    for (const track of stream.getTracks()) track.stop();
    this.emit('screen', { on: false, stream: null });
  }

  /** Enumerate devices, grouped by kind. */
  async listDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: devices.filter((d) => d.kind === 'audioinput'),
      cams: devices.filter((d) => d.kind === 'videoinput'),
      speakers: devices.filter((d) => d.kind === 'audiooutput'),
    };
  }

  /** Stop everything (leaving the meeting). */
  stopAll() {
    this.#closed = true;
    this.#applySeq++;
    this.#nsSeq++;
    this.stopScreenShare();
    this.#effect?.stop();
    this.#effect = null;
    this.#rawVideoTrack?.stop(); // may not be in `stream` while an effect runs
    this.#rawVideoTrack = null;
    this.#nsEffect?.stop();
    this.#nsEffect = null;
    this.#rawAudioTrack?.stop(); // may not be in `stream` while suppression runs
    this.#rawAudioTrack = null;
    for (const track of this.stream.getTracks()) {
      track.stop();
      this.stream.removeTrack(track);
    }
  }

  // ---- internals ----

  /**
   * Route the current raw camera track through the background pipeline
   * and swap the processed track into `stream`. Throws when the engine
   * can't start; no-ops when there is nothing to do.
   */
  async #applyBackground() {
    const spec = this.#background;
    const raw = this.#rawVideoTrack;
    if (!raw || raw.readyState !== 'live' || spec.type === 'none') return;

    const seq = this.#applySeq;
    const { BackgroundEffect } = await import('./background-effect.js');
    const effect = await BackgroundEffect.start(raw, spec);
    // The world may have moved on while the engine loaded (camera off,
    // device switched, background changed, meeting left).
    if (seq !== this.#applySeq || this.#closed || this.#rawVideoTrack !== raw) {
      effect.stop();
      return;
    }
    this.#effect = effect;
    this.stream.removeTrack(raw); // raw keeps running as the pipeline input
    this.stream.addTrack(effect.track);
    this.emit('video-track', { track: effect.track });
  }

  /** Fire-and-forget #applyBackground for track-lifecycle call sites. */
  #applyBackgroundSoon() {
    this.#applyBackground().catch((err) => {
      console.error('[media] background effect failed', err);
      this.#background = { type: 'none' };
      this.emit('background', { background: this.#background });
      this.emit('error', {
        kind: 'background',
        error: err,
        message: 'Background effects aren’t available in this browser.',
      });
    });
  }

  /**
   * Route the current raw mic track through the denoising pipeline and
   * swap the processed track into `stream`. Throws when the pipeline
   * can't start; no-ops when there is nothing to do.
   */
  async #applyNoiseSuppression() {
    const raw = this.#rawAudioTrack;
    if (!this.#nsOn || this.#nsEffect || !raw || raw.readyState !== 'live') return;

    const seq = this.#nsSeq;
    const { NoiseSuppression } = await import('./noise-suppression.js');
    const effect = await NoiseSuppression.start(raw);
    // The world may have moved on while the engine loaded (suppression
    // toggled, device switched, meeting left).
    if (seq !== this.#nsSeq || this.#closed || this.#rawAudioTrack !== raw) {
      effect.stop();
      return;
    }
    this.#nsEffect = effect;
    effect.track.enabled = raw.enabled; // carry the mute state over
    raw.enabled = true; // the pipeline input must always flow
    this.stream.removeTrack(raw); // raw keeps running as the pipeline input
    this.stream.addTrack(effect.track);
    this.emit('audio-track', { track: effect.track });
  }

  /** Fire-and-forget #applyNoiseSuppression for track-lifecycle call sites. */
  #applyNoiseSuppressionSoon() {
    this.#applyNoiseSuppression().catch((err) => {
      console.error('[media] noise suppression failed', err);
      this.#nsOn = false;
      this.emit('noise-suppression', { on: false });
      this.emit('error', {
        kind: 'noise-suppression',
        error: err,
        message: 'Noise suppression isn’t available in this browser.',
      });
    });
  }

  /** Put the raw mic track back and tear the pipeline down. */
  #teardownNoiseSuppression() {
    if (!this.#nsEffect) return;
    const processed = this.audioTrack;
    this.#nsEffect.stop();
    this.#nsEffect = null;
    if (processed) this.stream.removeTrack(processed);
    if (this.#rawAudioTrack?.readyState === 'live') {
      this.#rawAudioTrack.enabled = processed ? processed.enabled : this.micOn;
      this.stream.addTrack(this.#rawAudioTrack);
      this.emit('audio-track', { track: this.#rawAudioTrack });
    }
  }

  #audioConstraints() {
    return {
      deviceId: this.micId ? { exact: this.micId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      // Platform-backed denoising where available (Chrome); a bare boolean is
      // an "ideal" constraint, so unsupported browsers ignore it safely.
      voiceIsolation: true,
    };
  }

  #videoConstraints() {
    return {
      deviceId: this.camId ? { exact: this.camId } : undefined,
      width: { ideal: 1280 },
      height: { ideal: 720 },
    };
  }

  /**
   * Acquire one device kind, replacing whatever is there.
   * @param {'audio'|'video'} kind
   * @param {{quiet?: boolean, seq?: number}} [opts]
   *   quiet: suppress the 'error' event — the caller reports the outcome
   *     itself (see init(), which folds several failures into one).
   *   seq: the caller's turn (see #seq). A device that answers after a later
   *     call has moved the count on is stopped, not adopted: it belongs to a
   *     decision the user has since reversed.
   * @returns {Promise<boolean>} whether a track was acquired
   */
  async #tryAcquire(kind, { quiet = false, seq } = {}) {
    const current = () => seq === undefined || seq === this.#seq[kind];
    const acquire = async () => {
      const constraints =
        kind === 'audio' ? { audio: this.#audioConstraints() } : { video: this.#videoConstraints() };
      const gum = await navigator.mediaDevices.getUserMedia(constraints);
      if (!current() || this.#closed) {
        for (const track of gum.getTracks()) track.stop();
        return false;
      }
      for (const track of gum.getTracks()) this.#adoptTrack(track);
      return true;
    };
    try {
      return await acquire();
    } catch (err) {
      // The remembered device is gone (unplugged since it was chosen): retry
      // with whatever the system offers instead. Browsers report that as
      // OverconstrainedError or, for an exact id nothing matches, NotFoundError.
      const remembered = kind === 'audio' ? this.micId : this.camId;
      if (remembered && current() && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
        if (kind === 'audio') this.micId = undefined;
        else this.camId = undefined;
        try {
          return await acquire();
        } catch {
          /* fall through */
        }
      }
      if (!quiet && current()) this.emit('error', { kind, error: err, message: DEVICE_ERRORS[kind] });
      return false;
    }
  }

  /**
   * The raw device track ended on its own — the device was unplugged, or
   * the OS took it. Nothing else notices: with an effect or noise
   * suppression running the published track is a pipeline output that stays
   * 'live', so peers would get a frozen frame or silence under a control
   * that still says "on". Try another device of the kind (the fallback in
   * #tryAcquire), and turn the control off when there is none.
   */
  #onRawTrackEnded(track) {
    if (this.#closed) return;
    const kind = track.kind;
    const raw = kind === 'video' ? this.#rawVideoTrack : this.#rawAudioTrack;
    if (raw !== track) return; // already replaced (or dropped by us)
    void this.#recoverDevice(kind);
  }

  async #recoverDevice(kind) {
    const seq = ++this.#seq[kind];
    if (kind === 'video') {
      const wanted = this.camOn;
      this.#dropTrack('video');
      if (!wanted) return;
      const got = await this.#tryAcquire('video', { seq, quiet: true });
      if (seq !== this.#seq.video || this.#closed) return;
      this.camOn = got && !!this.videoTrack;
      if (!this.camOn) this.emit('error', { kind: 'video', error: null, message: 'Your camera was disconnected.' });
    } else {
      const muted = !this.micOn;
      this.#dropTrack('audio', /* silent */ true);
      const got = await this.#tryAcquire('audio', { seq, quiet: true });
      if (seq !== this.#seq.audio || this.#closed) return;
      if (got && this.audioTrack) {
        this.audioTrack.enabled = !muted;
      } else {
        this.micOn = false;
        this.emit('error', { kind: 'audio', error: null, message: 'Your microphone was disconnected.' });
      }
    }
    this.emit('change', { micOn: this.micOn, camOn: this.camOn });
  }

  #adoptTrack(track) {
    if (this.#closed) {
      track.stop();
      return;
    }
    const kind = track.kind; // 'audio' | 'video'
    track.addEventListener?.('ended', () => this.#onRawTrackEnded(track));
    if (kind === 'video') {
      try {
        track.contentHint = 'motion'; // camera: keep motion smooth under pressure
      } catch {
        /* unsupported */
      }
    }
    this.#dropTrack(kind, /* silent */ true);
    if (kind === 'video') this.#rawVideoTrack = track;
    else this.#rawAudioTrack = track;
    this.stream.addTrack(track);
    this.emit(kind === 'audio' ? 'audio-track' : 'video-track', { track });
    // Re-apply any effect to the fresh track; the processed track
    // replaces this raw one once the pipeline is up.
    if (kind === 'video') this.#applyBackgroundSoon();
    else this.#applyNoiseSuppressionSoon();
  }

  #dropTrack(kind, silent = false) {
    if (kind === 'video') {
      this.#applySeq++; // cancel any in-flight effect startup
      this.#effect?.stop();
      this.#effect = null;
      if (this.#rawVideoTrack) {
        this.#rawVideoTrack.stop(); // the camera light must turn off
        this.#rawVideoTrack = null;
      }
    } else {
      this.#nsSeq++; // cancel any in-flight suppression startup
      this.#nsEffect?.stop();
      this.#nsEffect = null;
      if (this.#rawAudioTrack) {
        this.#rawAudioTrack.stop(); // may not be in `stream` while suppression runs
        this.#rawAudioTrack = null;
      }
    }
    const track = kind === 'audio' ? this.audioTrack : this.videoTrack;
    if (!track) return;
    track.stop();
    this.stream.removeTrack(track);
    if (!silent) this.emit(kind === 'audio' ? 'audio-track' : 'video-track', { track: null });
  }
}
