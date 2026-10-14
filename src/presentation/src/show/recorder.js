// The recording studio: the slide show with a recording toolbar. The
// presenter's voice (and, with the camera on, their picture) is recorded
// slide by slide; moving to another slide closes one recording and starts
// the next. Pausing, retaking a slide and clearing recordings work as the
// show goes. At the end each recorded slide gets its narration and a timing
// of the recording's length (see narration.js and index.js).
import { el, openMenu } from "../ui.js";
import { lineButton, lineIcon } from "./icons.js";
import { showPrefs } from "./prefs.js";
import { formatClock } from "./rehearse.js";

const VIDEO_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];
const AUDIO_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
];
const pickType = (types) =>
  typeof MediaRecorder === "undefined"
    ? null
    : (types.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "");

export function createRecordingStudio(ctx, session) {
  const { show } = session;
  const { P } = ctx;
  const { all, stage, frame } = show;
  const segments = new Map(); // slide part -> segment
  const cleared = new Set(); // slide parts whose earlier recording goes
  let stream = null;
  let recorder = null; // { media, segment }
  let state = "idle"; // idle | recording | paused
  let current = -1;
  let ended = false;
  let total = 0; // ms recorded in finished segments
  const finishing = [];
  const part = (i) => P.getSlidePartName(all[i]);

  stage.classList.add("show-studio");
  // ---- Camera preview over the slide -------------------------------------
  const preview = el("video", {
    class: "show-cam-video",
    muted: true,
    playsinline: true,
    autoplay: true,
    "aria-label": "Your camera",
  });
  preview.muted = true;
  const cameraBox = el(
    "div",
    { class: `show-cam-preview ${showPrefs.cameraShape}`, hidden: true },
    preview,
  );
  frame.append(cameraBox);

  // ---- Toolbar -----------------------------------------------------------
  const recordButton = el(
    "button",
    {
      type: "button",
      class: "btn show-studio-record",
      onclick: () => (state === "idle" ? start() : stop()),
    },
    el("span", { class: "show-studio-dot", "aria-hidden": "true" }),
    el("span", { class: "label" }, "Record"),
  );
  const pauseButton = lineButton(
    "Pause recording",
    "Pause",
    () => togglePause(),
    {
      "aria-pressed": "false",
      disabled: true,
    },
  );
  const retakeButton = lineButton("Retake this slide", "RotateCcw", () =>
    retake(),
  );
  const clearButton = lineButton("Clear recordings", "Trash2", (e) =>
    openMenu({
      anchor: e.currentTarget,
      label: "Clear recordings",
      items: [
        {
          label: "Clear Recording on Current Slide",
          onSelect: () => clear(false),
        },
        {
          label: "Clear Recordings on All Slides",
          onSelect: () => clear(true),
        },
      ],
    }),
  );
  const micButton = lineButton("Microphone", "Mic", () => toggle("micOn"), {
    "aria-pressed": "true",
  });
  const camButton = lineButton("Camera", "Video", () => toggle("cameraOn"), {
    "aria-pressed": "true",
  });
  const shapeButton = lineButton(
    "Camera shape",
    showPrefs.cameraShape === "rect" ? "Square" : "Circle",
    () => {
      showPrefs.cameraShape =
        showPrefs.cameraShape === "rect" ? "circle" : "rect";
      cameraBox.className = `show-cam-preview ${showPrefs.cameraShape}`;
      cameraBox.hidden =
        !showPrefs.cameraOn || !stream?.getVideoTracks().length;
      shapeButton.replaceChildren(
        lineIcon(showPrefs.cameraShape === "rect" ? "Square" : "Circle"),
      );
    },
  );
  const devicesButton = lineButton("Camera and microphone", "Settings", (e) =>
    devicesMenu(e.currentTarget),
  );
  const slideTime = el("span", { class: "show-studio-time", role: "timer" });
  const message = el("span", {
    class: "show-studio-message",
    "aria-live": "polite",
  });
  const bar = el(
    "div",
    {
      class: "show-studio-bar",
      role: "toolbar",
      "aria-label": "Recording",
      onclick: (e) => e.stopPropagation(),
    },
    recordButton,
    pauseButton,
    retakeButton,
    clearButton,
    el("span", { class: "show-console-sep", "aria-hidden": "true" }),
    micButton,
    camButton,
    shapeButton,
    devicesButton,
    el("span", { class: "show-console-sep", "aria-hidden": "true" }),
    slideTime,
    message,
  );
  const notes = el("div", { class: "show-studio-notes-text", tabindex: 0 });
  notes.style.fontSize = `${showPrefs.notesFontSize}px`;
  const side = el(
    "aside",
    { class: "show-studio-notes", "aria-label": "Notes" },
    el("h2", {}, "Notes"),
    notes,
  );
  stage.append(bar, side);

  function say(text) {
    message.textContent = text || "";
  }
  function syncButtons() {
    const live = state !== "idle";
    recordButton.classList.toggle("live", live);
    recordButton.querySelector(".label").textContent = live ? "Stop" : "Record";
    recordButton.setAttribute(
      "aria-label",
      live ? "Stop recording" : "Start recording",
    );
    pauseButton.disabled = !live;
    pauseButton.setAttribute("aria-pressed", String(state === "paused"));
    pauseButton.setAttribute(
      "aria-label",
      state === "paused" ? "Resume recording" : "Pause recording",
    );
    pauseButton.replaceChildren(
      lineIcon(state === "paused" ? "Play" : "Pause"),
    );
    micButton.setAttribute("aria-pressed", String(!!showPrefs.micOn));
    micButton.replaceChildren(lineIcon(showPrefs.micOn ? "Mic" : "MicOff"));
    camButton.setAttribute("aria-pressed", String(!!showPrefs.cameraOn));
    camButton.replaceChildren(
      lineIcon(showPrefs.cameraOn ? "Video" : "VideoOff"),
    );
    stage.classList.toggle("show-recording", state === "recording");
  }

  // ---- Devices -------------------------------------------------------------
  async function acquire() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    const wantVideo = !!showPrefs.cameraOn;
    const wantAudio = !!showPrefs.micOn;
    cameraBox.hidden = true;
    if (!wantVideo && !wantAudio) return null;
    const media = globalThis.navigator?.mediaDevices;
    if (!media?.getUserMedia) {
      say("This browser cannot record from a camera or microphone.");
      return null;
    }
    const constraints = (id) => (id ? { deviceId: { ideal: id } } : true);
    try {
      stream = await media.getUserMedia({
        audio: wantAudio ? constraints(showPrefs.micId) : false,
        video: wantVideo
          ? showPrefs.cameraId
            ? { deviceId: { ideal: showPrefs.cameraId } }
            : { width: { ideal: 1280 }, height: { ideal: 720 } }
          : false,
      });
    } catch {
      // The camera may be missing or refused; the microphone alone still
      // records a narration.
      if (wantVideo && wantAudio)
        try {
          stream = await media.getUserMedia({
            audio: constraints(showPrefs.micId),
          });
          say("The camera is not available; recording sound only.");
        } catch {}
      if (!stream) {
        say("Allow the camera and microphone to record.");
        return null;
      }
    }
    if (stream.getVideoTracks().length) {
      preview.srcObject = stream;
      preview.play().catch(() => {});
      cameraBox.hidden = false;
    }
    return stream;
  }
  async function toggle(which) {
    if (state !== "idle") {
      say("Stop recording to change the camera or microphone.");
      return;
    }
    showPrefs[which] = !showPrefs[which];
    syncButtons();
    await acquire();
  }
  async function devicesMenu(anchor) {
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {}
    const cams = devices.filter((d) => d.kind === "videoinput");
    const mics = devices.filter((d) => d.kind === "audioinput");
    const pick = (key, id) => async () => {
      showPrefs[key] = id;
      if (state === "idle") await acquire();
      else say("The new choice applies after this recording.");
    };
    openMenu({
      anchor,
      label: "Camera and microphone",
      minWidth: 240,
      items: [
        { header: "Camera" },
        ...(cams.length
          ? cams.map((d, i) => ({
              label: d.label || `Camera ${i + 1}`,
              checked: showPrefs.cameraId
                ? showPrefs.cameraId === d.deviceId
                : i === 0,
              onSelect: pick("cameraId", d.deviceId),
            }))
          : [{ label: "No camera found", disabled: true }]),
        { separator: true },
        { header: "Microphone" },
        ...(mics.length
          ? mics.map((d, i) => ({
              label: d.label || `Microphone ${i + 1}`,
              checked: showPrefs.micId
                ? showPrefs.micId === d.deviceId
                : i === 0,
              onSelect: pick("micId", d.deviceId),
            }))
          : [{ label: "No microphone found", disabled: true }]),
      ],
    });
  }

  // ---- Recording -----------------------------------------------------------
  function poster() {
    if (!stream?.getVideoTracks().length || !preview.videoWidth) return null;
    const side = Math.min(preview.videoWidth, preview.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.min(480, side);
    const sx = (preview.videoWidth - side) / 2,
      sy = (preview.videoHeight - side) / 2;
    canvas
      .getContext("2d")
      .drawImage(
        preview,
        sx,
        sy,
        side,
        side,
        0,
        0,
        canvas.width,
        canvas.height,
      );
    return new Promise((resolve) =>
      canvas.toBlob(
        async (blob) =>
          resolve(blob ? new Uint8Array(await blob.arrayBuffer()) : null),
        "image/png",
      ),
    );
  }
  function begin(i) {
    if (!stream) return false;
    const tracks = [
      ...(showPrefs.micOn ? stream.getAudioTracks() : []),
      ...(showPrefs.cameraOn ? stream.getVideoTracks() : []),
    ];
    if (!tracks.length) {
      say("Turn on the microphone or the camera to record.");
      return false;
    }
    const video = tracks.some((t) => t.kind === "video");
    const type = pickType(video ? VIDEO_TYPES : AUDIO_TYPES);
    if (type === null) {
      say("This browser cannot record.");
      return false;
    }
    let media;
    try {
      media = new MediaRecorder(
        new MediaStream(tracks),
        type ? { mimeType: type } : {},
      );
    } catch {
      say("Recording could not start.");
      return false;
    }
    const segment = {
      part: part(i),
      kind: video ? "video" : "audio",
      contentType: (
        media.mimeType ||
        type ||
        (video ? "video/webm" : "audio/webm")
      ).split(";")[0],
      shape: showPrefs.cameraShape,
      chunks: [],
      ms: 0,
      since: performance.now(),
      poster: video ? poster() : null,
      done: null,
    };
    segment.done = new Promise((resolve) => {
      media.ondataavailable = (e) =>
        e.data?.size && segment.chunks.push(e.data);
      media.onstop = () => resolve(segment);
      media.onerror = () => resolve(segment);
    });
    media.start(1000);
    recorder = { media, segment };
    cleared.delete(segment.part);
    return true;
  }
  function finish({ discard = false } = {}) {
    if (!recorder) return;
    const { media, segment } = recorder;
    recorder = null;
    if (state === "recording") segment.ms += performance.now() - segment.since;
    try {
      if (media.state !== "inactive") media.stop();
    } catch {}
    if (discard) return;
    total += segment.ms;
    // A retake or a second recording of a slide replaces the first.
    segments.set(segment.part, segment);
    finishing.push(segment.done);
  }
  async function start() {
    if (ended) {
      say("Go back to a slide to record it.");
      return;
    }
    if (!stream) await acquire();
    if (!begin(current)) return;
    state = "recording";
    say("");
    syncButtons();
  }
  function stop() {
    finish();
    state = "idle";
    syncButtons();
    say(`Recorded ${segments.size} slide${segments.size === 1 ? "" : "s"}.`);
  }
  function togglePause() {
    if (!recorder) return;
    const { media, segment } = recorder;
    if (state === "recording") {
      segment.ms += performance.now() - segment.since;
      try {
        media.pause();
      } catch {}
      state = "paused";
    } else if (state === "paused") {
      segment.since = performance.now();
      try {
        media.resume();
      } catch {}
      state = "recording";
    }
    syncButtons();
  }
  function retake() {
    if (current < 0) return;
    segments.delete(part(current));
    if (recorder) {
      finish({ discard: true });
      if (begin(current)) state = "recording";
      else state = "idle";
    }
    say("This slide will be recorded again.");
    syncButtons();
  }
  function clear(everything) {
    const parts = everything ? all.map((_, i) => part(i)) : [part(current)];
    if (recorder && parts.includes(recorder.segment.part)) {
      finish({ discard: true });
      state = "idle";
    }
    for (const p of parts) {
      segments.delete(p);
      cleared.add(p);
    }
    say(
      everything
        ? "Recordings on all slides will be cleared."
        : "The recording on this slide will be cleared.",
    );
    syncButtons();
  }
  const liveMs = () =>
    recorder && state === "recording"
      ? recorder.segment.ms + performance.now() - recorder.segment.since
      : (recorder?.segment.ms ?? 0);
  const tick = setInterval(() => {
    slideTime.textContent = `${formatClock(liveMs())} / ${formatClock(total + liveMs())}`;
  }, 250);
  syncButtons();
  acquire();

  return {
    ownsCamera: true,
    shown(i) {
      const moving = i !== current;
      ended = false;
      if (moving && recorder) {
        const was = state;
        finish();
        current = i;
        if (begin(i)) state = was === "paused" ? "recording" : was;
        else state = "idle";
      }
      current = i;
      const text = P.getSlideNotes(all[i]) || "";
      notes.textContent = text || "No notes for this slide.";
      notes.classList.toggle("empty", !text);
      syncButtons();
    },
    ended() {
      ended = true;
      if (recorder) stop();
    },
    keydown(e) {
      // R starts or stops recording; K pauses (keys the show does not use).
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      if (e.key === "r" || e.key === "R") {
        if (state === "idle") start();
        else stop();
        return true;
      }
      if (e.key === "k" || e.key === "K") {
        togglePause();
        return true;
      }
      return false;
    },
    dispose() {
      finish();
      state = "idle";
      clearInterval(tick);
      bar.remove();
      side.remove();
      cameraBox.remove();
      stage.classList.remove("show-studio", "show-recording");
      const keep = [...segments.values()];
      const done = Promise.all(finishing).then(async () => {
        stream?.getTracks().forEach((t) => t.stop());
        const out = [];
        for (const segment of keep) {
          if (!segment.chunks.length) continue;
          const blob = new Blob(segment.chunks, { type: segment.contentType });
          out.push({
            part: segment.part,
            kind: segment.kind,
            contentType: segment.contentType,
            shape: segment.shape,
            durationMs: Math.max(100, Math.round(segment.ms)),
            data: new Uint8Array(await blob.arrayBuffer()),
            poster: segment.poster ? await segment.poster : null,
          });
        }
        return out;
      });
      return { segments: done, cleared: [...cleared] };
    },
  };
}
