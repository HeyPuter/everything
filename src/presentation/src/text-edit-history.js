// Native textareas own selection, composition and undo. Record their sequential
// range edits so committing a plain control does not replace untouched rich XML.
// This stays linear in the text length per input; no whole-document text diff.
export function textEditHistory(initial) {
  let current = 0;
  const signature = (value) => {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++)
      hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
    return `${value.length}:${hash >>> 0}`;
  };
  let currentValue = initial;
  const states = [{ signature: signature(initial), tail: null }];
  const value = () => currentValue;
  const editsOf = (tail) => {
    const result = [];
    for (; tail; tail = tail.previous) result.push(tail.edit);
    return result.reverse();
  };
  const replay = (tail) =>
    editsOf(tail).reduce(
      (s, e) => s.slice(0, e.start) + e.text + s.slice(e.end),
      initial,
    );
  const pair = (s, at) =>
    at > 0 &&
    at < s.length &&
    s.charCodeAt(at - 1) >= 0xd800 &&
    s.charCodeAt(at - 1) <= 0xdbff &&
    s.charCodeAt(at) >= 0xdc00 &&
    s.charCodeAt(at) <= 0xdfff;
  return {
    input(next, hint = {}) {
      if (next === value()) return;
      if (hint.type === "historyUndo" || hint.type === "historyRedo") {
        const step = hint.type === "historyUndo" ? -1 : 1;
        const nextSignature = signature(next);
        for (let i = current + step; i >= 0 && i < states.length; i += step) {
          if (
            states[i].signature === nextSignature &&
            replay(states[i].tail) === next
          ) {
            current = i;
            currentValue = next;
            return;
          }
        }
      }
      const before = value();
      let start = hint.start,
        end = hint.end;
      if (hint.type?.startsWith("delete") && start === end) {
        if (hint.type.endsWith("Backward")) start = hint.afterStart;
        else end += before.length - next.length;
      }
      const insertedLength = next.length - before.length + end - start;
      const exact =
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        end >= start &&
        end <= before.length &&
        insertedLength >= 0 &&
        before.slice(0, start) === next.slice(0, start) &&
        before.slice(end) === next.slice(start + insertedLength) &&
        !pair(before, start) &&
        !pair(before, end);
      if (!exact) {
        start = 0;
        const limit = Number.isInteger(hint.start)
          ? Math.min(hint.start, before.length, next.length)
          : Math.min(before.length, next.length);
        while (start < limit && before[start] === next[start]) start++;
        if (pair(before, start) || pair(next, start)) start--;
        let suffix = 0;
        while (
          suffix < before.length - start &&
          suffix < next.length - start &&
          before[before.length - 1 - suffix] === next[next.length - 1 - suffix]
        )
          suffix++;
        if (
          pair(before, before.length - suffix) ||
          pair(next, next.length - suffix)
        )
          suffix--;
        end = before.length - suffix;
      }
      const inserted = next.slice(start, next.length - (before.length - end));
      const edit = {
        start,
        end,
        text: inserted,
        ...(hint.line ? { breakKind: "line" } : {}),
      };
      const previous = states[current].tail;
      const join =
        previous &&
        start === end &&
        start === previous.edit.start + previous.edit.text.length &&
        !inserted.includes("\n") &&
        !previous.edit.text.includes("\n") &&
        edit.breakKind === previous.edit.breakKind;
      // Consecutive typing shares one insertion, without changing earlier undo
      // snapshots or merging edits across a native paragraph/line boundary.
      const tail = join
        ? {
            edit: { ...previous.edit, text: previous.edit.text + inserted },
            previous: previous.previous,
          }
        : { edit, previous };
      states.splice(current + 1);
      states.push({ signature: signature(next), tail });
      current++;
      currentValue = next;
    },
    edits() {
      return editsOf(states[current].tail);
    },
  };
}
// Records what is typed in a textarea, from the value it holds when tracking
// starts or is rebased, so a commit can apply the edits to rich text instead
// of replacing it. Shift+Enter is recorded as a line break.
export function trackTextareaEdits(input) {
  let base = input.value;
  let history = textEditHistory(base);
  let pending = null,
    line = false;
  input.addEventListener("keydown", (e) => {
    line = e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey;
  });
  input.addEventListener("beforeinput", (e) => {
    pending = {
      start: input.selectionStart,
      end: input.selectionEnd,
      type: e.inputType,
      line,
    };
  });
  input.addEventListener("input", (e) => {
    history.input(input.value, {
      ...pending,
      type: e.inputType || pending?.type,
      afterStart: input.selectionStart,
    });
    pending = null;
    line = false;
  });
  return {
    // The value the edits start from.
    base: () => base,
    edits: () => history.edits(),
    rebase(value = input.value) {
      base = value;
      history = textEditHistory(value);
    },
  };
}
