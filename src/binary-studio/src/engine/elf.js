import { asciiZ, formatAddr, u16, u32, u64, viewOf } from './bytes.js';

const ELFMAG = [0x7f, 0x45, 0x4c, 0x46];
const ELFCLASS32 = 1;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const ET_EXEC = 2;
const ET_DYN = 3;
const EM_386 = 3;
const EM_X86_64 = 62;
const EM_AARCH64 = 183;
const PT_LOAD = 1;
const SHT_SYMTAB = 2;
const SHT_DYNSYM = 11;
const SHT_STRTAB = 3;

const MACHINE_NAMES = {
  [EM_386]: 'x86',
  [EM_X86_64]: 'x86-64',
  [EM_AARCH64]: 'ARM64',
};

/**
 * Parse an ELF object/executable (little-endian 32/64). Throws on malformed input.
 */
export function parseElf(input) {
  const buf = viewOf(input);
  if (buf.length < 52) throw new Error('ELF too small');
  for (let i = 0; i < 4; i += 1) {
    if (buf[i] !== ELFMAG[i]) throw new Error('not an ELF file');
  }

  const eiClass = buf[4];
  const eiData = buf[5];
  if (eiData !== ELFDATA2LSB) throw new Error('only little-endian ELF is supported');
  const is64 = eiClass === ELFCLASS64;
  if (!is64 && eiClass !== ELFCLASS32) throw new Error(`unsupported ELF class ${eiClass}`);

  const e_type = u16(buf, 16);
  const e_machine = u16(buf, 18);
  const e_entry = is64 ? u64(buf, 24) : u32(buf, 24);
  const e_phoff = is64 ? Number(u64(buf, 32)) : u32(buf, 28);
  const e_shoff = is64 ? Number(u64(buf, 40)) : u32(buf, 32);
  const e_phentsize = u16(buf, is64 ? 54 : 42);
  const e_phnum = u16(buf, is64 ? 56 : 44);
  const e_shentsize = u16(buf, is64 ? 58 : 46);
  const e_shnum = u16(buf, is64 ? 60 : 48);
  const e_shstrndx = u16(buf, is64 ? 62 : 50);

  const segments = [];
  for (let i = 0; i < e_phnum; i += 1) {
    const o = e_phoff + i * e_phentsize;
    if (o + e_phentsize > buf.length) throw new Error('ELF truncated in program headers');
    if (is64) {
      const p_type = u32(buf, o);
      const p_flags = u32(buf, o + 4);
      const p_offset = Number(u64(buf, o + 8));
      const p_vaddr = u64(buf, o + 16);
      const p_filesz = Number(u64(buf, o + 32));
      const p_memsz = Number(u64(buf, o + 40));
      if (p_offset + p_filesz > buf.length && p_filesz) {
        throw new Error('ELF segment exceeds file');
      }
      segments.push({
        type: p_type,
        flags: p_flags,
        offset: p_offset,
        vaddr: p_vaddr,
        filesz: p_filesz,
        memsz: p_memsz,
        load: p_type === PT_LOAD,
      });
    } else {
      const p_type = u32(buf, o);
      const p_offset = u32(buf, o + 4);
      const p_vaddr = u32(buf, o + 8);
      const p_filesz = u32(buf, o + 16);
      const p_memsz = u32(buf, o + 20);
      const p_flags = u32(buf, o + 24);
      if (p_offset + p_filesz > buf.length && p_filesz) {
        throw new Error('ELF segment exceeds file');
      }
      segments.push({
        type: p_type,
        flags: p_flags,
        offset: p_offset,
        vaddr: p_vaddr,
        filesz: p_filesz,
        memsz: p_memsz,
        load: p_type === PT_LOAD,
      });
    }
  }

  const shstrOff = sectionOffset(buf, is64, e_shoff, e_shentsize, e_shstrndx);
  const sections = [];
  for (let i = 0; i < e_shnum; i += 1) {
    const o = e_shoff + i * e_shentsize;
    if (o + e_shentsize > buf.length) throw new Error('ELF truncated in section headers');
    const sh = readSectionHeader(buf, o, is64);
    const name =
      shstrOff != null && sh.nameIdx
        ? asciiZ(buf, shstrOff + sh.nameIdx, 64)
        : '';
    if (sh.type !== 0 && sh.offset + sh.size > buf.length && sh.size) {
      throw new Error(`section ${name || i} exceeds file`);
    }
    sections.push({ ...sh, name });
  }

  const symbols = collectSymbols(buf, sections, is64);
  const arch = MACHINE_NAMES[e_machine] || `machine-${e_machine}`;
  const entryFile = vaddrToFileOffset(segments, e_entry);

  return {
    format: 'ELF',
    is64,
    arch,
    machine: e_machine,
    type: e_type,
    typeName: e_type === ET_EXEC ? 'EXEC' : e_type === ET_DYN ? 'DYN' : `type-${e_type}`,
    entryPoint: {
      va: e_entry,
      fileOffset: entryFile,
      label: formatAddr(e_entry, is64 ? 16 : 8),
    },
    segments,
    sections,
    symbols,
    imports: symbols.filter((s) => s.bind === 'GLOBAL' && s.shndx === 0),
    exports: symbols.filter((s) => s.bind === 'GLOBAL' && s.shndx !== 0 && s.name),
    bytes: buf,
  };
}

function sectionOffset(buf, is64, shoff, shentsize, idx) {
  if (!shoff || idx >= 0xffff) return null;
  const o = shoff + idx * shentsize;
  if (o + shentsize > buf.length) return null;
  const sh = readSectionHeader(buf, o, is64);
  return sh.offset;
}

function readSectionHeader(buf, o, is64) {
  if (is64) {
    return {
      nameIdx: u32(buf, o),
      type: u32(buf, o + 4),
      flags: u64(buf, o + 8),
      addr: u64(buf, o + 16),
      offset: Number(u64(buf, o + 24)),
      size: Number(u64(buf, o + 32)),
      link: u32(buf, o + 40),
      info: u32(buf, o + 44),
      entsize: Number(u64(buf, o + 56)),
    };
  }
  return {
    nameIdx: u32(buf, o),
    type: u32(buf, o + 4),
    flags: u32(buf, o + 8),
    addr: u32(buf, o + 12),
    offset: u32(buf, o + 16),
    size: u32(buf, o + 20),
    link: u32(buf, o + 24),
    info: u32(buf, o + 28),
    entsize: u32(buf, o + 36),
  };
}

function collectSymbols(buf, sections, is64) {
  const out = [];
  for (const sec of sections) {
    if (sec.type !== SHT_SYMTAB && sec.type !== SHT_DYNSYM) continue;
    const str = sections[sec.link];
    if (!str || str.type !== SHT_STRTAB) continue;
    const ent = sec.entsize || (is64 ? 24 : 16);
    const count = Math.floor(sec.size / ent);
    for (let i = 0; i < count; i += 1) {
      const o = sec.offset + i * ent;
      if (o + ent > buf.length) break;
      let nameIdx;
      let value;
      let size;
      let info;
      let shndx;
      if (is64) {
        nameIdx = u32(buf, o);
        info = buf[o + 4];
        shndx = u16(buf, o + 6);
        value = u64(buf, o + 8);
        size = Number(u64(buf, o + 16));
      } else {
        nameIdx = u32(buf, o);
        value = u32(buf, o + 4);
        size = u32(buf, o + 8);
        info = buf[o + 12];
        shndx = u16(buf, o + 14);
      }
      const bind = info >> 4;
      const type = info & 0xf;
      out.push({
        name: asciiZ(buf, str.offset + nameIdx, 256),
        value,
        size,
        bind: bind === 1 ? 'GLOBAL' : bind === 2 ? 'WEAK' : 'LOCAL',
        type: type === 2 ? 'FUNC' : type === 1 ? 'OBJECT' : `t${type}`,
        shndx,
        dynamic: sec.type === SHT_DYNSYM,
      });
    }
  }
  return out;
}

export function vaddrToFileOffset(segments, vaddr) {
  const v = typeof vaddr === 'bigint' ? vaddr : BigInt(vaddr >>> 0);
  for (const s of segments) {
    if (!s.load || !s.filesz) continue;
    const base = typeof s.vaddr === 'bigint' ? s.vaddr : BigInt(s.vaddr >>> 0);
    const end = base + BigInt(s.filesz);
    if (v >= base && v < end) {
      return s.offset + Number(v - base);
    }
  }
  return null;
}
