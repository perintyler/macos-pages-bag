/**
 * Finding out whether a document's text actually fits on the page.
 *
 * Nothing in Pages' dictionary answers this. `count of pages` reports 1 for a
 * document whose text box is overflowing and silently dropping its last several
 * lines — the page count is the same whether the text fits or two whole jobs
 * have fallen off the bottom of a resume. Believing it is how an edit gets
 * reported as "fits" while content is disappearing.
 *
 * What does answer it: export to PDF, read back the text the PDF actually
 * renders, and compare. Text the document holds but the PDF never draws was
 * clipped. That comparison is the check, and it fails loudly — a broken version
 * reports nothing clipped on a document that is visibly losing lines, which is
 * what the test pins.
 *
 * Text extraction uses PDFKit through JavaScript for Automation. `pdftotext`
 * would also work but is a Homebrew install; PDFKit ships with macOS, so the bag
 * gains no host dependency.
 */

import { execFile } from "node:child_process";

const OSASCRIPT = "/usr/bin/osascript";
const EXTRACT_TIMEOUT_MS = 30_000;

/**
 * Reads a PDF's page count and full text.
 *
 * `on run argv` keeps the path out of the script body, the same rule the
 * AppleScript in scripts.ts follows: a filename containing a quote is data, not
 * syntax.
 */
const EXTRACT_SCRIPT = `
ObjC.import("Quartz");
function run(argv) {
  var url = $.NSURL.fileURLWithPath(argv[0]);
  var doc = $.PDFDocument.alloc.initWithURL(url);
  if (!doc || doc.js === undefined) { throw new Error("could not open PDF"); }
  return JSON.stringify({ pages: doc.pageCount, text: doc.string.js });
}
`;

export interface PdfContent {
  pages: number;
  text: string;
}

export function extractPdfContent(pdfPath: string): Promise<PdfContent> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      OSASCRIPT,
      ["-l", "JavaScript", "-", pdfPath],
      { timeout: EXTRACT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Could not read the exported PDF: ${String(stderr || error.message).trim()}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as PdfContent);
        } catch {
          reject(new Error("The PDF reader returned something unparseable."));
        }
      },
    );
    child.stdin?.end(EXTRACT_SCRIPT);
  });
}

/**
 * Text is compared with whitespace collapsed and case ignored.
 *
 * A PDF re-flows what it draws: line breaks land in different places, runs of
 * spaces collapse, and a tab becomes whitespace. Comparing raw strings would
 * report every line as missing. What matters is whether the *words* were drawn.
 */
function normalize(line: string): string {
  return line.replace(/\s+/g, " ").trim().toLowerCase();
}

export interface FitResult {
  fits: boolean;
  pages: number;
  /** Lines the document holds that the PDF never drew, verbatim from the source. */
  clipped: string[];
}

/**
 * Compare what a document contains against what its PDF renders.
 *
 * Pure, so the comparison can be tested without Pages or a PDF: given source
 * text and rendered text, it must name exactly the lines that went missing.
 *
 * Short lines are skipped. A stray "2024" or "•" from the source may legitimately
 * appear nowhere in the rendered text as its own token while still being drawn,
 * and reporting those as clipped would bury the real losses in noise.
 */
export function findClippedLines(sourceText: string, renderedText: string): string[] {
  const rendered = normalize(renderedText);

  return sourceText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => normalize(line).length >= 12)
    .filter((line) => !isRendered(line, rendered));
}

/**
 * Whether a source line's words all appear in the rendered text.
 *
 * Position is deliberately ignored. A line is only "clipped" if its words are
 * absent from the page, and every positional comparison tried here produced
 * false positives on real layout:
 *
 * - Matching the whole line fails on a heading written as
 *   `Company — Title<tab><padding>Date`, which the layout draws as two columns
 *   and which therefore never appears contiguously in the rendered text.
 * - Matching the first N words fails the same way once N reaches across the
 *   column gap. At N=5, `GovDash — Software Engineer February` was reported
 *   missing while every word of it was plainly on the page.
 *
 * Two false positives on one resume were enough to bury the genuine losses, and
 * a check that cries wolf is worse than no check. Word presence has no such
 * failure mode: the words were either drawn or they were not.
 *
 * Short words are skipped — "a" or "of" occur somewhere in any document and
 * would make every line look present.
 */
function isRendered(line: string, renderedText: string): boolean {
  const words = normalize(line)
    .split(" ")
    .filter((word) => word.length >= 4);

  // Nothing distinctive enough to search for; assume it rendered rather than
  // accuse it of being missing.
  if (words.length < 2) return true;

  return words.every((word) => renderedText.includes(word));
}
