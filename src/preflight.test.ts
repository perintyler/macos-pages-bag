import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isSamePath,
  PreflightError,
  requireExistingFile,
  requireOverwriteAllowed,
  requireWritableTarget,
} from "./preflight.js";

/**
 * These are the guards that keep a bad path away from Pages. Pages answers one
 * by opening a dialog and holding the AppleEvent for ~2 minutes, so each case
 * below is a hang that does not happen.
 */
let dir: string;
let existingFile: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "macos-pages-test-"));
  existingFile = join(dir, "doc.pages");
  await writeFile(existingFile, "not really a pages file");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("requireExistingFile", () => {
  it("accepts a file that exists and returns its realpath", async () => {
    // The realpath matters: macOS reports /tmp as /private/tmp, and the
    // open-document guard compares these strings.
    const resolved = await requireExistingFile(existingFile, "path");
    expect(resolved).toMatch(/doc\.pages$/);
  });

  it("rejects a missing file", async () => {
    await expect(requireExistingFile(join(dir, "nope.pages"), "path")).rejects.toThrow(
      PreflightError,
    );
  });

  it("rejects a relative path", async () => {
    // Resolving one would resolve it against the MCP server's directory, which
    // is nowhere the caller meant.
    await expect(requireExistingFile("doc.pages", "path")).rejects.toThrow(/absolute/);
  });

  it("rejects an empty path", async () => {
    await expect(requireExistingFile("", "path")).rejects.toThrow(PreflightError);
  });

  it("rejects a directory that is not a .pages bundle", async () => {
    const plain = join(dir, "plain-dir");
    await mkdir(plain, { recursive: true });
    await expect(requireExistingFile(plain, "path")).rejects.toThrow(/directory/);
  });

  it("accepts a .pages bundle directory", async () => {
    // Pages saves some documents as bundles, so a directory ending in .pages is
    // a real document rather than a mistake.
    const bundle = join(dir, "bundle.pages");
    await mkdir(bundle, { recursive: true });
    await expect(requireExistingFile(bundle, "path")).resolves.toMatch(/bundle\.pages$/);
  });
});

describe("requireWritableTarget", () => {
  it("accepts a new file in an existing directory", async () => {
    await expect(requireWritableTarget(join(dir, "new.pages"), "path")).resolves.toBeUndefined();
  });

  it("rejects a path whose parent does not exist", async () => {
    await expect(
      requireWritableTarget(join(dir, "missing", "new.pages"), "path"),
    ).rejects.toThrow(/does not exist/);
  });

  it("rejects a relative path", async () => {
    await expect(requireWritableTarget("new.pages", "path")).rejects.toThrow(/absolute/);
  });

  it("rejects a directory it cannot write to", async () => {
    const locked = join(dir, "locked");
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o500);
    try {
      await expect(requireWritableTarget(join(locked, "new.pages"), "path")).rejects.toThrow(
        /not writable/,
      );
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

describe("requireOverwriteAllowed", () => {
  it("allows writing where nothing exists", async () => {
    await expect(
      requireOverwriteAllowed(join(dir, "absent.pages"), false, "path"),
    ).resolves.toBeUndefined();
  });

  it("refuses to replace an existing file by default", async () => {
    await expect(requireOverwriteAllowed(existingFile, false, "path")).rejects.toThrow(
      /already exists/,
    );
  });

  it("replaces an existing file when asked to", async () => {
    await expect(requireOverwriteAllowed(existingFile, true, "path")).resolves.toBeUndefined();
  });
});

describe("isSamePath", () => {
  it("matches identical paths", () => {
    expect(isSamePath("/private/tmp/a.pages", "/private/tmp/a.pages")).toBe(true);
  });

  it("matches paths differing only in case", () => {
    // macOS volumes are case-insensitive by default, so a case-sensitive
    // comparison would miss the collision and allow the overwrite through.
    expect(isSamePath("/private/tmp/A.pages", "/private/tmp/a.pages")).toBe(true);
  });

  it("does not match different files", () => {
    expect(isSamePath("/private/tmp/a.pages", "/private/tmp/b.pages")).toBe(false);
  });
});
