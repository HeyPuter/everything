import { describe, it, expect, vi, afterEach } from "vitest";
import {
  saveFile,
  readFile,
  listFiles,
  canSignOut,
  signIn,
  signOut,
  SaveQueue,
  isNotFound,
  modifiedMs,
  inTrash,
  inAppFolder,
  folderName,
  stat,
  statByUid,
  renameFile,
  pickFile,
  saveFileAs,
  downloadBlob,
  onWindowClose,
  onLaunch,
} from "../src/cloud.js";
afterEach(() => vi.unstubAllGlobals());
describe("Puter storage boundary", () => {
  it("checks import size before reading bytes while allowing full downloads", async () => {
    // Only the reported size matters; the bytes stay small.
    const sized = (size) => ({
      size,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });
    const blob = sized(201 * 1024 * 1024);
    const read = vi.fn().mockResolvedValue(blob);
    vi.stubGlobal("puter", { fs: { read } });
    await expect(readFile("/large.pptx", { importing: true })).rejects.toThrow(
      "Please choose a PPTX file smaller than 200 MB.",
    );
    expect(blob.arrayBuffer).not.toHaveBeenCalled();
    expect((await readFile("/large.pptx")).byteLength).toBe(8);
    expect(blob.arrayBuffer).toHaveBeenCalledOnce();
    const limit = sized(200 * 1024 * 1024);
    read.mockResolvedValue(limit);
    await readFile("/limit.pptx", { importing: true });
    expect(limit.arrayBuffer).toHaveBeenCalledOnce();
  });
  it("writes actual PPTX blobs to FS with non-destructive first-save options", async () => {
    const write = vi
      .fn()
      .mockResolvedValue({ path: "Presentations/Idea.pptx" });
    const kv = new Proxy(
      {},
      {
        get() {
          throw Error("Files must never touch KV");
        },
      },
    );
    vi.stubGlobal("puter", { fs: { write }, kv });
    await saveFile(new Uint8Array([80, 75]), "Idea");
    expect(write).toHaveBeenCalledWith(
      "Presentations/Idea.pptx",
      expect.any(Blob),
      { overwrite: false, dedupeName: true, createMissingParents: true },
    );
    await saveFile(new Uint8Array([80, 75]), "Idea", "/u/Idea.pptx");
    expect(write.mock.calls[1][2].overwrite).toBe(true);
  });
  it("does not hide permission errors as an empty file list", async () => {
    vi.stubGlobal("puter", {
      fs: { readdir: vi.fn().mockRejectedValue({ code: "permission_denied" }) },
    });
    await expect(listFiles()).rejects.toEqual({ code: "permission_denied" });
  });
  it("treats a missing app folder as a new library", async () => {
    vi.stubGlobal("puter", {
      fs: {
        readdir: vi.fn().mockRejectedValue({ code: "subject_does_not_exist" }),
      },
    });
    expect(await listFiles()).toEqual([]);
  });
  it("never offers or performs logout inside Puter app environment", async () => {
    const logout = vi.fn();
    vi.stubGlobal("puter", { env: "app", auth: { signOut: logout } });
    expect(canSignOut()).toBe(false);
    await signOut();
    expect(logout).not.toHaveBeenCalled();
  });
  it("turns the SDK's sign-in rejections into actionable errors", async () => {
    const getUser = vi.fn().mockResolvedValue({ username: "nj" });
    const attempt = (rejection) => {
      vi.stubGlobal("puter", {
        auth: { signIn: vi.fn().mockRejectedValue(rejection), getUser },
      });
      return signIn();
    };
    // The SDK rejects with plain objects whose text lives in `msg`.
    await expect(
      attempt({
        error: "auth_window_closed",
        msg: "Authentication window was closed by the user without completing the process.",
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    await expect(attempt({ error: "popup_blocked" })).rejects.toThrow(
      "Allow pop-ups for this site",
    );
    await expect(
      attempt({ error: "unknown", msg: "Service unavailable" }),
    ).rejects.toThrow("Service unavailable");
    await expect(attempt(new Error("Offline"))).rejects.toThrow("Offline");
    expect(getUser).not.toHaveBeenCalled();
    vi.stubGlobal("puter", {
      auth: { signIn: vi.fn().mockResolvedValue(undefined), getUser },
    });
    expect(await signIn()).toEqual({ username: "nj" });
  });
  it("serializes writes and recovers after a rejected write", async () => {
    const q = new SaveQueue(),
      order = [];
    let release;
    const first = q.run(async () => {
      order.push(1);
      await new Promise((r) => (release = r));
      throw Error("Offline");
    });
    const rejected = expect(first).rejects.toThrow("Offline");
    const second = q.run(async () => order.push(2));
    await Promise.resolve();
    expect(order).toEqual([1]);
    release();
    await rejected;
    await second;
    expect(order).toEqual([1, 2]);
  });
  it("tells a missing file from other failures, however the SDK words it", () => {
    expect(isNotFound({ code: "subject_does_not_exist" })).toBe(true);
    expect(isNotFound({ error: { code: "subject_does_not_exist" } })).toBe(
      true,
    );
    expect(isNotFound(new Error("No such file or directory"))).toBe(true);
    expect(isNotFound({ code: "permission_denied" })).toBe(false);
    expect(isNotFound(new Error("Network error"))).toBe(false);
  });
  it("reads the drive's times in seconds or milliseconds, and knows its folders", () => {
    expect(modifiedMs({ modified: 1_700_000_000 })).toBe(1_700_000_000_000);
    expect(modifiedMs({ modified: "1700000000" })).toBe(1_700_000_000_000);
    expect(modifiedMs({ modified: 1_700_000_000_000 })).toBe(1_700_000_000_000);
    expect(modifiedMs({})).toBeNull();
    expect(inTrash("/nj/Trash/abc")).toBe(true);
    expect(inTrash("~/Trash")).toBe(true);
    expect(inTrash("/nj/Desktop/Trash talk.pptx")).toBe(false);
    expect(inAppFolder("/nj/AppData/app/Presentations/Deck.pptx")).toBe(true);
    expect(inAppFolder("Presentations/Deck.pptx")).toBe(true);
    expect(inAppFolder("/nj/Desktop/Deck.pptx")).toBe(false);
    expect(folderName("/nj/Desktop/Deck.pptx")).toBe("Desktop");
  });
  it("answers a missing file with null and lets other failures through", async () => {
    const fail = vi.fn().mockRejectedValue({ code: "subject_does_not_exist" });
    vi.stubGlobal("puter", { fs: { stat: fail } });
    expect(await stat("/nj/Deck.pptx")).toBeNull();
    expect(await statByUid("uid-1")).toBeNull();
    expect(fail).toHaveBeenLastCalledWith({ uid: "uid-1" });
    vi.stubGlobal("puter", {
      fs: { stat: vi.fn().mockRejectedValue({ code: "forbidden" }) },
    });
    await expect(stat("/nj/Deck.pptx")).rejects.toEqual({ code: "forbidden" });
  });
  it("never renames over another file", async () => {
    const rename = vi.fn().mockResolvedValue({ path: "/u/P/New.pptx" });
    vi.stubGlobal("puter", {
      fs: {
        rename,
        stat: vi.fn().mockResolvedValue({ path: "/u/P/New.pptx" }),
      },
    });
    await expect(renameFile("/u/P/Old.pptx", "New")).rejects.toMatchObject({
      code: "exists",
    });
    expect(rename).not.toHaveBeenCalled();
    // A change of case alone names the same file.
    await renameFile("/u/P/new.pptx", "New");
    expect(rename).toHaveBeenCalledWith("/u/P/new.pptx", "New.pptx");
  });
  it("settles Puter's pickers when they are cancelled", async () => {
    const never = () => {
      const pending = new Promise(() => {});
      pending.undefinedOnCancel = Promise.resolve(undefined);
      return pending;
    };
    vi.stubGlobal("puter", {
      env: "app",
      ui: { showOpenFilePicker: never, showSaveFilePicker: never },
    });
    expect(await pickFile()).toBeNull();
    expect(await saveFileAs(new Blob(["x"]), "Deck.pptx")).toBeNull();
    expect(await downloadBlob(new Blob(["x"]), "Deck.pptx")).toEqual({
      cancelled: true,
    });
    const saved = { path: "/u/Documents/Deck.pptx", name: "Deck.pptx" };
    const chosen = () => {
      const pending = Promise.resolve(saved);
      pending.undefinedOnCancel = Promise.resolve(saved);
      return pending;
    };
    vi.stubGlobal("puter", {
      env: "app",
      ui: { showOpenFilePicker: () => chosen(), showSaveFilePicker: chosen },
    });
    expect(await pickFile()).toEqual(saved);
    expect(await downloadBlob(new Blob(["x"]), "Deck.pptx")).toEqual({
      saved,
    });
  });
  it("takes over the window's close button only where the window can still close", () => {
    const handler = () => {};
    const onClose = vi.fn();
    vi.stubGlobal("puter", { env: "web", ui: { onWindowClose: onClose } });
    expect(onWindowClose(handler)).toBe(false);
    vi.stubGlobal("puter", { env: "app", ui: { onWindowClose: onClose } });
    expect(onWindowClose(handler)).toBe(false);
    vi.stubGlobal("puter", {
      env: "app",
      exit: () => {},
      ui: { onWindowClose: onClose },
    });
    expect(onWindowClose(handler)).toBe(true);
    expect(onClose).toHaveBeenCalledWith(handler);
  });
  it("hands on every launch item, folders included", () => {
    const handler = vi.fn();
    vi.stubGlobal("puter", {
      ui: {
        onLaunchedWithItems: (callback) =>
          callback([{ path: "/u/Photos", is_dir: true }, null]),
      },
    });
    onLaunch(handler);
    expect(handler).toHaveBeenCalledWith([{ path: "/u/Photos", is_dir: true }]);
  });
});
