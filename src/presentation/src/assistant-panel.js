// The AI assistant's side panel: a chat beside the slide in which Puter's AI
// answers questions about the presentation and changes it through the tools
// in assistant-tools.js.
//
// What it shows as it works is what it does: every tool call is a line in
// the reply ("Read slide 3", "Rewrite “Our plan” on slide 2"), linked to the
// slide and objects it touched. A change that deletes something waits for
// the user's Allow (the approval mode in the panel's menu decides which
// changes ask), and each reply that changed the deck ends with an Undo that
// takes back its changes, and only those: not once anything else has
// changed the deck since.
//
// The panel says what goes with a message (the chip above the box) and that
// replies can be wrong. "Slide 3" in a reply goes to that slide when clicked.
import { el, icon, iconButton, openMenu, toast, MOD_KEY } from "./ui.js";
import { renderMarkdown } from "./markdown.js";
import * as cloud from "./cloud.js";
import {
  createAgent,
  deckSnapshot,
  suggestions,
  userText,
  APPROVAL_MODES,
  DEFAULT_APPROVAL,
} from "./assistant.js";
import { runTool, describeCall, changesDeck } from "./assistant-tools.js";

const SETTINGS_KEY = "presentation:assistant";
export const MIN_WIDTH = 300;
export const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 360;
export function loadAssistantSettings() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
  } catch {}
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    approval: APPROVAL_MODES.some((m) => m.id === s.approval)
      ? s.approval
      : DEFAULT_APPROVAL,
    width: Number.isFinite(s.width)
      ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, s.width))
      : DEFAULT_WIDTH,
    // Closed until asked for; once left open it opens with the next deck.
    open: s.open === true,
  };
}
function saveAssistantSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

/**
 * A failed request in words that say what to do: a conversation too long for
 * the model, a busy service, a spent allowance, no session, no connection.
 * Anything else is quoted.
 */
export function friendlyAiError(error) {
  const text = String(error?.message || error || "").trim();
  const both = `${text} ${String(error?.code || "")}`;
  if (
    /context|too long|too many tokens|prompt is too long|maximum.*tokens|token limit/i.test(
      text,
    )
  )
    return "This chat has grown too long for the AI. Start a new chat to carry on.";
  if (
    /rate.?limit|too many requests|\b429\b|overloaded|try again later/i.test(
      both,
    )
  )
    return "The AI service is busy. Wait a moment, then try again.";
  if (
    /insufficient.?(funds|credit|balance)|out of credit|quota|usage.?limit|allowance|billing|payment required|\b402\b/i.test(
      both,
    )
  )
    return "Your Puter AI allowance has run out for now.";
  if (
    /sign.?in|not signed|unauthori[sz]ed|\b401\b|auth(entication)? (required|failed)|auth_window_closed/i.test(
      both,
    )
  )
    return "Sign in to Puter to use the assistant.";
  if (
    /network|failed to fetch|offline|timed? ?out|ECONN|connection/i.test(text)
  )
    return "The AI service could not be reached. Check your connection.";
  return text
    ? `The AI service said: ${text.slice(0, 300)}`
    : "The AI service did not answer.";
}

// "Slide 3", "slides 3", "Slide 12" in a reply's text.
const SLIDE_RE = /\b[Ss]lides? (\d{1,3})\b/g;

/**
 * The panel for one open presentation. `env` is what the tools need of the
 * editor (see assistant-tools.js), and besides:
 *
 *   docName()            the file's name, for the snapshot
 *   goToSlide(part|n)    shows a slide (a part name, or a 1-based number)
 *   whenIdle()           null, or a promise that settles when the text the
 *                        user is typing on the slide is committed
 *   isTyping()           whether they are typing there now
 *   slidePart()          the part name of the slide they are on
 *   history()            { bytes }: the undo history's current snapshot
 *   undoTurn(first, n)   takes the deck back to the snapshot `first`, from
 *                        before the reply's n undo steps
 *   focusWorkspace()     hands the keyboard back to the slide
 *   onToggle(open)       hears the panel open and close, for the layout
 */
export function createAssistantPanel(env) {
  const settings = loadAssistantSettings();
  let isOpen = false;
  let destroyed = false;

  const agent = createAgent({
    chat: (messages, options) =>
      cloud.aiChatStream(messages, { ...options, maxTokens: 8192 }),
    runTool: async (name, args, control) => {
      // A change, or a move to show the user something, waits for the text
      // they are typing to be committed: committing it for them would cut
      // their typing short.
      const idle =
        changesDeck(name) || name === "select" ? env.whenIdle?.() : null;
      if (idle) {
        control?.waiting?.("Waiting for you to finish typing on the slide");
        await Promise.race([idle, control?.whenStopped].filter(Boolean));
        if (control?.stopped?.()) return { skipped: true };
      }
      return runTool(name, args, env);
    },
    describe: (name, args) => describeCall(name, args, env),
    approve: (step) => askApproval(step),
    snapshot: () =>
      deckSnapshot(env.pres(), {
        slideIndex: env.slideIndex(),
        selectionIds: env.selectionIds(),
        theme: env.theme(),
        docName: env.docName?.() || "",
      }),
    settings: () => settings,
  });

  /* ---------- Frame ---------- */

  const status = el("div", {
    class: "visually-hidden",
    role: "status",
    "aria-live": "polite",
  });
  const say = (text) => {
    status.textContent = "";
    requestAnimationFrame(() => {
      status.textContent = text;
    });
  };
  const head = el(
    "header",
    { class: "ai-head" },
    el(
      "span",
      { class: "ai-head-mark", "aria-hidden": "true" },
      icon("Sparkles", 16),
    ),
    el("h2", { class: "ai-title", id: "ai-panel-title" }, "Assistant"),
    iconButton("New chat", "SquarePen", () => newChat()),
    iconButton(
      "Assistant settings",
      "EllipsisVertical",
      (e) => openSettings(e.currentTarget),
      {
        "aria-haspopup": "menu",
        "aria-expanded": "false",
      },
    ),
    iconButton("Close the assistant", "X", () => close(), {
      title: `Close (${MOD_KEY}+J)`,
    }),
  );
  const log = el("div", {
    class: "ai-log",
    role: "log",
    "aria-labelledby": "ai-panel-title",
    tabindex: -1,
  });
  const empty = el("div", { class: "ai-empty" });
  log.append(empty);

  const input = el("textarea", {
    class: "ai-input",
    rows: 1,
    placeholder: "Ask or tell the assistant…",
    "aria-label": "Message the assistant",
    enterkeyhint: "send",
  });
  const sendBtn = el("button", {
    type: "submit",
    class: "ai-send",
    "aria-label": "Send",
    title: "Send (Enter)",
  });
  sendBtn.append(icon("ArrowUp", 18));
  // What goes with a message: a label, not a control.
  const chip = el("div", {
    class: "ai-context",
    title:
      "Sent with your message, with an outline of the slides. Select objects to point the assistant at them.",
  });
  const form = el(
    "form",
    {
      class: "ai-composer",
      onsubmit: (e) => {
        e.preventDefault();
        if (agent.busy) stop();
        else submit();
      },
    },
    el("div", { class: "ai-composer-top" }, chip),
    el("div", { class: "ai-input-wrap" }, input, sendBtn),
    el(
      "p",
      { class: "ai-disclaimer" },
      "The assistant can make mistakes. Check what it writes.",
    ),
  );
  const resizer = el("div", {
    class: "ai-resize",
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize the assistant",
    tabindex: 0,
    "aria-valuemin": MIN_WIDTH,
  });
  const root = el(
    "aside",
    {
      class: "ai-panel",
      id: "ai-panel",
      "aria-labelledby": "ai-panel-title",
      hidden: true,
    },
    resizer,
    head,
    log,
    form,
    status,
  );
  // The saved width is kept as it is (a wider window shows it all); the
  // stylesheet draws what fits now.
  root.style.setProperty("--ai-w", `${settings.width}px`);
  // The widest the panel is drawn: its own limit, or what the stylesheet
  // allows at this window size (half the window, less on a tablet). A drag
  // or a key stops there, so no stretch of it moves nothing on the way back.
  const widest = () => {
    const allowed = parseFloat(getComputedStyle(root).maxWidth);
    return Math.max(
      MIN_WIDTH,
      Math.floor(
        Math.min(MAX_WIDTH, Number.isFinite(allowed) ? allowed : Infinity),
      ),
    );
  };
  // The edge reports the width drawn, and how far it can go.
  const syncEdge = () => {
    resizer.setAttribute(
      "aria-valuenow",
      String(Math.min(settings.width, widest())),
    );
    resizer.setAttribute("aria-valuemax", String(widest()));
  };
  const onWindowResize = () => {
    if (isOpen) syncEdge();
  };
  globalThis.addEventListener?.("resize", onWindowResize);

  /* ---------- Settings ---------- */

  function openSettings(anchor) {
    openMenu({
      anchor,
      align: "end",
      label: "Assistant settings",
      items: [
        { header: "Changes to the presentation" },
        ...APPROVAL_MODES.map((m) => ({
          label: m.label,
          checked: settings.approval === m.id,
          onSelect: () => {
            settings.approval = m.id;
            saveAssistantSettings(settings);
          },
        })),
        { separator: true },
        { label: "New chat", icon: "SquarePen", onSelect: () => newChat() },
      ],
    });
  }

  /* ---------- Width ---------- */

  function setWidth(w, save = true) {
    const width = Math.round(Math.min(widest(), Math.max(MIN_WIDTH, w)));
    settings.width = width;
    root.style.setProperty("--ai-w", `${width}px`);
    syncEdge();
    if (save) saveAssistantSettings(settings);
  }
  resizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // The edge follows the pointer: the width is what lies between the
    // pointer and the panel's right side.
    const right =
      root.getBoundingClientRect().right ||
      e.clientX + Math.min(settings.width, widest());
    resizer.setPointerCapture?.(e.pointerId);
    root.classList.add("resizing");
    const move = (ev) => setWidth(right - ev.clientX, false);
    const up = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", up);
      resizer.removeEventListener("pointercancel", up);
      root.classList.remove("resizing");
      saveAssistantSettings(settings);
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
    resizer.addEventListener("pointercancel", up);
  });
  resizer.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 64 : 16;
    const now = Math.min(settings.width, widest());
    const next = {
      ArrowLeft: now + step,
      ArrowRight: now - step,
      Home: MIN_WIDTH,
      End: MAX_WIDTH,
    }[e.key];
    if (next == null) return;
    e.preventDefault();
    setWidth(next);
  });

  /* ---------- Context chip and empty state ---------- */

  function refreshChip() {
    if (!isOpen) return;
    const n = env.slideIndex() + 1;
    const count = env.selectionIds().length;
    // replaceChildren writes a null out as text; the count is left out instead.
    chip.replaceChildren(
      ...[
        el(
          "span",
          { class: "ai-context-icon", "aria-hidden": "true" },
          icon("PanelLeft", 13),
        ),
        el("span", { class: "visually-hidden" }, "Sent with your message: "),
        el("span", { class: "ai-context-label" }, `Slide ${n}`),
        count
          ? el(
              "span",
              { class: "ai-context-count" },
              `${count} object${count === 1 ? "" : "s"} selected`,
            )
          : null,
      ].filter(Boolean),
    );
  }

  let lastSuggestions = "";
  function renderEmpty() {
    if (!isOpen || !empty.isConnected) return;
    const list = suggestions(
      env.pres(),
      env.slideIndex(),
      env.selectionIds().length,
    );
    const key = list.join("|");
    if (key === lastSuggestions && empty.childNodes.length) return;
    lastSuggestions = key;
    empty.replaceChildren(
      el(
        "div",
        { class: "ai-empty-mark", "aria-hidden": "true" },
        icon("Sparkles", 22),
      ),
      el(
        "p",
        { class: "ai-empty-title" },
        "Write, redesign, or ask about your slides",
      ),
      el(
        "p",
        { class: "ai-empty-text" },
        "The assistant reads every slide and can add slides, rewrite and format text, arrange objects, build tables, and write speaker notes. Every change it makes can be undone.",
      ),
      // Buttons in list items: a button given the listitem role stops being
      // announced as something to press.
      el(
        "ul",
        { class: "ai-suggestions", "aria-label": "Suggestions" },
        ...list.map((text) =>
          el(
            "li",
            {},
            el(
              "button",
              {
                type: "button",
                class: "ai-suggestion",
                onclick: () => submit(text),
              },
              text,
            ),
          ),
        ),
      ),
      el(
        "p",
        { class: "ai-privacy" },
        "Your messages and the slides the assistant reads are sent to Puter’s AI service to answer them.",
      ),
    );
  }

  /* ---------- Messages ---------- */

  let stick = true;
  const nearBottom = () =>
    log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  log.addEventListener("scroll", () => (stick = nearBottom()), {
    passive: true,
  });
  const scrollDown = (force = false) => {
    if (force || stick) log.scrollTop = log.scrollHeight;
  };

  function refs(text) {
    const count = env.pres() ? env.slideCount() : 0;
    const out = [];
    for (const m of text.matchAll(SLIDE_RE)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= count)
        out.push({ start: m.index, end: m.index + m[0].length, target: n });
    }
    return out;
  }
  const mdOptions = { refs, onRef: (n) => env.goToSlide(n) };

  function userBubble(text) {
    empty.remove();
    log.append(
      el(
        "div",
        { class: "ai-msg ai-user" },
        el("div", { class: "ai-bubble", dir: "auto" }, text),
      ),
    );
    stick = true;
    scrollDown(true);
  }

  // One reply as it arrives: text blocks and tool steps in the order they came.
  function assistantMessage() {
    const parts = el("div", { class: "ai-parts" });
    const foot = el("div", { class: "ai-foot", hidden: true });
    const msg = el(
      "div",
      { class: "ai-msg ai-assistant", "aria-busy": "true" },
      parts,
      foot,
    );
    const typing = el(
      "div",
      { class: "ai-typing", "aria-hidden": "true" },
      el("span"),
      el("span"),
      el("span"),
    );
    parts.append(typing);
    log.append(msg);
    scrollDown();
    let block = null;
    let queued = false;
    let fullText = "";
    const paint = () => {
      queued = false;
      if (!block) return;
      block.node.replaceChildren(renderMarkdown(block.text, mdOptions));
      scrollDown();
    };
    const rows = new Map();
    return {
      msg,
      foot,
      parts,
      get fullText() {
        return fullText;
      },
      append(delta) {
        typing.remove();
        if (!block) {
          block = {
            node: el("div", { class: "ai-text md", dir: "auto" }),
            text: "",
          };
          parts.append(block.node);
          if (fullText) fullText = `${fullText.trimEnd()}\n\n`;
        }
        block.text += delta;
        fullText += delta;
        if (!queued) {
          queued = true;
          requestAnimationFrame(paint);
        }
      },
      round() {
        paint();
        block = null;
        parts.append(typing);
        scrollDown();
      },
      step(step) {
        typing.remove();
        if (block) {
          paint();
          block = null;
        }
        let row = rows.get(step.id);
        if (!row) {
          row = el("div", { class: "ai-step" });
          rows.set(step.id, row);
          parts.append(row);
        }
        renderStep(row, step);
        if (
          ["done", "error", "declined", "skipped"].includes(step.status) &&
          agent.busy
        )
          parts.append(typing);
        scrollDown();
      },
      finish() {
        paint();
        typing.remove();
        msg.removeAttribute("aria-busy");
      },
    };
  }

  const STATUS_ICONS = {
    running: "LoaderCircle",
    waiting: "Clock",
    done: "Check",
    error: "CircleAlert",
    declined: "Ban",
    skipped: "Minus",
  };
  const STATUS_WORDS = {
    running: "running",
    waiting: "waiting for your answer",
    done: "done",
    error: "failed",
    declined: "not allowed",
    skipped: "not run",
  };
  function renderStep(row, step) {
    row.className = `ai-step ai-step-${step.status}${changesDeck(step.name) ? " ai-step-change" : ""}`;
    const ic = el(
      "span",
      { class: "ai-step-icon", "aria-hidden": "true" },
      icon(STATUS_ICONS[step.status] || "Info", 14),
    );
    if (step.status === "running") ic.classList.add("spin");
    const target = step.target;
    const label =
      target && step.status === "done"
        ? el(
            "button",
            {
              type: "button",
              class: "ai-step-label linkish",
              title: "Show on the slide",
              onclick: () => env.select(target.part, target.ids || []),
            },
            step.label,
          )
        : el("span", { class: "ai-step-label" }, step.label);
    row.replaceChildren(
      ic,
      label,
      el(
        "span",
        { class: "visually-hidden" },
        `, ${STATUS_WORDS[step.status]}`,
      ),
    );
    if (step.status === "running" && step.note)
      row.append(el("div", { class: "ai-step-note" }, step.note));
    if (step.status === "error" && step.error)
      row.append(el("div", { class: "ai-step-note" }, step.error));
    if (step.status === "declined")
      row.append(
        el("div", { class: "ai-step-note" }, "Not allowed, so not changed."),
      );
    if (step.status === "waiting") row.append(approvalCard(step));
  }

  /* ---------- Approval ---------- */

  let pendingApproval = null;
  let lastCard = null;
  function approvalCard(step) {
    const allow = el(
      "button",
      {
        type: "button",
        class: "btn primary ai-btn-sm",
        onclick: () => answer(true),
      },
      "Allow",
    );
    const deny = el(
      "button",
      { type: "button", class: "btn ai-btn-sm", onclick: () => answer(false) },
      "Don’t allow",
    );
    const card = el(
      "div",
      {
        class: "ai-approve",
        role: "group",
        "aria-label": "Allow this change?",
      },
      step.detail && el("p", { class: "ai-approve-detail" }, step.detail),
      el("div", { class: "ai-approve-actions" }, allow, deny),
    );
    card.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        answer(false);
      }
    });
    lastCard = card;
    // The question takes the focus only from within the panel: it never
    // pulls the keyboard off text being typed on the slide.
    if (root.contains(document.activeElement))
      requestAnimationFrame(() => {
        if (card.isConnected) allow.focus();
      });
    return card;
  }
  function askApproval(step) {
    return new Promise((resolve) => {
      pendingApproval = { resolve, card: lastCard };
      say(
        `The assistant wants to ${step.label.charAt(0).toLowerCase()}${step.label.slice(1)}. ${step.detail || ""} Allow or don’t allow.`,
      );
      if (!isOpen) open({ focus: false });
    });
  }
  function answer(ok) {
    const p = pendingApproval;
    pendingApproval = null;
    const hadFocus = p?.card?.contains(document.activeElement);
    p?.resolve(ok);
    if (hadFocus) input.focus();
  }

  /* ---------- Sending ---------- */

  let current = null;
  function setBusy(busy) {
    root.classList.toggle("busy", busy);
    sendBtn.replaceChildren(icon(busy ? "Square" : "ArrowUp", busy ? 14 : 18));
    sendBtn.setAttribute("aria-label", busy ? "Stop" : "Send");
    sendBtn.title = busy ? "Stop (Escape)" : "Send (Enter)";
    sendBtn.classList.toggle("stopping", busy);
  }

  function submit(text = input.value) {
    const message = String(text).trim();
    if (!message || agent.busy) return;
    if (!cloud.canAI()) {
      toast(
        "The AI service is not available. Check your connection and reload.",
      );
      return;
    }
    input.value = "";
    autoGrow();
    userBubble(message);
    exchange((onEvent) => agent.send(message, onEvent));
  }

  async function exchange(start) {
    const reply = assistantMessage();
    current = reply;
    setBusy(true);
    say("The assistant is working…");
    const viewBefore = viewKey();
    const onEvent = (e) => {
      if (destroyed || current !== reply) return;
      if (e.type === "text") reply.append(e.text);
      else if (e.type === "round") reply.round();
      else if (e.type === "step") reply.step(e.step);
    };
    let outcome;
    try {
      outcome = await start(onEvent);
    } catch (error) {
      outcome = { error, steps: [] };
    }
    if (destroyed || current !== reply) return;
    current = null;
    reply.finish();
    setBusy(false);
    const changed = (outcome.steps || []).filter(
      (s) => s.changed && s.status === "done",
    );
    if (outcome.error) {
      const message = friendlyAiError(outcome.error);
      reply.foot.hidden = false;
      reply.foot.replaceChildren(
        el(
          "div",
          { class: "ai-error", role: "alert" },
          el(
            "span",
            { class: "ai-error-icon", "aria-hidden": "true" },
            icon("CircleAlert", 14),
          ),
          el("span", { class: "ai-error-text" }, message),
          el(
            "button",
            {
              type: "button",
              class: "btn ai-btn-sm",
              onclick: () => {
                reply.foot.hidden = true;
                retry();
              },
            },
            "Try again",
          ),
        ),
      );
      say(`The assistant could not answer: ${message}`);
    } else {
      say(outcome.stopped ? "Stopped." : "The assistant has answered.");
      if (outcome.stopped)
        reply.parts.append(el("p", { class: "ai-stopped" }, "Stopped."));
    }
    renderFoot(reply, changed, !!outcome.error);
    // Show what changed last, unless the user has moved on meanwhile (to
    // another slide or selection) or is typing.
    const last = [...changed].reverse().find((s) => s.target);
    if (last && viewKey() === viewBefore && !env.isTyping?.())
      env.select(last.target.part, last.target.ids || []);
  }
  // Where the user is: the slide, by part so slides the assistant adds
  // before it don't count as a move, and what is selected on it.
  const viewKey = () =>
    `${env.slidePart?.() ?? env.slideIndex()}|${[...env.selectionIds()].sort((a, b) => a - b).join()}`;

  function retry() {
    if (agent.busy) return;
    exchange((onEvent) => agent.retry(onEvent));
  }

  // A reply's changes, as its Undo takes them back: the snapshot from before
  // the first, the one after the last (held weakly: while it is the current
  // one the history holds it), how many undo steps they took, and whether
  // they followed one another with nothing else between.
  function turnOf(chain) {
    if (!chain.length) return null;
    const contiguous = chain.every(
      (step, i) => !i || chain[i - 1].after === step.before,
    );
    const last = chain.at(-1).after;
    return {
      first: chain[0].before,
      last: globalThis.WeakRef ? new WeakRef(last) : { deref: () => last },
      count: chain.length,
      contiguous,
    };
  }
  // Undo takes back the reply's changes and only those: not once anything
  // else has changed the presentation since, or in between.
  const canUndo = (turn) =>
    !!turn?.contiguous && env.history().bytes === turn.last.deref();

  // Only the latest reply that changed the deck keeps its Undo: a later
  // change leaves an earlier reply's to the Edit menu, and lets its snapshot
  // go.
  let liveUndo = null;
  function renderFoot(reply, changed, error) {
    const items = [];
    const text = reply.fullText;
    if (text && !error) {
      const copy = iconButton("Copy the reply", "Copy", async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast("Reply copied.");
        } catch {
          toast("The reply could not be copied.");
        }
      });
      copy.classList.add("ai-foot-btn");
      items.push(copy);
    }
    // The listeners below keep only the count and the turn: the steps carry
    // every snapshot they made, which the history lets go past its limits.
    const count = changed.length;
    const turn = count ? turnOf(changed.flatMap((s) => s.history || [])) : null;
    if (turn) {
      liveUndo?.retire();
      const summary = el(
        "span",
        { class: "ai-foot-summary" },
        `${count} change${count === 1 ? "" : "s"} made`,
      );
      const undoBtn = el(
        "button",
        { type: "button", class: "btn ai-btn-sm ai-undo" },
        icon("Undo2", 14),
        el("span", {}, "Undo"),
      );
      const refresh = () => {
        const ok = canUndo(turn);
        undoBtn.disabled = !ok;
        undoBtn.title = ok
          ? "Undo the changes in this reply"
          : "The presentation has changed since this reply";
      };
      const retire = () => {
        undoBtn.remove();
        if (liveUndo?.refresh === refresh) liveUndo = null;
      };
      undoBtn.addEventListener("click", async () => {
        if (!canUndo(turn)) {
          toast(
            "The presentation has changed since. Use Undo in the Edit menu to go back step by step.",
          );
          refresh();
          return;
        }
        // The button goes; the keyboard it held moves to the message box
        // rather than dropping out of the page.
        const hadFocus = undoBtn === document.activeElement;
        retire();
        if (hadFocus) input.focus({ preventScroll: true });
        await env.undoTurn(turn.first, turn.count);
        summary.classList.add("ai-foot-undone");
        summary.textContent = `${count} change${count === 1 ? "" : "s"} undone`;
        say("The assistant's changes were undone.");
      });
      liveUndo = { refresh, retire };
      items.unshift(summary, undoBtn);
      refresh();
    }
    if (!items.length) return;
    reply.foot.hidden = false;
    reply.foot.prepend(...items);
  }

  function stop() {
    if (!agent.busy) return;
    if (pendingApproval) answer(false);
    agent.stop();
  }

  function newChat() {
    if (agent.busy) stop();
    agent.reset();
    current = null;
    pendingApproval = null;
    liveUndo = null;
    for (const node of [...log.children]) if (node !== empty) node.remove();
    lastSuggestions = "";
    log.append(empty);
    setBusy(false);
    renderEmpty();
    input.focus();
    say("New chat.");
  }

  /* ---------- Composer ---------- */

  function autoGrow() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }
  input.addEventListener("input", autoGrow);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      if (!agent.busy) submit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (agent.busy) stop();
      else env.focusWorkspace();
    }
  });
  root.addEventListener("keydown", (e) => {
    // Escape from elsewhere in the panel goes back to the slide; the panel
    // stays open.
    if (
      e.key === "Escape" &&
      !e.defaultPrevented &&
      e.target !== input &&
      !e.target.closest?.(".menu")
    ) {
      e.preventDefault();
      env.focusWorkspace();
    }
  });

  /* ---------- Open and close ---------- */

  function open({ focus = true, prompt = null } = {}) {
    if (!isOpen) {
      isOpen = true;
      root.hidden = false;
      settings.open = true;
      saveAssistantSettings(settings);
      syncEdge();
      refreshChip();
      renderEmpty();
      env.onToggle?.(true);
    }
    if (prompt) {
      input.value = prompt;
      autoGrow();
    }
    if (focus)
      requestAnimationFrame(() => {
        input.focus();
        if (prompt)
          input.setSelectionRange(input.value.length, input.value.length);
      });
  }

  function close({ focusWorkspace = true } = {}) {
    if (!isOpen) return;
    // A question waiting on the user goes unanswered with the panel shut: it
    // is declined, as Escape would.
    if (pendingApproval) answer(false);
    isOpen = false;
    root.hidden = true;
    settings.open = false;
    saveAssistantSettings(settings);
    env.onToggle?.(false);
    if (focusWorkspace) env.focusWorkspace();
  }

  return {
    el: root,
    get isOpen() {
      return isOpen;
    },
    /** Whether it was left open, to open again with the next deck. */
    get wantsOpen() {
      return settings.open;
    },
    get busy() {
      return agent.busy;
    },
    open,
    close,
    /** Opens the chat and sends `text` as if the user had typed it. */
    ask(text) {
      open({ focus: false });
      submit(text);
    },
    toggle(force) {
      if (force ?? !isOpen) open();
      else close();
    },
    focus() {
      input.focus();
    },
    /** The editor's selection or slide changed. */
    refresh() {
      refreshChip();
      if (empty.isConnected) renderEmpty();
    },
    /** The undo history moved: each reply's Undo checks it still can. */
    historyChanged() {
      liveUndo?.refresh();
    },
    /** What the user sent, message by message (for tests). */
    get sent() {
      return agent.messages
        .filter((m) => m.role === "user")
        .map((m) => userText(m.content));
    },
    destroy() {
      destroyed = true;
      if (pendingApproval) answer(false);
      agent.reset();
      globalThis.removeEventListener?.("resize", onWindowResize);
      root.remove();
    },
  };
}
