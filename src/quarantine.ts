/**
 * The download flag that stops Pages opening a file.
 *
 * A `.pages` file fetched through a browser carries `com.apple.quarantine`, and
 * Pages will not open it under automation: the Apple event blocks on a modal
 * alert reading "can't be opened right now — Operation not permitted", then
 * times out. Nothing in the message says "quarantine", so this looks identical
 * to a permissions problem or a corrupt file, and it cost a long detour to
 * identify.
 *
 * Removing the attribute is a one-line fix that needs no privileges. It is
 * exposed as its own narrow operation rather than folded into the read path,
 * because clearing a security flag is a decision the caller should make
 * deliberately — the flag is macOS saying "a person has not vouched for this
 * file yet", and that is sometimes worth respecting.
 *
 * Only `com.apple.quarantine` is touched. A blanket `xattr -c` would also strip
 * `com.apple.provenance` and any per-file access grants recorded alongside it.
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";

const XATTR = "/usr/bin/xattr";
const QUARANTINE = "com.apple.quarantine";
const XATTR_TIMEOUT_MS = 10_000;

function runXattr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(XATTR, args, { timeout: XATTR_TIMEOUT_MS, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * Whether the file carries the quarantine flag.
 *
 * A file that cannot be examined is reported as not quarantined rather than
 * raising: this is called from `status`, where an unreadable attribute should
 * not turn a health check into an error.
 */
export async function isQuarantined(path: string): Promise<boolean> {
  try {
    const attributes = await runXattr([path]);
    return attributes.split("\n").some((line) => line.trim() === QUARANTINE);
  } catch {
    return false;
  }
}

export class QuarantineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuarantineError";
  }
}

export interface UnblockResult {
  path: string;
  /** False when the file was not quarantined to begin with. */
  removed: boolean;
}

/**
 * Clear the quarantine flag from a Pages document.
 *
 * Refuses anything that is not a `.pages` file. This tool exists to unblock one
 * specific application's documents, and a general "strip security attributes
 * from any path" tool is a much larger thing to hand an agent.
 *
 * Removing a flag that is not there is reported as `removed: false` rather than
 * treated as an error — the caller's goal (the file is not quarantined) is
 * already true.
 */
export async function unblock(path: string): Promise<UnblockResult> {
  if (!path.endsWith(".pages")) {
    throw new QuarantineError(
      `Refusing to change extended attributes on ${path}: this only operates on .pages documents.`,
    );
  }

  const info = await stat(path).catch(() => null);
  if (!info) throw new QuarantineError(`No such file: ${path}`);

  if (!(await isQuarantined(path))) {
    return { path, removed: false };
  }

  await runXattr(["-d", QUARANTINE, path]);

  // Verify rather than assume: `xattr -d` exits 0 in cases where the attribute
  // survives, and reporting success on a file Pages will still refuse would
  // send the caller back down the same dead end this tool exists to end.
  if (await isQuarantined(path)) {
    throw new QuarantineError(
      `The quarantine flag on ${path} could not be removed. Open the file once in Finder to clear it.`,
    );
  }

  return { path, removed: true };
}
