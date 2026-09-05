import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as scripts from "./scripts.js";

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "scripts.ts"), "utf8");

const ALL = Object.entries(scripts).filter(([, value]) => typeof value === "string") as Array<
  [string, string]
>;

describe("script constants", () => {
  it("exports every script the tools use", () => {
    expect(ALL.length).toBeGreaterThanOrEqual(9);
  });

  /**
   * The whole safety argument for passing user data through argv collapses the
   * moment a script is assembled by interpolation, and that is an easy change
   * to make without noticing. Checking the source text rather than the values
   * catches it even when the interpolated value looks harmless.
   */
  it("contains no interpolation anywhere in the file", () => {
    expect(SOURCE).not.toContain("${");
  });

  it("declares an argv entry point", () => {
    for (const [name, script] of ALL) {
      expect(script, `${name} must accept argv`).toContain("on run argv");
    }
  });

  it("reads user data through argv rather than building it in", () => {
    // Every script that takes input reads it positionally; the ones that take
    // none are the whole-application queries.
    const takesNoInput = ["STATUS_SCRIPT", "LIST_DOCUMENTS_SCRIPT", "LIST_TEMPLATES_SCRIPT"];
    for (const [name, script] of ALL) {
      if (takesNoInput.includes(name)) continue;
      expect(script, `${name} must read argv`).toMatch(/item \d+ of argv|item \(i \+ \d+\) of argv/);
    }
  });

  it("bounds every script except the export", () => {
    // Export re-encodes the document, which is legitimately slow; the process
    // ceiling in osascript.ts bounds it instead.
    for (const [name, script] of ALL) {
      if (name === "EXPORT_SCRIPT") continue;
      expect(script, `${name} must bound its Pages calls`).toContain("with timeout of");
    }
  });

  it("never quits Pages", () => {
    // Quitting would close documents the user opened. The bag has no business
    // doing that, and a stray `quit` here would be silent about it.
    for (const [name, script] of ALL) {
      expect(script, `${name} must not quit Pages`).not.toMatch(/\bto quit\b/);
    }
  });

  it("never drives the interface through System Events", () => {
    // Synthetic clicks and keystrokes land wherever focus happens to be, which
    // has sent a half-written message in this codebase before. This bag talks
    // only to Pages' object model.
    for (const [name, script] of ALL) {
      expect(script, `${name} must not use System Events`).not.toContain("System Events");
    }
  });

  /**
   * Empty strings vanish at every join and trim between AppleScript and the
   * caller, which silently turned a 3x2 table into one row of two cells. The
   * row number and the leading column count are what survive that, so both are
   * load-bearing rather than decoration.
   */
  it("keeps an empty table row distinguishable from no row at all", () => {
    expect(scripts.READ_TABLE_SCRIPT).toContain("set rowCells to {r as text}");
    expect(scripts.READ_TABLE_SCRIPT).toContain("set end of out to colCount as text");
  });

  it("does not let an empty cell read as the words 'missing value'", () => {
    expect(scripts.READ_TABLE_SCRIPT).toContain("is not missing value");
  });

  /**
   * A page-layout document — a resume, a flyer — has no body text at all: every
   * word lives in a text box, and a grouped box is not even reported among the
   * document's own shapes. Reading only the body returned "" for such a file,
   * which reads as "this document is empty" rather than as a gap in the reader.
   * Both walks are what make that text reachable.
   */
  it("reads text from boxes and groups, not just the document body", () => {
    expect(scripts.READ_TEXT_SCRIPT).toContain("count of shapes of d");
    expect(scripts.READ_TEXT_SCRIPT).toContain("shapes of group g of d");
  });

  it("reports groups, so a reader can tell grouped text exists", () => {
    expect(scripts.INSPECT_SCRIPT).toContain("count of groups of d");
  });

  /**
   * Pages answers an `open` it will not honour with `missing value` rather than
   * an error, so an unchecked script runs on and fails several lines later with
   * a message about types that never mentions the file. Checked at the source,
   * the error names the document.
   */
  it("checks every open for a document Pages declined to give back", () => {
    for (const [name, script] of ALL) {
      const opens = script.match(/set d to open /g)?.length ?? 0;
      if (opens === 0) continue;
      const guards = script.match(/if d is missing value then error/g)?.length ?? 0;
      expect(guards, `${name} guards each of its ${opens} open(s)`).toBe(opens);
    }
  });

  /**
   * The reset-to-baseline pass asks to style "character 1 to the end" of each
   * paragraph, and only AppleScript knows where that end is. Without the
   * sentinel the caller would have to guess a length, and a guess that overruns
   * styles nothing at all — which is how a restore reports success having
   * changed nothing.
   */
  /**
   * Opening a POSIX file built from an argv string fails: Pages returns no
   * document and reports "could not open the Word file", while the identical
   * path interpolated into the script text opens fine. Coercing to an alias
   * fixes it. This cost a long hunt through quarantine, zip structure and
   * temp-directory theories before the argv-vs-interpolation difference showed
   * up, so it is pinned rather than left to be rediscovered.
   */
  it("coerces the imported Word file's path to an alias", () => {
    expect(scripts.IMPORT_DOCX_SCRIPT).toContain("(POSIX file sourcePath) as alias");
  });

  /**
   * The reset-to-baseline pass styles "character 1 to the end" of each
   * paragraph, and only AppleScript knows where that end is. A caller-guessed
   * length that overruns styles nothing at all.
   */
  it("resolves the end-of-paragraph sentinel itself", () => {
    expect(scripts.STYLE_RUNS_SCRIPT).toContain("if c2 is -1 then set c2 to count of characters");
  });

  /**
   * One stale offset should not discard every other correct restoration, so a
   * range Pages rejects is skipped. Returning the count is what keeps that from
   * being silent — a caller seeing far fewer applied than requested knows.
   */
  it("skips a range it cannot style rather than abandoning the batch", () => {
    expect(scripts.STYLE_RUNS_SCRIPT).toContain("set applied to applied + 1");
    expect(scripts.STYLE_RUNS_SCRIPT).toContain("return applied as text");
  });

  /**
   * `open` on a document that is already on screen returns the user's own
   * window, so closing unconditionally discards whatever they had not saved.
   * An export was seen doing exactly that. Every close has to be conditional on
   * this script having opened the document itself.
   */
  it("closes only documents it opened itself", () => {
    for (const [name, script] of ALL) {
      if (!script.includes("set d to open ")) continue;

      // IMPORT_DOCX_SCRIPT opens a .docx this bag just wrote to a temp
      // directory — a file that did not exist a moment ago and that nobody can
      // have open. The guard exists to protect a user's window; there is no
      // window here, and leaving the import on screen would be the bug.
      if (name === "IMPORT_DOCX_SCRIPT") {
        expect(script, "the import must still close what it opened").toContain("close d saving no");
        continue;
      }

      expect(script, `${name} must check whether the document was already open`).toContain(
        "my isAlreadyOpen(",
      );
      expect(script, `${name} needs the isAlreadyOpen handler`).toContain("on isAlreadyOpen(");
      // A close not guarded by `if not wasOpen then` is a close of someone
      // else's window.
      const unguarded = script.match(/(?<!then )close d saving no/g) ?? [];
      expect(unguarded.length, `${name} has an unguarded close`).toBe(0);
    }
  });

  it("checks whether Pages is running before asking it anything, where it must not launch it", () => {
    for (const name of ["STATUS_SCRIPT", "LIST_DOCUMENTS_SCRIPT"] as const) {
      expect(scripts[name]).toContain('application "Pages" is running');
    }
  });
});
