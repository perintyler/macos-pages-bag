import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderDocument } from "./render.js";

/**
 * These run against the real `qlmanage` and `unzip` rather than mocks. Mocking
 * them would only prove the code calls what it says it calls; the question that
 * matters — does an image actually come out, and is a failure reported as one —
 * can only be answered by running them.
 */
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "render-test-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("renderDocument", () => {
  /**
   * QuickLook exits 0 and prints a success line even when it generates nothing,
   * so a wrapper that trusts the exit code reports success and leaves no file.
   * Rendering something QuickLook cannot handle must raise.
   */
  // Budget covers the QuickLook ceiling plus the unzip fallback: this path is
  // slow by design, because the hang is what the ceiling exists to stop.
  it("fails loudly when nothing can be rendered", { timeout: 45_000 }, async () => {
    const junk = join(dir, "not-a-document.pages");
    await writeFile(junk, "this is not a pages bundle");
    const out = join(dir, "out.png");

    await expect(renderDocument(junk, out, 800)).rejects.toThrow(/render/i);
    // The error must not have left a partial file behind that a caller would
    // then treat as a valid image.
    await expect(stat(out)).rejects.toThrow();
  });

  it("reports a failure rather than silently producing nothing", { timeout: 45_000 }, async () => {
    const junk = join(dir, "another.pages");
    await writeFile(junk, "still not a bundle");
    // The render fails, but the failure path is what is under test here: the
    // caller learns nothing was produced rather than getting a silent no-op.
    await expect(renderDocument(junk, join(dir, "x.png"), 800)).rejects.toThrow();
  });
});
