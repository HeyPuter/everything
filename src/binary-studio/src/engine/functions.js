/**
 * Heuristic function discovery from disassembly.
 * Marks confirmed (symbol / entry) vs inferred (call targets, prologue patterns).
 */

export function discoverFunctions({ instructions, entryFileOffset = null, symbols = [] }) {
  const byOffset = new Map();
  const mark = (fileOffset, reason, confidence) => {
    if (fileOffset == null || fileOffset < 0) return;
    const prev = byOffset.get(fileOffset);
    if (!prev || confidenceRank(confidence) > confidenceRank(prev.confidence)) {
      byOffset.set(fileOffset, {
        fileOffset,
        confidence,
        reasons: prev ? [...new Set([...prev.reasons, reason])] : [reason],
      });
    } else if (prev) {
      prev.reasons = [...new Set([...prev.reasons, reason])];
    }
  };

  if (entryFileOffset != null) mark(entryFileOffset, 'entry', 'confirmed');

  for (const s of symbols) {
    if (s.type === 'FUNC' && typeof s.fileOffset === 'number') {
      mark(s.fileOffset, `symbol:${s.name || '?'}`, 'confirmed');
    }
  }

  for (const insn of instructions) {
    if (insn.isCall && insn.target != null && insn.targetFileOffset != null) {
      mark(insn.targetFileOffset, 'call-target', 'inferred');
    }
    // common prologues: push rbp / mov rbp, rsp
    if (insn.mnemonic === 'push' && /rbp|ebp/.test(insn.opStr || '')) {
      mark(insn.fileOffset, 'prologue-push-bp', 'inferred');
    }
  }

  const funcs = [...byOffset.values()].sort((a, b) => a.fileOffset - b.fileOffset);
  return funcs.map((f, i) => {
    const start = f.fileOffset;
    const next = funcs[i + 1]?.fileOffset ?? null;
    const body = instructions.filter(
      (ins) => ins.fileOffset >= start && (next == null || ins.fileOffset < next),
    );
    const blocks = buildBasicBlocks(body);
    const calls = body
      .filter((ins) => ins.isCall && ins.target != null)
      .map((ins) => ({ from: ins.fileOffset, to: ins.target, toFile: ins.targetFileOffset }));
    return {
      id: `fn_${start.toString(16)}`,
      ...f,
      name:
        f.reasons.find((r) => r.startsWith('symbol:'))?.slice(7) ||
        (f.reasons.includes('entry') ? 'entry' : `sub_${start.toString(16)}`),
      size: body.reduce((n, ins) => n + ins.size, 0),
      instructionCount: body.length,
      blocks,
      calls,
    };
  });
}

function confidenceRank(c) {
  return c === 'confirmed' ? 2 : 1;
}

export function buildBasicBlocks(instructions) {
  if (!instructions.length) return [];
  const leaders = new Set([instructions[0].fileOffset]);
  for (const ins of instructions) {
    if ((ins.isJump || ins.isCall) && ins.targetFileOffset != null) {
      leaders.add(ins.targetFileOffset);
    }
    if (ins.isJump || ins.isRet) {
      const idx = instructions.indexOf(ins);
      if (idx >= 0 && idx + 1 < instructions.length) {
        leaders.add(instructions[idx + 1].fileOffset);
      }
    }
  }

  const sorted = [...leaders].sort((a, b) => a - b);
  const blocks = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const start = sorted[i];
    const end = sorted[i + 1] ?? Infinity;
    const body = instructions.filter((ins) => ins.fileOffset >= start && ins.fileOffset < end);
    if (!body.length) continue;
    const last = body[body.length - 1];
    const successors = [];
    if (last.isJump && last.targetFileOffset != null) successors.push(last.targetFileOffset);
    if (!last.isJump || last.isConditional) {
      const fall = last.fileOffset + last.size;
      if (instructions.some((ins) => ins.fileOffset === fall)) successors.push(fall);
    }
    blocks.push({
      id: `bb_${start.toString(16)}`,
      start,
      end: last.fileOffset + last.size,
      instructions: body,
      successors,
    });
  }
  return blocks;
}

/**
 * Attach file offsets for call/jump targets when VA→file mapping is available.
 */
export function resolveBranchTargets(instructions, vaToFile) {
  for (const ins of instructions) {
    if (ins.target == null) continue;
    const fo = vaToFile(ins.target);
    if (fo != null) ins.targetFileOffset = fo;
  }
  return instructions;
}
