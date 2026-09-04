/**
 * Turning an osascript failure into something a caller can branch on.
 *
 * osascript reports AppleScript failures on stderr with a numeric code in
 * parentheses, e.g. `Pages got an error: Can't get template "Nope". (-1728)`.
 * The number is stable across macOS releases and locales; the message text is
 * localized, so it is only ever a fallback.
 */

export type PagesErrorKind =
  | "permission-denied"
  | "timeout"
  | "not-found"
  | "cancelled"
  | "pages-error";

export class PagesScriptError extends Error {
  readonly kind: PagesErrorKind;
  readonly code: number | null;
  readonly stderr: string;

  constructor(kind: PagesErrorKind, message: string, code: number | null, stderr: string) {
    super(message);
    this.name = "PagesScriptError";
    this.kind = kind;
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * AppleScript error numbers we act on. Anything else falls through to
 * `pages-error` with the stderr passed through verbatim — guessing at an
 * unknown code would hide it.
 */
const ERROR_CODES: Record<number, PagesErrorKind> = {
  [-1743]: "permission-denied", // not authorized to send Apple events
  1743: "permission-denied", //    the same refusal, reported unsigned
  [-1712]: "timeout", //           AppleEvent timed out
  [-1728]: "not-found", //         can't get <object>
  [-128]: "cancelled", //          user canceled
};

/** The TCC refusal wording, for the case where no number was printed. */
const DENIED_TEXT = /not allowed|not permitted|not authoriz/i;

/**
 * The trailing `(-1728)` osascript appends to an AppleScript error. Anchored to
 * the end so a code appearing inside a user's document text cannot be read as
 * the error code.
 */
const TRAILING_CODE = /\((-?\d+)\)\s*$/;

export function extractErrorCode(stderr: string): number | null {
  const match = TRAILING_CODE.exec(stderr.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Classify a finished osascript run. Pure in `(code, signal, stderr)` so it can
 * be tested exhaustively without Pages, or macOS, being involved at all.
 *
 * `signal` is the killSignal delivered when the outer execFile timeout fires —
 * that is a wedged Pages, which is a timeout even though no AppleScript error
 * was ever printed.
 */
export function classifyError(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): PagesScriptError {
  const trimmed = stderr.trim();

  if (signal) {
    return new PagesScriptError(
      "timeout",
      "Pages stopped responding and the script was killed. It may have left a " +
        "dialog open — check the Pages window before retrying.",
      null,
      trimmed,
    );
  }

  const code = extractErrorCode(trimmed);
  const kind = (code !== null ? ERROR_CODES[code] : undefined)
    ?? (DENIED_TEXT.test(trimmed) ? "permission-denied" : "pages-error");

  return new PagesScriptError(kind, describe(kind, trimmed), code, trimmed);
}

function describe(kind: PagesErrorKind, stderr: string): string {
  switch (kind) {
    case "permission-denied":
      // Worth spelling out: the grant is per-binary, so a working `osascript`
      // in the user's own terminal proves nothing about the node running this.
      return (
        "Not allowed to control Pages. macOS grants automation per binary, so " +
        "this node must be allowed in System Settings → Privacy & Security → " +
        `Automation. (${stderr})`
      );
    case "timeout":
      // Verified against Pages 14.1: a file it will not open puts up an alert
      // ("... can't be opened right now") that blocks the Apple event and
      // outlives the script. Nothing here can dismiss it, so the only honest
      // advice is to go and look.
      return (
        "Pages did not respond in time. It is usually showing an alert that " +
        "blocks automation until someone dismisses it — check the Pages " +
        `window, or quit Pages, before retrying. (${stderr})`
      );
    case "not-found":
      return `Pages could not find what the script referred to. (${stderr})`;
    case "cancelled":
      return `Pages reported the action was cancelled. (${stderr})`;
    case "pages-error":
      return stderr || "Pages failed without reporting a reason.";
  }
}
