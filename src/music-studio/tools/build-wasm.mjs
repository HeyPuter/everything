// Builds wasm/engine (Rust) into src/engine/engine.wasm. The built file is
// committed, so the app builds without a Rust toolchain; run this after
// editing the crate. The pinned toolchain (wasm/engine/rust-toolchain.toml)
// is used directly from ~/.rustup when no rustup proxy is on PATH.
// CARGO_TARGET_DIR may point at a shared directory to save disk space.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const crate = path.join(root, 'wasm/engine');
const targetDir = process.env.CARGO_TARGET_DIR || path.join(root, 'wasm/target');

const toolchain = fs.readFileSync(path.join(crate, 'rust-toolchain.toml'), 'utf8').match(/channel\s*=\s*"([^"]+)"/)?.[1];
const env = { ...process.env, RUSTFLAGS: '-C target-feature=+simd128' };
const toolchains = path.join(os.homedir(), '.rustup/toolchains');
if (toolchain && fs.existsSync(toolchains)) {
  const dir = fs.readdirSync(toolchains).find((d) => d.startsWith(`${toolchain}-`));
  if (dir) env.PATH = `${path.join(toolchains, dir, 'bin')}${path.delimiter}${env.PATH}`;
}

execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--target-dir', targetDir], { cwd: crate, stdio: 'inherit', env });
const out = path.join(targetDir, 'wasm32-unknown-unknown/release/engine.wasm');
fs.copyFileSync(out, path.join(root, 'src/engine/engine.wasm'));
console.log(`engine.wasm: ${fs.statSync(out).size} bytes`);
