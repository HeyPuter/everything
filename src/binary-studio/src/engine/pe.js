import { asciiZ, formatAddr, u16, u32, u64, viewOf } from './bytes.js';

const IMAGE_DOS_SIGNATURE = 0x5a4d; // MZ
const IMAGE_NT_SIGNATURE = 0x00004550; // PE\0\0
const IMAGE_FILE_MACHINE_I386 = 0x014c;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64 = 0xaa64;
const IMAGE_NT_OPTIONAL_HDR32_MAGIC = 0x10b;
const IMAGE_NT_OPTIONAL_HDR64_MAGIC = 0x20b;

const MACHINE_NAMES = {
  [IMAGE_FILE_MACHINE_I386]: 'x86',
  [IMAGE_FILE_MACHINE_AMD64]: 'x86-64',
  [IMAGE_FILE_MACHINE_ARM64]: 'ARM64',
};

/**
 * Parse a PE/COFF image. Throws on truncated or malformed input.
 * Does not map the image into a process — file offsets and RVAs only.
 */
export function parsePe(input) {
  const buf = viewOf(input);
  if (buf.length < 64) throw new Error('PE too small for DOS header');
  if (u16(buf, 0) !== IMAGE_DOS_SIGNATURE) throw new Error('not a PE file (missing MZ)');

  const e_lfanew = u32(buf, 0x3c);
  if (e_lfanew + 24 > buf.length) throw new Error('PE truncated before COFF header');
  if (u32(buf, e_lfanew) !== IMAGE_NT_SIGNATURE) throw new Error('not a PE file (missing PE signature)');

  const coffOff = e_lfanew + 4;
  const machine = u16(buf, coffOff);
  const numberOfSections = u16(buf, coffOff + 2);
  const timeDateStamp = u32(buf, coffOff + 4);
  const sizeOfOptionalHeader = u16(buf, coffOff + 16);
  const characteristics = u16(buf, coffOff + 18);

  const optOff = coffOff + 20;
  if (optOff + sizeOfOptionalHeader > buf.length) {
    throw new Error('PE truncated before optional header end');
  }
  if (sizeOfOptionalHeader < 24) throw new Error('optional header too small');

  const magic = u16(buf, optOff);
  const pe32Plus = magic === IMAGE_NT_OPTIONAL_HDR64_MAGIC;
  if (!pe32Plus && magic !== IMAGE_NT_OPTIONAL_HDR32_MAGIC) {
    throw new Error(`unsupported optional header magic 0x${magic.toString(16)}`);
  }

  const addressOfEntryPoint = u32(buf, optOff + 16);
  const imageBase = pe32Plus ? u64(buf, optOff + 24) : u32(buf, optOff + 28);
  const sectionAlignment = u32(buf, optOff + (pe32Plus ? 32 : 32));
  const fileAlignment = u32(buf, optOff + (pe32Plus ? 36 : 36));
  const sizeOfImage = u32(buf, optOff + (pe32Plus ? 56 : 56));
  const sizeOfHeaders = u32(buf, optOff + (pe32Plus ? 60 : 60));
  const subsystem = u16(buf, optOff + (pe32Plus ? 68 : 68));
  const numberOfRvaAndSizes = u32(buf, optOff + (pe32Plus ? 108 : 92));

  const dataDirs = [];
  const ddOff = pe32Plus ? optOff + 112 : optOff + 96;
  for (let i = 0; i < Math.min(numberOfRvaAndSizes, 16); i += 1) {
    const o = ddOff + i * 8;
    if (o + 8 > optOff + sizeOfOptionalHeader) break;
    dataDirs.push({ rva: u32(buf, o), size: u32(buf, o + 4) });
  }

  const sectionTableOff = optOff + sizeOfOptionalHeader;
  const sections = [];
  for (let i = 0; i < numberOfSections; i += 1) {
    const o = sectionTableOff + i * 40;
    if (o + 40 > buf.length) throw new Error('PE truncated in section table');
    const name = asciiZ(buf, o, 8);
    const virtualSize = u32(buf, o + 8);
    const virtualAddress = u32(buf, o + 12);
    const sizeOfRawData = u32(buf, o + 16);
    const pointerToRawData = u32(buf, o + 20);
    const characteristicsSec = u32(buf, o + 36);
    if (pointerToRawData && pointerToRawData + sizeOfRawData > buf.length) {
      throw new Error(`section ${name || i} raw data exceeds file`);
    }
    sections.push({
      name,
      virtualSize,
      virtualAddress,
      sizeOfRawData,
      pointerToRawData,
      characteristics: characteristicsSec,
    });
  }

  const arch = MACHINE_NAMES[machine] || `machine-0x${machine.toString(16)}`;
  const entryRva = addressOfEntryPoint;
  const entryFile = rvaToFileOffset(sections, entryRva);

  const imports = parseImports(buf, sections, dataDirs[1]);
  const exports_ = parseExports(buf, sections, dataDirs[0]);

  return {
    format: 'PE',
    pe32Plus,
    arch,
    machine,
    characteristics,
    timeDateStamp,
    imageBase,
    entryPoint: {
      rva: entryRva,
      va: addAddr(imageBase, entryRva),
      fileOffset: entryFile,
      label: formatAddr(addAddr(imageBase, entryRva), pe32Plus ? 16 : 8),
    },
    sectionAlignment,
    fileAlignment,
    sizeOfImage,
    sizeOfHeaders,
    subsystem,
    sections,
    dataDirectories: dataDirs,
    imports,
    exports: exports_,
    bytes: buf,
  };
}

export function rvaToFileOffset(sections, rva) {
  if (rva == null) return null;
  for (const s of sections) {
    const size = Math.max(s.virtualSize, s.sizeOfRawData);
    if (rva >= s.virtualAddress && rva < s.virtualAddress + size) {
      if (!s.pointerToRawData) return null;
      return s.pointerToRawData + (rva - s.virtualAddress);
    }
  }
  return null;
}

export function fileOffsetToRva(sections, off) {
  for (const s of sections) {
    if (
      s.pointerToRawData &&
      off >= s.pointerToRawData &&
      off < s.pointerToRawData + s.sizeOfRawData
    ) {
      return s.virtualAddress + (off - s.pointerToRawData);
    }
  }
  return null;
}

function addAddr(base, rva) {
  if (typeof base === 'bigint') return base + BigInt(rva >>> 0);
  return (base + rva) >>> 0;
}

function parseImports(buf, sections, dir) {
  if (!dir || !dir.rva || !dir.size) return [];
  const list = [];
  let off = rvaToFileOffset(sections, dir.rva);
  if (off == null) return [];
  for (let n = 0; n < 256; n += 1) {
    if (off + 20 > buf.length) break;
    const originalFirstThunk = u32(buf, off);
    const nameRva = u32(buf, off + 12);
    const firstThunk = u32(buf, off + 16);
    if (!originalFirstThunk && !nameRva && !firstThunk) break;
    const nameOff = nameRva ? rvaToFileOffset(sections, nameRva) : null;
    const dll = nameOff != null ? asciiZ(buf, nameOff, 260) : '';
    list.push({ dll, originalFirstThunk, firstThunk, nameRva });
    off += 20;
  }
  return list;
}

function parseExports(buf, sections, dir) {
  if (!dir || !dir.rva || !dir.size) return { name: '', functions: [] };
  const off = rvaToFileOffset(sections, dir.rva);
  if (off == null || off + 40 > buf.length) return { name: '', functions: [] };
  const nameRva = u32(buf, off + 12);
  const ordinalBase = u32(buf, off + 16);
  const numberOfFunctions = u32(buf, off + 20);
  const numberOfNames = u32(buf, off + 24);
  const addrTableRva = u32(buf, off + 28);
  const namePtrRva = u32(buf, off + 32);
  const ordTableRva = u32(buf, off + 36);

  const nameOff = nameRva ? rvaToFileOffset(sections, nameRva) : null;
  const moduleName = nameOff != null ? asciiZ(buf, nameOff, 260) : '';

  const functions = [];
  const namePtrOff = namePtrRva ? rvaToFileOffset(sections, namePtrRva) : null;
  const ordOff = ordTableRva ? rvaToFileOffset(sections, ordTableRva) : null;
  const addrOff = addrTableRva ? rvaToFileOffset(sections, addrTableRva) : null;
  if (namePtrOff == null || ordOff == null || addrOff == null) {
    return { name: moduleName, functions };
  }

  const limit = Math.min(numberOfNames, 4096);
  for (let i = 0; i < limit; i += 1) {
    const nRva = u32(buf, namePtrOff + i * 4);
    const nOff = rvaToFileOffset(sections, nRva);
    const ordinal = u16(buf, ordOff + i * 2);
    const funcRva = u32(buf, addrOff + ordinal * 4);
    functions.push({
      name: nOff != null ? asciiZ(buf, nOff, 260) : '',
      ordinal: ordinalBase + ordinal,
      rva: funcRva,
    });
  }
  return { name: moduleName, functions, numberOfFunctions };
}
