import { blocksFromDelta, spliceTextBlocks } from "../text-blocks.js";
import { runsFromDelta, styleAt, textDifference } from "../rich-text.js";
import { LOCAL, changeTextBlocks } from "./document.js";

// Where a position moves to after a remote change. Text inserted exactly at
// the position goes before it, except at the end of a range (`end`), where
// it stays outside, so replacing the range never deletes it.
function shifted(index, delta, end = false) {
  let at = 0,
    result = index;
  for (const op of delta) {
    if (op.retain) at += op.retain;
    if (op.insert) {
      if (at < index || (at === index && !end)) result += op.insert.length;
    }
    if (op.delete) {
      result -= Math.max(0, Math.min(op.delete, index - at));
      at += op.delete;
    }
  }
  return Math.max(0, result);
}

export function bindText(session, id, input, onChange, pending = {}) {
  // The document bound to. Recovering from a refused save replaces the
  // session's, and the editor then binds again to the new one.
  const shared = session.shared;
  const entry = shared.items.get(id),
    text = entry?.get("text");
  if (!text) {
    // New objects may still be entering the shared document. Listen now so
    // typing before that transaction completes is replayed, not silently lost.
    let unbind,
      stopped = false;
    const buffered = { dirty: false, composing: false, compositionBase: "" };
    const inputChanged = () => {
      buffered.dirty = true;
    };
    const compositionStart = () => {
      buffered.composing = true;
      buffered.compositionBase = input.value;
      buffered.compositionRuns = input.textRuns;
      buffered.compositionBlocks = input.textBlocks;
    };
    const compositionEnd = () => {
      buffered.composing = false;
      buffered.dirty = true;
    };
    const cleanup = () => {
      shared.doc.off("afterTransaction", attach);
      input.removeEventListener("input", inputChanged);
      input.removeEventListener("compositionstart", compositionStart);
      input.removeEventListener("compositionend", compositionEnd);
    };
    const attach = () => {
      if (stopped || session.closed || !shared.items.get(id)?.get("text"))
        return;
      cleanup();
      unbind = bindText(session, id, input, onChange, buffered);
    };
    input.addEventListener("input", inputChanged);
    input.addEventListener("compositionstart", compositionStart);
    input.addEventListener("compositionend", compositionEnd);
    shared.doc.on("afterTransaction", attach);
    return () => {
      stopped = true;
      cleanup();
      unbind?.();
    };
  }
  shared.undo.stopCapturing();
  shared.undo.captureTimeout = 500;
  // The editor receives each change through onChange. Projecting the whole
  // board again costs a full snapshot on large boards, so it waits until
  // typing pauses, and runs about once a second during continuous typing.
  let publishTimer = null,
    publishQueued = 0;
  const publishNow = () => {
    clearTimeout(publishTimer);
    publishTimer = null;
    session.publish().catch(() => {});
  };
  const publishSoon = () => {
    const now = Date.now();
    if (!publishTimer) publishQueued = now;
    clearTimeout(publishTimer);
    publishTimer = setTimeout(publishNow, now - publishQueued > 800 ? 0 : 150);
  };
  let composing = !!pending.composing,
    compositionBase = pending.compositionBase || "",
    changes = [],
    // The text typed on, once recovering from a refused save has replaced
    // the document and the keys pressed since have nowhere to go.
    stranded;
  const read = () => {
    const value = text.toString(),
      delta = text.toDelta(),
      runs = runsFromDelta(delta),
      blocks = blocksFromDelta(delta, entry.get("textTail"));
    if (input.setRichText) input.setRichText(value, runs, blocks);
    else input.value = value;
    onChange(value, runs, blocks);
  };
  const observer = (event) => {
    if (event.transaction.origin === LOCAL) return;
    if (composing) {
      changes.push(event.delta);
      return;
    }
    const collapsed = input.selectionStart === input.selectionEnd,
      start = shifted(input.selectionStart, event.delta),
      end = Math.max(
        start,
        shifted(input.selectionEnd, event.delta, !collapsed),
      );
    const direction = input.selectionDirection;
    read();
    input.setSelectionRange(start, end, direction);
  };
  const update = () => {
    if (composing || session.readOnly || session.contentReadOnly) return;
    // Kept for the binding to the new document, which makes them again.
    if (session.shared !== shared) {
      stranded ??= text.toString();
      return;
    }
    shared.text(id, input.value, input.textRuns, input.textBlocks);
    const delta = text.toDelta();
    onChange(
      input.value,
      runsFromDelta(delta),
      blocksFromDelta(delta, entry.get("textTail")),
    );
    publishSoon();
  };
  const compositionStart = () => {
    composing = true;
    compositionBase = input.value;
    changes = [];
  };
  const compositionEnd = () => {
    // Transform the IME replacement through remote deltas received during composition.
    const next = input.value;
    const change = textDifference(compositionBase, next),
      start = change.start;
    let end = change.end,
      from = start;
    for (const delta of changes) {
      const replaced = end > from;
      from = shifted(from, delta);
      end = Math.max(from, shifted(end, delta, replaced));
    }
    composing = false;
    if (!(session.readOnly || session.contentReadOnly))
      shared.doc.transact(() => {
        const blocks = spliceTextBlocks(
          text.toString(),
          blocksFromDelta(text.toDelta(), entry.get("textTail")),
          from,
          end,
          change.insert,
        );
        if (end > from)
          text.delete(from, Math.min(end - from, text.length - from));
        text.insert(
          from,
          change.insert,
          input.textRuns ? styleAt(input.textRuns, start, false) : undefined,
        );
        changeTextBlocks(entry, blocks);
      }, LOCAL);
    read();
    input.setSelectionRange(
      from + change.insert.length,
      from + change.insert.length,
    );
    publishSoon();
  };
  const formatBoundary = () => shared.undo.stopCapturing();
  input.addEventListener("formatboundary", formatBoundary);
  const entryObserver = (event) => {
    if (
      event.keysChanged.has("textTail") &&
      !event.transaction.changed.has(text)
    )
      observer({ transaction: event.transaction, delta: [] });
  };
  // Another client can replace this object's entry under the same ID, for
  // example by deleting it and undoing both in one update. Follow the new
  // text instead of writing over it from the removed one.
  let replacement;
  const itemsObserver = (event) => {
    if (!event.keysChanged.has(id)) return;
    const next = shared.items.get(id);
    if (next === entry || !next?.get("text")) return;
    detach();
    replacement = bindText(session, id, input, onChange, {
      composing,
      compositionBase,
      reload: true,
    });
  };
  shared.items.observe(itemsObserver);
  entry.observe(entryObserver);
  text.observe(observer);
  input.addEventListener("input", update);
  input.addEventListener("compositionstart", compositionStart);
  input.addEventListener("compositionend", compositionEnd);
  if (
    pending.dirty &&
    !(session.readOnly || session.contentReadOnly) &&
    !session.closed
  ) {
    const value = composing ? compositionBase : input.value;
    shared.text(
      id,
      value,
      composing ? pending.compositionRuns : input.textRuns,
      composing ? pending.compositionBlocks : input.textBlocks,
    );
    const delta = text.toDelta();
    onChange(
      value,
      runsFromDelta(delta),
      blocksFromDelta(delta, entry.get("textTail")),
    );
    session.publish().catch(() => {});
  } else if (
    pending.stranded !== undefined &&
    !composing &&
    !(session.readOnly || session.contentReadOnly)
  ) {
    // Typed while the document was being replaced: the change from the text
    // typed on is made again on this one, as a composition is through the
    // changes that arrived during it.
    const change = textDifference(pending.stranded, text.toString());
    compositionBase = pending.stranded;
    changes = [
      [
        { retain: change.start },
        { delete: change.end - change.start },
        { insert: change.insert },
      ],
    ];
    compositionEnd();
  } else if (pending.reload && !composing) {
    const { selectionStart, selectionEnd, selectionDirection } = input;
    read();
    input.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
  }
  function detach() {
    if (publishTimer) publishNow();
    shared.items.unobserve(itemsObserver);
    text.unobserve(observer);
    entry.unobserve(entryObserver);
    input.removeEventListener("formatboundary", formatBoundary);
    input.removeEventListener("input", update);
    input.removeEventListener("compositionstart", compositionStart);
    input.removeEventListener("compositionend", compositionEnd);
    shared.undo.stopCapturing();
    shared.undo.captureTimeout = 0;
  }
  // Returns the text typed on when keys were pressed after the document was
  // replaced, for the next binding to make them again.
  return () => {
    if (replacement) return replacement();
    if (composing) compositionEnd();
    detach();
    return stranded;
  };
}
