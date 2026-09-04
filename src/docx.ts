/**
 * Recovering formatting that AppleScript will not report.
 *
 * Pages' dictionary exposes `font`, `size` and `color` on a paragraph, but the
 * value it returns describes only that paragraph's *first* character. A line
 * whose first word is bold reports as bold in its entirety, so a document with
 * bold headings and plain body text reads back as uniformly bold — which is
 * exactly wrong for deciding how it will lay out, and led to a resume being
 * flattened to one style.
 *
 * Exporting to DOCX and reading `word/document.xml` gets the real answer. A
 * `.docx` is a zip of XML in which every span of uniformly-styled text is its
 * own `<w:r>` run carrying its own properties, so bold-inside-a-line survives
 * the trip. Measured on one real resume: 289 runs, 340 bold markers, 10 italic,
 * four distinct sizes — none of which AppleScript could see.
 *
 * The parsing here is deliberately small and regex-based rather than a full XML
 * implementation. It reads a single known shape of document produced by one
 * exporter, and only a handful of attributes from it; a parser generic enough to
 * be correct on arbitrary WordprocessingML would be far larger without being
 * more correct on this input.
 */

import { execFile } from "node:child_process";

const UNZIP_TIMEOUT_MS = 30_000;

/**
 * Unpack just `word/document.xml` from a `.docx`.
 *
 * A `.docx` is a zip, and only that one entry carries the text and its run
 * properties — extracting the whole archive would also write out every embedded
 * image for no benefit.
 */
export function extractDocumentXml(docxPath: string, intoDirectory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/unzip",
      ["-o", "-q", docxPath, "word/document.xml", "-d", intoDirectory],
      { timeout: UNZIP_TIMEOUT_MS },
      (error) => {
        if (error) reject(new Error(`Could not read the exported .docx: ${error.message}`));
        else resolve();
      },
    );
  });
}

export interface DocxRun {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Points. Absent when the run inherits its size from the document style. */
  size?: number;
  font?: string;
}

export interface DocxParagraph {
  /** The paragraph's whole text, runs joined in order. */
  text: string;
  runs: DocxRun[];
  /** List nesting depth, 0 when the paragraph is not part of a list. */
  level: number;
}

/**
 * A run's own properties block. Matched non-greedily so one run's properties
 * cannot absorb the next run's.
 */
const RUN_PROPERTIES = /<w:rPr>([\s\S]*?)<\/w:rPr>/;

/**
 * `<w:b/>` and `<w:b w:val="0"/>` both exist: the second turns bold *off*, and
 * reading it as "bold" would report plain text as bold.
 */
function hasToggle(properties: string, tag: string): boolean {
  const match = new RegExp(`<w:${tag}(\\s[^>]*)?/?>`).exec(properties);
  if (!match) return false;
  const attributes = match[1] ?? "";
  return !/w:val="(0|false|off)"/.test(attributes);
}

function parseRun(xml: string): DocxRun | null {
  // Text lives in <w:t>, which may carry xml:space="preserve".
  const textMatches = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)];
  if (textMatches.length === 0) return null;

  const text = textMatches.map((m) => decodeEntities(m[1])).join("");
  if (!text) return null;

  const properties = RUN_PROPERTIES.exec(xml)?.[1] ?? "";

  // Word stores sizes in half-points, so 24 means 12pt.
  const halfPoints = /<w:sz\s+w:val="(\d+)"/.exec(properties)?.[1];
  const font = /w:ascii="([^"]+)"/.exec(properties)?.[1];

  return {
    text,
    bold: hasToggle(properties, "b"),
    italic: hasToggle(properties, "i"),
    underline: hasToggle(properties, "u"),
    ...(halfPoints ? { size: Number(halfPoints) / 2 } : {}),
    ...(font ? { font } : {}),
  };
}

/** The five predefined XML entities, plus the numeric forms Word emits. */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    // Ampersand last: decoding it first would corrupt "&amp;lt;" into "<".
    .replace(/&amp;/g, "&");
}

/**
 * Parse `word/document.xml` into paragraphs and their runs.
 *
 * Paragraphs with no text are dropped rather than returned empty — a document
 * exported from Pages is full of spacing paragraphs, and they carry no
 * information a caller can act on.
 */
export function parseDocx(xml: string): DocxParagraph[] {
  const paragraphs: DocxParagraph[] = [];

  for (const match of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const body = match[1];

    const runs = [...body.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)]
      .map((run) => parseRun(run[1]))
      .filter((run): run is DocxRun => run !== null);

    const text = runs.map((r) => r.text).join("");

    // Whitespace-only counts as empty. Pages' spacing paragraphs often contain a
    // run of spaces rather than nothing at all, and keeping them would pad the
    // output with entries a caller cannot act on.
    if (!text.trim()) continue;

    const level = Number(/<w:ilvl\s+w:val="(\d+)"/.exec(body)?.[1] ?? 0);

    paragraphs.push({ text, runs, level });
  }

  return paragraphs;
}

export interface DocxSummary {
  paragraphs: number;
  runs: number;
  boldRuns: number;
  italicRuns: number;
  /** Distinct point sizes present, ascending. */
  sizes: number[];
  fonts: string[];
  /** Deepest list nesting seen; 0 means no nested lists. */
  maxLevel: number;
}

/**
 * Aggregate counts for a parsed document.
 *
 * The point is to answer "is this uniformly styled, or does it have structure?"
 * at a glance — the question that, unanswered, caused a formatted resume to be
 * overwritten with one style.
 */
export function summarize(paragraphs: DocxParagraph[]): DocxSummary {
  const runs = paragraphs.flatMap((p) => p.runs);
  const sizes = new Set<number>();
  const fonts = new Set<string>();

  for (const run of runs) {
    if (run.size !== undefined) sizes.add(run.size);
    if (run.font) fonts.add(run.font);
  }

  return {
    paragraphs: paragraphs.length,
    runs: runs.length,
    boldRuns: runs.filter((r) => r.bold).length,
    italicRuns: runs.filter((r) => r.italic).length,
    sizes: [...sizes].sort((a, b) => a - b),
    fonts: [...fonts].sort(),
    maxLevel: paragraphs.reduce((max, p) => Math.max(max, p.level), 0),
  };
}
