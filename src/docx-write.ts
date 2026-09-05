/**
 * Editing a document through DOCX, because AppleScript cannot reach its design.
 *
 * Pages' `rich text` class exposes exactly three properties: `color`, `font`,
 * `size`. There is no underline, and no list vocabulary anywhere in the
 * dictionary. So a document whose design depends on either — a resume with
 * ruled headings and two levels of bullets, say — cannot be edited through
 * AppleScript without losing what makes it look like itself.
 *
 * DOCX carries all of it. The round trip is:
 *
 *     .pages --export--> .docx --edit word/document.xml--> .docx
 *            --Pages opens it--> save as .pages
 *
 * Measured on a real resume: 92 paragraphs preserved exactly, 22 italics
 * preserved exactly, list nesting preserved, bold runs 115 → 106, and the only
 * casualty a 15pt size used by one header link. Every requirement AppleScript
 * could not satisfy — ruled headings, nested bullets — survives.
 *
 * The cost is that this rewrites the whole document rather than one box, so
 * anything Pages' own exporter drops is dropped for good. `edit_document` stays
 * the right tool for plain text; this is for documents whose formatting matters
 * more than a surgical edit does.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UNZIP_TIMEOUT_MS = 30_000;
const ZIP_TIMEOUT_MS = 30_000;

function run(command: string, args: string[], timeoutMs: number, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, ...(cwd ? { cwd } : {}) }, (error) => {
      if (error) reject(new Error(`${command} failed: ${error.message}`));
      else resolve();
    });
  });
}

/** A text replacement to make inside the document's XML. */
export interface Replacement {
  find: string;
  replace: string;
}

export interface RewriteResult {
  /** Path to the rewritten .docx. */
  docx: string;
  /** How many times each replacement actually matched. */
  applied: Array<{ find: string; count: number }>;
}

/**
 * XML-escape a replacement's text.
 *
 * The replacement is going into an XML document, so an ampersand or angle
 * bracket in it would produce a file Pages refuses to open — and it refuses by
 * saying the format is invalid, which points nowhere near the real cause.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Rewrite `word/document.xml` inside a `.docx`, in place, returning a new file.
 *
 * Replacements are literal, not regular expressions: the caller is matching
 * document text, and a stray `.` or `(` in a sentence should not become a
 * wildcard.
 *
 * A replacement that matches nothing is reported with `count: 0` rather than
 * ignored. Silently applying zero of five edits and returning success is the
 * failure this reports its way out of — the caller has to see which ones missed.
 */
export async function rewriteDocx(
  docxPath: string,
  replacements: Replacement[],
): Promise<RewriteResult> {
  const scratch = await mkdtemp(join(tmpdir(), "macos-pages-rewrite-"));
  const unpacked = join(scratch, "unpacked");

  try {
    await run("/usr/bin/unzip", ["-q", "-o", docxPath, "-d", unpacked], UNZIP_TIMEOUT_MS);

    const xmlPath = join(unpacked, "word", "document.xml");
    let xml = await readFile(xmlPath, "utf8");

    const applied: RewriteResult["applied"] = [];
    for (const { find, replace } of replacements) {
      // Text in the XML is already escaped, so the needle has to be escaped the
      // same way to match what is actually in the file.
      const needle = escapeXml(find);
      const parts = xml.split(needle);
      applied.push({ find, count: parts.length - 1 });
      xml = parts.join(escapeXml(replace));
    }

    await writeFile(xmlPath, xml, "utf8");

    // Rezip from inside the directory: a .docx's entries are relative to the
    // package root, and zipping the directory itself would nest everything a
    // level deeper and produce a file no reader accepts.
    const rewritten = join(scratch, "rewritten.docx");
    await run("/usr/bin/zip", ["-q", "-r", "-X", rewritten, "."], ZIP_TIMEOUT_MS, unpacked);

    // Move it out of the scratch directory before that is removed.
    const kept = docxPath.replace(/\.docx$/, "") + "-rewritten.docx";
    await run("/bin/cp", [rewritten, kept], ZIP_TIMEOUT_MS);

    // Unquarantine AFTER the copy, not before.
    //
    // A file this process writes inherits `com.apple.quarantine`, and Pages will
    // not open a quarantined document under automation — it blocks on a modal
    // alert until the Apple event times out. `cp` applies the flag to the
    // destination it creates, so clearing the source first achieves nothing:
    // that ordering mistake cost a full debugging pass, with the failure
    // surfacing as "could not open the Word file", which points nowhere near it.
    //
    // The file was written here from a document the caller already had open, so
    // there is no provenance worth preserving.
    await run("/usr/bin/xattr", ["-d", "com.apple.quarantine", kept], ZIP_TIMEOUT_MS).catch(() => {
      // Absent on systems that did not apply it; nothing to undo.
    });

    return { docx: kept, applied };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Every run of text in the document, in order, with the paragraph it belongs to.
 *
 * A caller replacing text needs to know what strings actually exist to match
 * against — the document's own text is split across runs at every styling
 * boundary, so "Built a **search engine** from scratch" is three separate runs
 * and searching for the whole sentence finds nothing.
 */
export function runTexts(xml: string): string[] {
  const texts: string[] = [];
  for (const run of xml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
    const text = [...run[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((m) => m[1])
      .join("");
    if (text) texts.push(text);
  }
  return texts;
}
