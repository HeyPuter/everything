// The Node APIs the tests use; the project does not depend on @types/node.
declare module 'node:fs' {
  export function readFileSync(path: URL | string): Uint8Array;
  export function writeFileSync(path: string, data: string): void;
  export function truncateSync(path: string, length: number): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function rmSync(path: string): void;
}
