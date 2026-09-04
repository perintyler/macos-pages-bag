/**
 * Seeing a document, without asking Pages to open it.
 *
 * Every other read in this bag goes through AppleScript, which means Pages must
 * agree to open the file. It often won't: macOS grants an app access to a
 * specific file when a person opens it, and that grant does not survive a copy.
 * A copy of a document that opens perfectly is refused with "Operation not
 * permitted", so anything working on a duplicate — a preview before an edit, a
 * backup, a file just fetched — cannot be rendered through Pages at all.
 *
 * Two routes avoid Pages entirely:
 *
 * - `qlmanage`, the QuickLook CLI, renders a thumbnail through the system's own
 *   generator. It runs as the caller, not as Pages, so the per-file grant never
 *   applies.
 * - Every `.pages` bundle carries `preview.jpg` — a full-page image Pages wrote
 *   at save time for Finder and Mail. Reading it is just unzipping, and it costs
 *   nothing to produce.
 *
 * The tradeoff is that neither shows unsaved work, and the embedded preview is
 * only as fresh as the last save. `render_document` reports which route it used
 * and how old the file is, because a stale image that looks current is worse
 * than no image.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * Handed something that is not a real bundle, `qlmanage` does not fail — it
 * hangs until killed (measured: still running at 60s on a junk file). The
 * ceiling is therefore the only thing that ends a bad render, and it is set to
 * cover a genuine one with room to spare rather than to be generous.
 */
const QUICKLOOK_TIMEOUT_MS = 20_000;

/** Unzipping a preview is a local read; it either works at once or not at all. */
const UNZIP_TIMEOUT_MS = 10_000;

export type RenderRoute = "quicklook" | "embedded-preview";

export interface RenderResult {
  route: RenderRoute;
  path: string;
  /** When the source document was last written — the render can be no newer. */
  documentModified: Date;
}

function run(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, killSignal: "SIGKILL" }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Render the first page via QuickLook.
 *
 * `qlmanage -t` names its output after the input file rather than taking a
 * destination, so it renders into a scratch directory and the result is moved
 * to where the caller asked.
 */
async function renderWithQuickLook(source: string, destination: string, width: number): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "macos-pages-render-"));
  try {
    await run("/usr/bin/qlmanage", ["-t", "-s", String(width), "-o", scratch, source], QUICKLOOK_TIMEOUT_MS);

    // QuickLook reports success on stdout even when it produced nothing, so the
    // directory listing is the only trustworthy evidence that it worked.
    const produced = (await readdir(scratch)).filter((name) => name.endsWith(".png"));
    if (produced.length === 0) {
      throw new Error("QuickLook produced no image for this document.");
    }

    await rename(join(scratch, produced[0]), destination);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Pull `preview.jpg` out of the bundle.
 *
 * Only bundles saved by a recent Pages carry one, so a missing entry is an
 * ordinary outcome rather than a failure — the caller falls back.
 */
async function extractEmbeddedPreview(source: string, destination: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "macos-pages-preview-"));
  try {
    await run("/usr/bin/unzip", ["-o", "-q", source, "preview.jpg", "-d", scratch], UNZIP_TIMEOUT_MS);
    await rename(join(scratch, "preview.jpg"), destination);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Produce an image of a document's first page.
 *
 * QuickLook first because it re-renders from the current file; the embedded
 * preview is the fallback, and is only as current as the last save. The route
 * used is reported rather than hidden, since the two differ in freshness.
 */
export async function renderDocument(
  source: string,
  destination: string,
  width: number,
): Promise<RenderResult> {
  const info = await stat(source);

  try {
    await renderWithQuickLook(source, destination, width);
    return { route: "quicklook", path: destination, documentModified: info.mtime };
  } catch (quickLookError) {
    try {
      await extractEmbeddedPreview(source, destination);
      return { route: "embedded-preview", path: destination, documentModified: info.mtime };
    } catch {
      // Report the QuickLook failure, not the fallback's: the fallback is
      // absent for ordinary reasons and its error explains nothing.
      throw new Error(
        `Could not render ${basename(source)}. QuickLook failed ` +
          `(${(quickLookError as Error).message}) and the document has no embedded preview.`,
      );
    }
  }
}
