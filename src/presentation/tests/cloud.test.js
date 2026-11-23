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
  asksWhereToSave,
  oneDialog,
  onWindowClose,
  onLaunch,
  sdkReady,
  onLateSdk,
  errorMessage,
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
    expect(await saveFileAs(new Blob(["x"]), "Deck.pptx")).toEqual(saved);
  });
  it("downloads exports to this device, inside the Puter desktop too", async () => {
    vi.useFakeTimers();
    try {
      const picker = vi.fn();
      const clicked = [];
      const link = {
        click() {
          clicked.push({ href: this.href, download: this.download });
        },
        remove: vi.fn(),
      };
      vi.stubGlobal("document", {
        createElement: vi.fn(() => link),
        body: { append: vi.fn() },
      });
      const revoke = vi
        .spyOn(URL, "revokeObjectURL")
        .mockImplementation(() => {});
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:deck");
      for (const env of ["app", "web"]) {
        vi.stubGlobal("puter", { env, ui: { showSaveFilePicker: picker } });
        await downloadBlob(new Blob(["x"]), "Deck.pdf");
      }
      expect(picker).not.toHaveBeenCalled();
      expect(clicked).toEqual([
        { href: "blob:deck", download: "Deck.pdf" },
        { href: "blob:deck", download: "Deck.pdf" },
      ]);
      expect(link.remove).toHaveBeenCalledTimes(2);
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledWith("blob:deck");
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
  it("asks where a new file goes only inside the Puter desktop, with its Save dialog", () => {
    const ui = { showSaveFilePicker: () => {} };
    vi.stubGlobal("puter", { env: "app", ui });
    expect(asksWhereToSave()).toBe(true);
    // An SDK without the dialog keeps the Presentations folder.
    vi.stubGlobal("puter", { env: "app", ui: {} });
    expect(asksWhereToSave()).toBe(false);
    // On the open web a new file goes to the Presentations folder.
    vi.stubGlobal("puter", { env: "web", ui });
    expect(asksWhereToSave()).toBe(false);
  });
  it("keeps one Save dialog open per save, until it answers or the app has the focus back", async () => {
    const app = new EventTarget();
    vi.stubGlobal("addEventListener", app.addEventListener.bind(app));
    vi.stubGlobal("removeEventListener", app.removeEventListener.bind(app));
    let answer;
    const open = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const first = oneDialog("first:a", open);
    // A second save while the dialog is open waits for it.
    const second = oneDialog("first:a", open);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(open).toHaveBeenCalledOnce();
    // Another presentation's save is its own.
    const other = oneDialog("first:b", () => "other");
    expect(other).not.toBe(first);
    expect(await other).toBe("other");
    answer(true);
    expect(await second).toBe(true);
    // Answered, the next save opens a new dialog.
    const next = oneDialog("first:a", open);
    expect(next).not.toBe(first);
    await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(2);
    // A dialog that never answers holds the saves only until the desktop
    // hands the focus back.
    app.dispatchEvent(new Event("focus"));
    const after = oneDialog("first:a", open);
    expect(after).not.toBe(next);
    await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(3);
    answer(false);
    expect(await after).toBe(false);
    // A failed dialog lets the next save try again.
    const failing = oneDialog("copy:a", async () => {
      throw new Error("Read-only folder");
    });
    await expect(failing).rejects.toThrow("Read-only folder");
    expect(await oneDialog("copy:a", () => "again")).toBe("again");
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
  it("starts without the SDK when its script never answers, and takes it up when it arrives", async () => {
    vi.useFakeTimers();
    try {
      let settle;
      vi.stubGlobal(
        "__puterSettled",
        new Promise((resolve) => (settle = resolve)),
      );
      let ready = null;
      sdkReady(8000).then((value) => (ready = value));
      await vi.advanceTimersByTimeAsync(7999);
      expect(ready).toBe(null);
      await vi.advanceTimersByTimeAsync(1);
      expect(ready).toBe(false);
      const late = vi.fn();
      onLateSdk(late);
      vi.stubGlobal("puter", { env: "web" });
      settle(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(late).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("waits for an SDK that answers in time, and not for one that failed", async () => {
    let settle;
    vi.stubGlobal(
      "__puterSettled",
      new Promise((resolve) => (settle = resolve)),
    );
    const ready = sdkReady(60000);
    vi.stubGlobal("puter", { env: "web" });
    settle(true);
    await expect(ready).resolves.toBe(true);
    vi.unstubAllGlobals();
    vi.stubGlobal("__puterSettled", Promise.resolve(false));
    await expect(sdkReady(60000)).resolves.toBe(false);
    const late = vi.fn();
    onLateSdk(late);
    await Promise.resolve();
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
  });
  it("says what a failed request means, whatever shape the failure takes", () => {
    expect(errorMessage(new TypeError("Failed to fetch"))).toBe(
      "The connection to Puter was lost.",
    );
    expect(
      errorMessage(
        new TypeError("NetworkError when attempting to fetch resource."),
      ),
    ).toBe("The connection to Puter was lost.");
    expect(errorMessage(new TypeError("Load failed"))).toBe(
      "The connection to Puter was lost.",
    );
    const full =
      "Your Puter storage is full. Free up some space, or download a copy to keep your work.";
    expect(
      errorMessage({
        code: "storage_limit_reached",
        message: "Storage capacity limit reached.",
      }),
    ).toBe(full);
    expect(
      errorMessage({
        success: false,
        error: { code: "storage_limit_reached" },
      }),
    ).toBe(full);
    expect(errorMessage({ error: { message: "Permission denied" } })).toBe(
      "Permission denied",
    );
    expect(errorMessage({ msg: "Try later" })).toBe("Try later");
    expect(errorMessage(new Error("Cloud save failed."))).toBe(
      "Cloud save failed.",
    );
    // A TypeError from the app's own code keeps its words.
    expect(errorMessage(new TypeError("x is not a function"))).toBe(
      "x is not a function",
    );
    expect(errorMessage(null)).toBe("");
  });
});
