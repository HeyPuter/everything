import { hexBytes, u16, u32 } from './bytes.js';

/**
 * Focused x86 / x86-64 decoder for Binary Studio v0.
 *
 * Covers a practical core of integer instructions used by compilers and
 * handwritten stubs (MOV, PUSH/POP, CALL/JMP/Jcc, RET, NOP, LEA, ALU,
 * TEST/CMP, INT3). Unknown opcodes are emitted as `db` so analysis can continue.
 *
 * This is not Capstone/iced coverage — gaps are expected and documented.
 */

const REG32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const REG64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi'];
const REG8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
const REG8_REX = ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil'];

export function disassemble(bytes, {
  offset = 0,
  length = bytes.length - offset,
  mode = 64,
  baseVa = 0,
  maxInstructions = 4096,
} = {}) {
  const end = Math.min(bytes.length, offset + length);
  const out = [];
  let ip = offset;
  let n = 0;
  while (ip < end && n < maxInstructions) {
    const insn = decodeOne(bytes, ip, mode, baseVa, offset);
    out.push(insn);
    ip += insn.size;
    n += 1;
    if (insn.size <= 0) break;
  }
  return out;
}

function decodeOne(buf, ip, mode, baseVa, fileBase) {
  const start = ip;
  if (ip >= buf.length) {
    return insn(start, baseVa, fileBase, [0], 'db', '0x00', {});
  }

  let rex = null;
  let prefixes = [];
  // legacy prefixes + REX
  while (ip < buf.length) {
    const b = buf[ip];
    if (b === 0x66 || b === 0x67 || b === 0xf0 || b === 0xf2 || b === 0xf3 ||
        b === 0x2e || b === 0x36 || b === 0x3e || b === 0x26 || b === 0x64 || b === 0x65) {
      prefixes.push(b);
      ip += 1;
      continue;
    }
    if (mode === 64 && b >= 0x40 && b <= 0x4f) {
      rex = b;
      ip += 1;
      break;
    }
    break;
  }

  if (ip >= buf.length) {
    return dbInsn(buf, start, baseVa, fileBase);
  }

  const op = buf[ip];
  ip += 1;
  // REX.W selects 64-bit operand size; without it, B8+rd still takes imm32
  // (zero-extended) even in long mode.
  const rexW = rex != null && (rex & 0x8) !== 0;
  const regs = mode === 64 ? REG64 : REG32;

  // Single-byte ops without ModRM
  if (op === 0x90) return finish(buf, start, ip, baseVa, fileBase, 'nop', '');
  if (op === 0xcc) return finish(buf, start, ip, baseVa, fileBase, 'int3', '');
  if (op === 0xc3) return finish(buf, start, ip, baseVa, fileBase, 'ret', '', { isRet: true });
  if (op === 0xc2 && ip + 1 < buf.length) {
    const imm = u16(buf, ip);
    ip += 2;
    return finish(buf, start, ip, baseVa, fileBase, 'ret', `0x${imm.toString(16)}`, { isRet: true });
  }

  // PUSH/POP r64/r32 (50+rd / 58+rd), with REX.B
  if (op >= 0x50 && op <= 0x57) {
    const r = (op - 0x50) | (rex && (rex & 0x1) ? 8 : 0);
    return finish(buf, start, ip, baseVa, fileBase, 'push', regName(regs, r, rex));
  }
  if (op >= 0x58 && op <= 0x5f) {
    const r = (op - 0x58) | (rex && (rex & 0x1) ? 8 : 0);
    return finish(buf, start, ip, baseVa, fileBase, 'pop', regName(regs, r, rex));
  }

  // MOV r/m, r / r, r/m  (88/89/8A/8B)
  if (op === 0x89 || op === 0x8b || op === 0x88 || op === 0x8a) {
    const modrm = readModrm(buf, ip, mode, rex, op === 0x88 || op === 0x8a);
    if (!modrm) return dbInsn(buf, start, baseVa, fileBase);
    ip = modrm.next;
    const reg = regFromModrm(regs, modrm.reg, rex, op === 0x88 || op === 0x8a);
    if (op === 0x89 || op === 0x88) {
      return finish(buf, start, ip, baseVa, fileBase, 'mov', `${modrm.text}, ${reg}`);
    }
    return finish(buf, start, ip, baseVa, fileBase, 'mov', `${reg}, ${modrm.text}`);
  }

  // MOV r64/r32, imm (B8+rd)
  if (op >= 0xb8 && op <= 0xbf) {
    const r = (op - 0xb8) | (rex && (rex & 0x1) ? 8 : 0);
    const immSize = rexW && mode === 64 ? 8 : 4;
    if (ip + immSize > buf.length) return dbInsn(buf, start, baseVa, fileBase);
    const imm = immSize === 8 ? readU64(buf, ip) : u32(buf, ip);
    ip += immSize;
    const dest =
      mode === 64 && !rexW && r < 8
        ? REG32[r]
        : regName(regs, r, rex);
    return finish(buf, start, ip, baseVa, fileBase, 'mov', `${dest}, ${fmtImm(imm)}`);
  }

  // LEA r, m (8D)
  if (op === 0x8d) {
    const modrm = readModrm(buf, ip, mode, rex, false);
    if (!modrm) return dbInsn(buf, start, baseVa, fileBase);
    ip = modrm.next;
    const reg = regFromModrm(regs, modrm.reg, rex, false);
    return finish(buf, start, ip, baseVa, fileBase, 'lea', `${reg}, ${modrm.text}`);
  }

  // CALL/JMP rel32 (E8 / E9)
  if (op === 0xe8 || op === 0xe9) {
    if (ip + 4 > buf.length) return dbInsn(buf, start, baseVa, fileBase);
    const rel = u32(buf, ip) | 0; // signed via |0 after
    const srel = rel > 0x7fffffff ? rel - 0x100000000 : rel;
    ip += 4;
    const nextVa = add(baseVa, (start - fileBase) + (ip - start));
    const target = add(nextVa, srel);
    const mnemonic = op === 0xe8 ? 'call' : 'jmp';
    return finish(buf, start, ip, baseVa, fileBase, mnemonic, fmtImm(target), {
      isCall: op === 0xe8,
      isJump: op === 0xe9,
      target,
    });
  }

  // JMP rel8 (EB)
  if (op === 0xeb) {
    if (ip >= buf.length) return dbInsn(buf, start, baseVa, fileBase);
    const rel = (buf[ip] << 24) >> 24;
    ip += 1;
    const nextVa = add(baseVa, (start - fileBase) + (ip - start));
    const target = add(nextVa, rel);
    return finish(buf, start, ip, baseVa, fileBase, 'jmp', fmtImm(target), {
      isJump: true,
      target,
    });
  }

  // Jcc rel8 (70..7F)
  if (op >= 0x70 && op <= 0x7f) {
    if (ip >= buf.length) return dbInsn(buf, start, baseVa, fileBase);
    const rel = (buf[ip] << 24) >> 24;
    ip += 1;
    const nextVa = add(baseVa, (start - fileBase) + (ip - start));
    const target = add(nextVa, rel);
    const cc = [
      'jo', 'jno', 'jb', 'jae', 'je', 'jne', 'jbe', 'ja',
      'js', 'jns', 'jp', 'jnp', 'jl', 'jge', 'jle', 'jg',
    ][op - 0x70];
    return finish(buf, start, ip, baseVa, fileBase, cc, fmtImm(target), {
      isJump: true,
      isConditional: true,
      target,
    });
  }

  // Group ALU /imm with ModRM (81 / 83)
  if (op === 0x81 || op === 0x83) {
    const modrm = readModrm(buf, ip, mode, rex, false);
    if (!modrm) return dbInsn(buf, start, baseVa, fileBase);
    ip = modrm.next;
    const names = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
    const mnemonic = names[modrm.reg] || 'alu';
    let imm;
    if (op === 0x83) {
      if (ip >= buf.length) return dbInsn(buf, start, baseVa, fileBase);
      imm = (buf[ip] << 24) >> 24;
      ip += 1;
    } else {
      if (ip + 4 > buf.length) return dbInsn(buf, start, baseVa, fileBase);
      imm = u32(buf, ip) | 0;
      ip += 4;
    }
    return finish(buf, start, ip, baseVa, fileBase, mnemonic, `${modrm.text}, ${fmtImm(imm)}`);
  }

  // TEST/XOR/CMP style 85 / 39 / 3B / 01 / 29 / 31 …
  if (op === 0x85 || op === 0x39 || op === 0x3b || op === 0x01 || op === 0x29 || op === 0x31 || op === 0x09) {
    const modrm = readModrm(buf, ip, mode, rex, false);
    if (!modrm) return dbInsn(buf, start, baseVa, fileBase);
    ip = modrm.next;
    const reg = regFromModrm(regs, modrm.reg, rex, false);
    const map = {
      0x85: 'test',
      0x39: 'cmp',
      0x3b: 'cmp',
      0x01: 'add',
      0x29: 'sub',
      0x31: 'xor',
      0x09: 'or',
    };
    const mnemonic = map[op];
    if (op === 0x3b) {
      return finish(buf, start, ip, baseVa, fileBase, mnemonic, `${reg}, ${modrm.text}`);
    }
    return finish(buf, start, ip, baseVa, fileBase, mnemonic, `${modrm.text}, ${reg}`);
  }

  // FF /2 CALL r/m, FF /4 JMP r/m
  if (op === 0xff) {
    const modrm = readModrm(buf, ip, mode, rex, false);
    if (!modrm) return dbInsn(buf, start, baseVa, fileBase);
    ip = modrm.next;
    if (modrm.reg === 2) {
      return finish(buf, start, ip, baseVa, fileBase, 'call', modrm.text, { isCall: true });
    }
    if (modrm.reg === 4) {
      return finish(buf, start, ip, baseVa, fileBase, 'jmp', modrm.text, { isJump: true });
    }
    if (modrm.reg === 6) {
      return finish(buf, start, ip, baseVa, fileBase, 'push', modrm.text);
    }
  }

  return dbInsn(buf, start, baseVa, fileBase);
}

function readModrm(buf, ip, mode, rex, is8) {
  if (ip >= buf.length) return null;
  const modrm = buf[ip];
  ip += 1;
  const mod = modrm >> 6;
  const reg = (modrm >> 3) & 7;
  const rm = modrm & 7;
  const regs = mode === 64 ? REG64 : REG32;
  const reg8 = rex ? REG8_REX : REG8;

  if (mod === 3) {
    const r = rm | (rex && (rex & 0x1) ? 8 : 0);
    return {
      next: ip,
      reg: reg | (rex && (rex & 0x4) ? 8 : 0),
      text: is8 ? regName(reg8, r, rex) : regName(regs, r, rex),
    };
  }

  // SIB
  let text;
  if (rm === 4) {
    if (ip >= buf.length) return null;
    const sib = buf[ip];
    ip += 1;
    const scale = 1 << (sib >> 6);
    const index = (sib >> 3) & 7;
    const base = sib & 7;
    const parts = [];
    if (!(index === 4 && !(rex && (rex & 0x2)))) {
      const idx = index | (rex && (rex & 0x2) ? 8 : 0);
      parts.push(scale > 1 ? `${regName(regs, idx, rex)}*${scale}` : regName(regs, idx, rex));
    }
    if (!(mod === 0 && base === 5)) {
      const b = base | (rex && (rex & 0x1) ? 8 : 0);
      parts.unshift(regName(regs, b, rex));
    } else {
      // disp32 with no base
      if (ip + 4 > buf.length) return null;
      const disp = u32(buf, ip);
      ip += 4;
      text = `[${fmtImm(disp)}${parts.length ? '+' + parts.join('+') : ''}]`;
      return { next: ip, reg: reg | (rex && (rex & 0x4) ? 8 : 0), text };
    }
    let disp = 0;
    if (mod === 1) {
      if (ip >= buf.length) return null;
      disp = (buf[ip] << 24) >> 24;
      ip += 1;
    } else if (mod === 2) {
      if (ip + 4 > buf.length) return null;
      disp = u32(buf, ip) | 0;
      ip += 4;
    }
    text = `[${parts.join('+')}${disp ? (disp < 0 ? disp.toString() : '+' + disp) : ''}]`;
    return { next: ip, reg: reg | (rex && (rex & 0x4) ? 8 : 0), text };
  }

  // mod 0 rm 5 = rip-relative (64) or disp32 (32)
  if (mod === 0 && rm === 5) {
    if (ip + 4 > buf.length) return null;
    const disp = u32(buf, ip) | 0;
    ip += 4;
    text = mode === 64 ? `[rip+${fmtImm(disp)}]` : `[${fmtImm(disp)}]`;
    return { next: ip, reg: reg | (rex && (rex & 0x4) ? 8 : 0), text };
  }

  let disp = 0;
  if (mod === 1) {
    if (ip >= buf.length) return null;
    disp = (buf[ip] << 24) >> 24;
    ip += 1;
  } else if (mod === 2) {
    if (ip + 4 > buf.length) return null;
    disp = u32(buf, ip) | 0;
    ip += 4;
  }
  const r = rm | (rex && (rex & 0x1) ? 8 : 0);
  text = `[${regName(regs, r, rex)}${disp ? (disp < 0 ? disp.toString() : '+' + disp) : ''}]`;
  return { next: ip, reg: reg | (rex && (rex & 0x4) ? 8 : 0), text };
}

function regFromModrm(regs, reg, rex, is8) {
  if (is8) return regName(rex ? REG8_REX : REG8, reg, rex);
  return regName(regs, reg, rex);
}

function regName(table, r, rex) {
  if (r < 8) return table[r];
  // extended registers
  const ext = ['r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
  const name = ext[r - 8];
  if (table === REG8 || table === REG8_REX) return name + 'b';
  if (table === REG32) return name + 'd';
  return name;
}

function finish(buf, start, next, baseVa, fileBase, mnemonic, opStr, extra = {}) {
  const size = next - start;
  const va = add(baseVa, start - fileBase);
  return insn(start, va, fileBase, [...buf.subarray(start, next)], mnemonic, opStr, extra);
}

function dbInsn(buf, start, baseVa, fileBase) {
  const b = buf[start] ?? 0;
  return insn(start, add(baseVa, start - fileBase), fileBase, [b], 'db', `0x${b.toString(16).padStart(2, '0')}`, {
    unknown: true,
  });
}

function insn(fileOffset, va, _fileBase, raw, mnemonic, opStr, extra) {
  return {
    fileOffset,
    address: va,
    addressLabel: fmtImm(va),
    bytes: raw,
    bytesHex: hexBytes(Uint8Array.from(raw), 0, raw.length),
    mnemonic,
    opStr,
    text: opStr ? `${mnemonic} ${opStr}` : mnemonic,
    size: raw.length,
    ...extra,
  };
}

function fmtImm(n) {
  if (typeof n === 'bigint') return '0x' + n.toString(16);
  if (typeof n === 'number') {
    const v = n < 0 ? (0x100000000 + n) >>> 0 : n >>> 0;
    // keep negative immediates readable when small
    if (n < 0 && n > -0x1000) return '-0x' + (-n).toString(16);
    return '0x' + v.toString(16);
  }
  return String(n);
}

function add(a, b) {
  if (typeof a === 'bigint') return a + BigInt(b);
  return (a + b) >>> 0;
}

function readU64(buf, off) {
  const lo = u32(buf, off);
  const hi = u32(buf, off + 4);
  if (hi === 0) return lo;
  return BigInt(lo) + (BigInt(hi) << 32n);
}
