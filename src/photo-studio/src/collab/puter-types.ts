// The parts of Puter.js collaboration uses (the real SDK or a test fake).
import type { PeerApi } from './peers';

export interface CollabPuter {
  authToken?: string;
  APIOrigin: string;
  auth: {
    isSignedIn(): boolean;
    signIn(): Promise<unknown>;
    getUser(): Promise<{ uuid: string; username: string }>;
  };
  kv: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown, options?: unknown): Promise<unknown>;
  };
  fs: {
    write(path: string, data: string | Blob, options?: Record<string, unknown>): Promise<{ path: string }>;
    getReadURL(path: string, expiresIn?: string): Promise<string>;
  };
  workers: {
    create(name: string, path: string): Promise<{ url?: string }>;
    exec(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: RequestRedirect }): Promise<Response>;
  };
  events?: {
    onLocal(subject: string, fn: (payload: { event?: { key?: string; ts?: number; value?: unknown } }) => void, options?: { includeValue?: boolean }): Promise<{ off(): void }>;
  };
  peer?: PeerApi;
}

/** The page's Puter.js, when it offers what collaboration needs. */
export function collabPuter(): CollabPuter {
  const p = (globalThis as { puter?: Partial<CollabPuter> }).puter;
  if (!p?.workers?.exec || !p.workers.create || !p.kv?.get || !p.fs?.getReadURL || !p.auth?.getUser)
    throw new Error('Shared documents need Puter. Open Photo Studio from Puter or check your connection, then try again.');
  return p as CollabPuter;
}
