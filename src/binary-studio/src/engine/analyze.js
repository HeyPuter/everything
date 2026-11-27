import { openBinary } from './detect.js';
import { disassemble } from './disasm-x86.js';
import { discoverFunctions, resolveBranchTargets } from './functions.js';
import { findStrings } from './strings.js';
import { fileOffsetToRva, rvaToFileOffset } from './pe.js';
import { vaddrToFileOffset } from './elf.js';

/**
 * Full static analysis pass for a PE/ELF buffer.
 * Never executes the binary.
 */
export function analyzeBinary(input, options = {}) {
  const doc = openBinary(input, options);
  const bytes = doc.bytes;
  const mode = doc.arch === 'x86' ? 32 : 64;

  let codeRegions = [];
  if (doc.format === 'PE') {
    codeRegions = doc.sections
      .filter((s) => /text/i.test(s.name) || (s.characteristics & 0x20000000) !== 0)
      .map((s) => ({
        offset: s.pointerToRawData,
        length: s.sizeOfRawData,
        va: add(doc.imageBase, s.virtualAddress),
      }))
      .filter((r) => r.offset && r.length);
  } else {
    codeRegions = doc.segments
      .filter((s) => s.load && (s.flags & 1) !== 0) // PF_X
      .map((s) => ({
        offset: s.offset,
        length: s.filesz,
        va: s.vaddr,
      }));
    if (!codeRegions.length) {
      const text = doc.sections.find((s) => s.name === '.text');
      if (text) {
        codeRegions.push({ offset: text.offset, length: text.size, va: text.addr });
      }
    }
  }

  // Prefer entry section if present
  if (doc.entryPoint?.fileOffset != null && !codeRegions.length) {
    codeRegions.push({
      offset: doc.entryPoint.fileOffset,
      length: Math.min(4096, bytes.length - doc.entryPoint.fileOffset),
      va: doc.entryPoint.va ?? doc.entryPoint.rva ?? 0,
    });
  }

  const instructions = [];
  for (const region of codeRegions) {
    const chunk = disassemble(bytes, {
      offset: region.offset,
      length: region.length,
      mode,
      baseVa: region.va,
      maxInstructions: options.maxInstructions || 8192,
    });
    instructions.push(...chunk);
  }

  const vaToFile = (va) => {
    if (doc.format === 'PE') {
      const base = doc.imageBase;
      const rva =
        typeof va === 'bigint'
          ? Number(va - (typeof base === 'bigint' ? base : BigInt(base)))
          : (va - (typeof base === 'number' ? base : Number(base))) >>> 0;
      return rvaToFileOffset(doc.sections, rva);
    }
    return vaddrToFileOffset(doc.segments, va);
  };

  resolveBranchTargets(instructions, vaToFile);

  // Map ELF FUNC symbols to file offsets
  const symbols = (doc.symbols || []).map((s) => ({
    ...s,
    fileOffset: typeof s.value === 'number' || typeof s.value === 'bigint' ? vaToFile(s.value) : null,
  }));

  const functions = discoverFunctions({
    instructions,
    entryFileOffset: doc.entryPoint?.fileOffset ?? null,
    symbols,
  });

  const strings = findStrings(bytes);

  return {
    ...doc,
    codeRegions,
    instructions,
    functions,
    strings,
    symbols,
    vaToFile,
    fileToVa(off) {
      if (doc.format === 'PE') {
        const rva = fileOffsetToRva(doc.sections, off);
        if (rva == null) return null;
        return add(doc.imageBase, rva);
      }
      for (const s of doc.segments) {
        if (s.load && off >= s.offset && off < s.offset + s.filesz) {
          return add(s.vaddr, off - s.offset);
        }
      }
      return null;
    },
  };
}

function add(a, b) {
  if (typeof a === 'bigint') return a + BigInt(b);
  return (a + b) >>> 0;
}
