# Binary Studio

Browser-based **static** binary analysis for PE and ELF images. Open a file,
inspect sections/segments, browse hex + ASCII, disassemble x86 / x86-64 code,
list heuristically discovered functions (with basic blocks), and search
strings — without ever executing the uploaded binary.

Binary Studio is an original open-source app under Everything. It aims at
workflows similar to IDA Pro, Ghidra, Binary Ninja, or Cutter, not a clone of
their UI, assets, or proprietary code.

> **v0 / alpha.** Parsers and the instruction decoder are intentionally
> incomplete. Do not treat results as authoritative for malware triage or
> shipping reverse-engineering work.

## Features (v0)

- **PE & ELF loaders** — metadata, sections/segments, entry point, imports /
  exports when present; truncated or malformed input is rejected
- **Hex + ASCII view** — synchronized selection with disassembly
- **x86 / x86-64 disassembly** — address, bytes, mnemonic, operands for a
  practical core of integer instructions; unknown opcodes become `db`
- **Functions & CFG data** — entry + symbol + call-target / prologue heuristics,
  basic blocks and successor edges (no graph renderer yet)
- **Strings** — ASCII and simple UTF-16LE extraction with filter
- **Sessions** — comments and bookmarks persisted in `localStorage` (keyed by
  optional SHA-256 of the file)

## Non-goals / limitations

- **No decompiler** — there is no C/pseudocode lifting in v0
- **No debugger / emulator** — binaries are never run
- **Incomplete ISA coverage** — not Capstone, iced-x86, or full Ghidra decode
- **No ARM/MIPS/etc. disassembly** yet (format detect may still label arch)
- **64 MiB** soft size cap for in-memory analysis
- Session restore reapplies annotations to an already-opened matching file; the
  binary bytes themselves are not stored in localStorage

## Run locally

```bash
cd src/binary-studio
npm install
npm run dev
```

Vite serves the app at `http://binary-studio.puter.localhost:<port>/` via the
shared `puter-localhost` plugin.

```bash
npm test
npm run build
```

## License

MIT — see [LICENSE](./LICENSE).

## Related

Proposal: [HeyPuter/everything#99](https://github.com/HeyPuter/everything/issues/99)
