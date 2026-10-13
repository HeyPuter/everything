// The one Node API the tests use; the project does not depend on @types/node.
declare module 'node:fs' {
  export function readFileSync(path: URL | string): Uint8Array;
}
