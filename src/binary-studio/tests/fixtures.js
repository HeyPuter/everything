/**
 * Hand-built minimal PE and ELF images for regression tests.
 * Not meant to run as real OS images — only to exercise parsers/disasm.
 */

/** Minimal x64 PE with .text containing: mov eax,1 ; ret ; nop ; call rel ; int3 */
export function makeTinyPe() {
  // Layout:
  // 0x00 DOS stub (MZ + e_lfanew=0x80)
  // 0x80 PE headers
  // 0x200 section raw (.text)
  const file = new Uint8Array(0x400);
  // DOS
  file[0] = 0x4d;
  file[1] = 0x5a;
  writeU32(file, 0x3c, 0x80);

  // PE signature
  writeU32(file, 0x80, 0x00004550);
  // COFF: Machine AMD64, 1 section, SizeOfOptionalHeader=0xF0, Characteristics=0x22
  writeU16(file, 0x84, 0x8664);
  writeU16(file, 0x86, 1);
  writeU16(file, 0x94, 0xf0);
  writeU16(file, 0x96, 0x0022);

  const opt = 0x98;
  writeU16(file, opt, 0x20b); // PE32+
  writeU32(file, opt + 16, 0x1000); // AddressOfEntryPoint RVA
  writeU64(file, opt + 24, 0x140000000n); // ImageBase
  writeU32(file, opt + 32, 0x1000); // SectionAlignment
  writeU32(file, opt + 36, 0x200); // FileAlignment
  writeU32(file, opt + 56, 0x2000); // SizeOfImage
  writeU32(file, opt + 60, 0x200); // SizeOfHeaders
  writeU16(file, opt + 68, 3); // subsystem console
  writeU32(file, opt + 108, 16); // NumberOfRvaAndSizes
  // zero data directories

  // Section header at opt + 0xF0 = 0x98+0xF0 = 0x188
  const sh = 0x188;
  writeAscii(file, sh, '.text');
  writeU32(file, sh + 8, 0x20); // VirtualSize
  writeU32(file, sh + 12, 0x1000); // VirtualAddress
  writeU32(file, sh + 16, 0x200); // SizeOfRawData
  writeU32(file, sh + 20, 0x200); // PointerToRawData
  writeU32(file, sh + 36, 0x60000020); // CODE|EXECUTE|READ

  // Code at 0x200: B8 01 00 00 00  C3  90  E8 00 00 00 00  CC
  // mov eax,1; ret; nop; call $+5; int3
  const code = 0x200;
  file.set([0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3, 0x90, 0xe8, 0x00, 0x00, 0x00, 0x00, 0xcc], code);
  // embed a string
  writeAscii(file, 0x300, 'HelloBinaryStudio');

  return file;
}

/** Minimal ET_DYN x86-64 ELF with .text and a string in .rodata-ish area */
export function makeTinyElf() {
  // Simplified: ELF64 header + one PT_LOAD + one SHT_PROGBITS .text
  // We only need the program header path for analyze(); sections optional.
  const file = new Uint8Array(0x300);
  // e_ident
  file.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  writeU16(file, 16, 3); // ET_DYN
  writeU16(file, 18, 62); // EM_X86_64
  writeU32(file, 20, 1); // EV_CURRENT
  writeU64(file, 24, 0x1000n); // e_entry
  writeU64(file, 32, 64n); // e_phoff
  writeU64(file, 40, 0n); // e_shoff (none)
  writeU16(file, 52, 64); // e_ehsize
  writeU16(file, 54, 56); // e_phentsize
  writeU16(file, 56, 1); // e_phnum
  writeU16(file, 58, 64); // e_shentsize
  writeU16(file, 60, 0); // e_shnum
  writeU16(file, 62, 0); // e_shstrndx

  // Program header at 64
  const ph = 64;
  writeU32(file, ph, 1); // PT_LOAD
  writeU32(file, ph + 4, 5); // PF_R|PF_X
  writeU64(file, ph + 8, 0x200n); // p_offset
  writeU64(file, ph + 16, 0x1000n); // p_vaddr
  writeU64(file, ph + 24, 0x1000n); // p_paddr
  writeU64(file, ph + 32, 0x40n); // p_filesz
  writeU64(file, ph + 40, 0x40n); // p_memsz
  writeU64(file, ph + 48, 0x1000n); // p_align

  file.set([0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3, 0x90, 0xcc], 0x200);
  writeAscii(file, 0x220, 'ElfHello');
  return file;
}

/** Truncated MZ that must be rejected */
export function makeTruncatedPe() {
  const file = new Uint8Array(40);
  file[0] = 0x4d;
  file[1] = 0x5a;
  writeU32(file, 0x3c, 0x80); // points past EOF
  return file;
}

function writeU16(buf, off, v) {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
}
function writeU32(buf, off, v) {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >> 8) & 0xff;
  buf[off + 2] = (v >> 16) & 0xff;
  buf[off + 3] = (v >> 24) & 0xff;
}
function writeU64(buf, off, v) {
  const n = typeof v === 'bigint' ? v : BigInt(v);
  writeU32(buf, off, Number(n & 0xffffffffn));
  writeU32(buf, off + 4, Number((n >> 32n) & 0xffffffffn));
}
function writeAscii(buf, off, s) {
  for (let i = 0; i < s.length; i += 1) buf[off + i] = s.charCodeAt(i);
}
