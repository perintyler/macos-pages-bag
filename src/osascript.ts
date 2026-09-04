/**
 * The one place this bag talks to osascript.
 *
 * Two rules hold everywhere below, and both exist because of a specific hazard:
 *
 * 1. User data travels as argv, never as script text. Scripts are constants
 *    with `on run argv`, so a document title containing a quote, a backslash or
 *    a newline is data Pages reads — not script it runs.
 *
 * 2. Every run is bounded. Pages answers a bad request by opening a modal
 *    dialog and blocking the AppleEvent until it expires ~2 minutes later, so a
 *    run with no ceiling is a hung session.
 */

import { execFile } from "node:child_process";
import { classifyError, PagesScriptError } from "./classify-error.js";

/**
 * Absolute, not a PATH lookup: automation grants are recorded against the
 * binary that asks, so resolving to some other osascript earlier on PATH would
 * fail in a way that reads like a permissions bug.
 */
const OSASCRIPT = "/usr/bin/osascript";

/** Ceiling on a whole run, including Pages launching from cold. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Exports re-encode the document, which is legitimately slow for a long one —
 * the point of the ceiling is to catch a wedge, not to cut off real work.
 */
export const EXPORT_TIMEOUT_MS = 120_000;

export interface RunOptions {
  timeoutMs?: number;
}

/**
 * Run an AppleScript and return its stdout, trimmed.
 *
 * Failures arrive as `PagesScriptError`, so callers branch on `.kind` rather
 * than matching strings that change with the user's language.
 */
export function runScript(script: string, args: string[] = [], options: RunOptions = {}): Promise<string> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    // "-" reads the script from stdin. That keeps the script body out of argv
    // (where it would collide with `on run argv`), out of `ps`, and clear of
    // any length ceiling on a command line.
    const child = execFile(
      OSASCRIPT,
      ["-", ...args],
      {
        timeout,
        // A process blocked on an AppleEvent does not reliably die on SIGTERM,
        // and a timeout that leaves the process alive is not a timeout.
        killSignal: "SIGKILL",
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout.trim());
          return;
        }

        const withCode = error as NodeJS.ErrnoException & {
          code?: number | string;
          signal?: NodeJS.Signals | null;
        };

        // ENOENT here means osascript itself is missing, which is not a Pages
        // problem and must not be dressed up as one.
        if (withCode.code === "ENOENT") {
          reject(new PagesScriptError(
            "pages-error",
            `${OSASCRIPT} not found — this bag only runs on macOS.`,
            null,
            String(stderr ?? ""),
          ));
          return;
        }

        const exitCode = typeof withCode.code === "number" ? withCode.code : null;
        reject(classifyError(exitCode, withCode.signal ?? null, String(stderr ?? "")));
      },
    );

    child.stdin?.end(script);
  });
}

/**
 * Split a script's tab-delimited reply into fields.
 *
 * AppleScript has no JSON writer, and building JSON by hand inside it would
 * reintroduce the quoting problem that argv exists to avoid. Tabs are safe here
 * because every field joined this way is a number, a boolean or a filename —
 * anything free-form (a document's body) is returned on its own instead.
 */
export function splitFields(output: string): string[] {
  return output.split("\t");
}

export { PagesScriptError } from "./classify-error.js";
export type { PagesErrorKind } from "./classify-error.js";
