import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isQuarantined, QuarantineError, unblock } from "./quarantine.js";

/**
 * Run against real extended attributes rather than a mocked `xattr`. The thing
 * worth verifying is that the right attribute goes and the others stay, and a
 * mock would only confirm which arguments were passed.
 */
let dir: string;
let document: string;

const setQuarantine = (path: string) =>
  execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;00000000;Test;", path]);

const attributesOf = (path: string) =>
  execFileSync("/usr/bin/xattr", [path], { encoding: "utf8" }).split("\n").filter(Boolean);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "quarantine-test-"));
  document = join(dir, "doc.pages");
  await writeFile(document, "stand-in for a bundle");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isQuarantined", () => {
  it("sees the flag when it is set", async () => {
    setQuarantine(document);
    expect(await isQuarantined(document)).toBe(true);
  });

  it("reports a missing file as not quarantined rather than raising", async () => {
    // Called from `status`, where an unreadable path must not turn a health
    // check into a crash.
    expect(await isQuarantined(join(dir, "absent.pages"))).toBe(false);
  });
});

describe("unblock", () => {
  it("removes the flag", async () => {
    setQuarantine(document);
    const result = await unblock(document);
    expect(result.removed).toBe(true);
    expect(await isQuarantined(document)).toBe(false);
  });

  /**
   * A blanket `xattr -c` would also strip provenance and the per-file access
   * grants recorded beside it — the very grants that let Pages open a document.
   */
  it("leaves other extended attributes alone", async () => {
    setQuarantine(document);
    execFileSync("/usr/bin/xattr", ["-w", "com.apple.metadata:custom", "keep-me", document]);

    await unblock(document);

    expect(attributesOf(document)).toContain("com.apple.metadata:custom");
  });

  it("reports an unquarantined file as unchanged rather than failing", async () => {
    const clean = join(dir, "clean.pages");
    await writeFile(clean, "no flag here");
    expect((await unblock(clean)).removed).toBe(false);
  });

  /**
   * This tool exists to unblock Pages documents. A general "strip security
   * attributes from any path" tool is a much broader thing to hand an agent.
   */
  it("refuses anything that is not a .pages file", async () => {
    const other = join(dir, "notes.txt");
    await writeFile(other, "text");
    await expect(unblock(other)).rejects.toThrow(QuarantineError);
  });

  it("refuses a path that does not exist", async () => {
    await expect(unblock(join(dir, "missing.pages"))).rejects.toThrow(/No such file/);
  });
});
