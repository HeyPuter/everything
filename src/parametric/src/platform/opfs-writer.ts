// Writes files to the browser's private storage (OPFS) for browsers whose
// pages cannot write there themselves: Safari before 26 has no
// createWritable(), only the synchronous access handles of a worker.

interface WriteRequest {
  id: number;
  dir: string;
  name: string;
  text: string;
}

export interface SyncAccessHandle {
  getSize(): number | Promise<number>;
  truncate(size: number): void | Promise<void>;
  write(data: Uint8Array, options: { at: number }): number | Promise<number>;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
}

/**
 * Replaces the file's contents. The room for the new contents is taken
 * before the old ones are touched, so a full disk fails the write and leaves
 * the file as it was, instead of emptied or cut short.
 */
export async function writeAll(handle: SyncAccessHandle, data: Uint8Array) {
  if (data.length > (await handle.getSize())) await handle.truncate(data.length);
  for (let at = 0; at < data.length;) {
    const n = await handle.write(data.subarray(at), { at });
    if (!(n > 0)) throw new Error('The file could not be written.');
    at += n;
  }
  await handle.truncate(data.length);
  await handle.flush();
}

self.onmessage = async (e: MessageEvent<WriteRequest>) => {
  const { id, dir, name, text } = e.data;
  try {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle(dir, { create: true });
    const file = await folder.getFileHandle(name, { create: true });
    // Safari 15.2 to 16 return promises from these methods; later browsers do not.
    const handle = await (
      file as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }
    ).createSyncAccessHandle();
    try {
      await writeAll(handle, new TextEncoder().encode(text));
    } finally {
      await handle.close();
    }
    self.postMessage({ id, ok: true });
  } catch (err) {
    const { name: errorName = 'Error', message = String(err) } = (err ?? {}) as {
      name?: string;
      message?: string;
    };
    self.postMessage({ id, ok: false, name: errorName, message });
  }
};
