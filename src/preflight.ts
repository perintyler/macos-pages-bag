/**
 * Checking paths here, in Node, before Pages ever sees them.
 *
 * Handed a path that does not exist, Pages does not return an error — it opens
 * a modal dialog and holds the AppleEvent until it times out roughly two
 * minutes later, leaving a window nothing in this bag can dismiss. Every
 * failure these functions catch is one that would otherwise cost that.
 *
 * The checks are ordinary filesystem calls with no Pages involvement, which is
 * what lets them be tested against a temp directory.
 */

import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

/**
 * A file Pages will open.
 *
 * Returns the realpath so callers compare resolved paths — `/tmp/x` and
 * `/private/tmp/x` are the same file on macOS, and a guard that misses that is
 * a guard that passes when it should refuse.
 */
export async function requireExistingFile(path: string, label: string): Promise<string> {
  requireAbsolute(path, label);

  let info;
  try {
    info = await stat(path);
  } catch {
    throw new PreflightError(`${label} does not exist: ${path}`);
  }

  if (info.isDirectory()) {
    // A .pages file is itself a bundle (a directory) in some versions, so this
    // rejects only what has no extension to justify it.
    if (!path.endsWith(".pages")) {
      throw new PreflightError(`${label} is a directory, not a document: ${path}`);
    }
  } else if (!info.isFile()) {
    throw new PreflightError(`${label} is not a regular file: ${path}`);
  }

  return realpath(path);
}

/**
 * A path Pages will write to. The file need not exist; its parent directory
 * must, and must be writable, or Pages fails the same slow way.
 */
export async function requireWritableTarget(path: string, label: string): Promise<void> {
  requireAbsolute(path, label);

  const parent = dirname(path);
  let parentInfo;
  try {
    parentInfo = await stat(parent);
  } catch {
    throw new PreflightError(`${label} is in a directory that does not exist: ${parent}`);
  }

  if (!parentInfo.isDirectory()) {
    throw new PreflightError(`${label} is in something that is not a directory: ${parent}`);
  }

  try {
    await access(parent, constants.W_OK);
  } catch {
    throw new PreflightError(`${label} is in a directory that is not writable: ${parent}`);
  }
}

/**
 * Refuse to overwrite unless the caller said so. Separate from
 * `requireWritableTarget` because "may I write here" and "may I destroy what is
 * already here" are different questions.
 */
export async function requireOverwriteAllowed(
  path: string,
  overwrite: boolean,
  label: string,
): Promise<void> {
  if (overwrite) return;

  try {
    await stat(path);
  } catch {
    return; // Nothing there — nothing to protect.
  }

  throw new PreflightError(
    `${label} already exists: ${path}. Pass overwrite: true to replace it.`,
  );
}

/**
 * Relative paths are rejected rather than resolved: this bag's cwd is the MCP
 * server's, which is not anywhere the caller was thinking of.
 */
function requireAbsolute(path: string, label: string): void {
  if (!path.trim()) {
    throw new PreflightError(`${label} is empty.`);
  }
  if (!isAbsolute(path)) {
    throw new PreflightError(`${label} must be an absolute path, got: ${path}`);
  }
}

/**
 * Compare two paths for "same file". Used to spot a document the user already
 * has open, where writing underneath them would lose their unsaved edits.
 *
 * Case-insensitive because that is the default for macOS volumes; a
 * case-sensitive compare would miss the collision and let the write through.
 */
export function isSamePath(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}
