import { describe, expect, it } from 'vitest';
import { analyzeBinary } from '../src/engine/analyze.js';
import { openBinary } from '../src/engine/detect.js';
import { disassemble } from '../src/engine/disasm-x86.js';
import { parseElf } from '../src/engine/elf.js';
import { parsePe } from '../src/engine/pe.js';
import { makeTinyElf, makeTinyPe, makeTruncatedPe } from './fixtures.js';

describe('PE loader', () => {
  it('parses a minimal PE32+ image', () => {
    const pe = parsePe(makeTinyPe());
    expect(pe.format).toBe('PE');
    expect(pe.pe32Plus).toBe(true);
    expect(pe.arch).toBe('x86-64');
    expect(pe.sections).toHaveLength(1);
    expect(pe.sections[0].name).toBe('.text');
    expect(pe.entryPoint.fileOffset).toBe(0x200);
    expect(pe.entryPoint.rva).toBe(0x1000);
  });

  it('rejects truncated PE', () => {
    expect(() => parsePe(makeTruncatedPe())).toThrow(/PE too small|truncated|not a PE/i);
    expect(() => openBinary(makeTruncatedPe())).toThrow();
  });

  it('rejects random junk', () => {
    expect(() => openBinary(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(/unsupported/i);
  });
});

describe('ELF loader', () => {
  it('parses a minimal ELF64 ET_DYN', () => {
    const elf = parseElf(makeTinyElf());
    expect(elf.format).toBe('ELF');
    expect(elf.is64).toBe(true);
    expect(elf.arch).toBe('x86-64');
    expect(elf.entryPoint.fileOffset).toBe(0x200);
    expect(elf.segments.some((s) => s.load)).toBe(true);
  });
});

describe('x86-64 disassembly', () => {
  it('decodes known instruction bytes', () => {
    const bytes = Uint8Array.from([
      0xb8, 0x01, 0x00, 0x00, 0x00, // mov eax, 1
      0xc3, // ret
      0x90, // nop
      0xe8, 0x00, 0x00, 0x00, 0x00, // call $+5
      0xcc, // int3
    ]);
    const insns = disassemble(bytes, { mode: 64, baseVa: 0x1000 });
    expect(insns[0].mnemonic).toBe('mov');
    expect(insns[0].opStr).toMatch(/eax,\s*0x1/);
    expect(insns[0].size).toBe(5);
    expect(insns[1].mnemonic).toBe('ret');
    expect(insns[2].mnemonic).toBe('nop');
    expect(insns[3].mnemonic).toBe('call');
    expect(insns[3].isCall).toBe(true);
    expect(insns[4].mnemonic).toBe('int3');
  });
});

describe('analyzeBinary', () => {
  it('discovers entry function and strings in PE', () => {
    const doc = analyzeBinary(makeTinyPe());
    expect(doc.instructions.length).toBeGreaterThan(0);
    expect(doc.functions.some((f) => f.reasons.includes('entry'))).toBe(true);
    expect(doc.functions[0].blocks.length).toBeGreaterThan(0);
    expect(doc.strings.some((s) => s.value.includes('HelloBinaryStudio'))).toBe(true);
  });

  it('analyzes ELF demo and finds string', () => {
    const doc = analyzeBinary(makeTinyElf());
    expect(doc.format).toBe('ELF');
    expect(doc.instructions.some((i) => i.mnemonic === 'ret')).toBe(true);
    expect(doc.strings.some((s) => s.value === 'ElfHello')).toBe(true);
  });
});
