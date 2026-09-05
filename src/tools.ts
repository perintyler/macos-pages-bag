/**
 * The tools this bag exposes.
 *
 * Two rules run through all of them:
 *
 * - Paths are checked in Node before Pages sees them. Pages answers a bad path
 *   with a modal dialog and a blocked AppleEvent, so validating first is what
 *   turns a two-minute hang into an immediate error.
 *
 * - The bag never closes or quits something the user opened. A document is only
 *   closed by the same script that opened it. There is deliberately no `quit`
 *   or `close` tool: discarding someone's unsaved work is not undoable.
 *
 * `render_document` is the exception to both, and to AppleScript entirely — see
 * render.ts. Pages will not open a copy of a document, so anything that works on
 * a duplicate cannot be seen through Pages at all; QuickLook can render it
 * regardless.
 */

import { defineTool } from "@barry-rocks/tools";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { z } from "zod";

import { exportFormatSchema, FORMAT_EXTENSIONS, toEnumerator, type ExportFormat } from "./format.js";
import { encodeOperations, imagePaths, operationSchema, type Operation } from "./operations.js";
import { extractDocumentXml, parseDocx, summarize } from "./docx.js";
import { extractPdfContent, findClippedLines } from "./fit.js";
import { EXPORT_TIMEOUT_MS, PagesScriptError, runScript, splitFields } from "./osascript.js";
import { isQuarantined, unblock } from "./quarantine.js";
import { matchRuns, withoutRedundant } from "./styling.js";
import { renderDocument } from "./render.js";
import {
  isSamePath,
  PreflightError,
  requireExistingFile,
  requireOverwriteAllowed,
  requireWritableTarget,
} from "./preflight.js";
import {
  CREATE_DOCUMENT_SCRIPT,
  EDIT_DOCUMENT_SCRIPT,
  EXPORT_SCRIPT,
  INSPECT_SCRIPT,
  LIST_DOCUMENTS_SCRIPT,
  LIST_TEMPLATES_SCRIPT,
  READ_SHAPE_TEXT_SCRIPT,
  READ_TABLE_SCRIPT,
  READ_TEXT_SCRIPT,
  STYLE_RUNS_SCRIPT,
  STATUS_SCRIPT,
} from "./scripts.js";

/**
 * Matches the bag name deliberately. A bag's auto-trait grants its tools'
 * namespaces, but the registry derives that trait before it has introspected
 * the entry module — with no tools loaded yet it falls back to the bag name
 * (auto-traits.ts, `ownNamespaces`). A namespace that differs from the bag name
 * therefore grants something no tool publishes, and every session gets zero
 * tools while `bag show` still reports the bag enabled.
 */
const NAMESPACE = "macos-pages";
const PAGES_APP = "/Applications/Pages.app";

export interface OpenDocument {
  index: number;
  name: string;
  modified: boolean;
  path: string | null;
}

/** Parse the tab-delimited reply of LIST_DOCUMENTS_SCRIPT. */
function parseOpenDocuments(output: string): OpenDocument[] {
  if (!output.trim()) return [];
  return output.split("\n").map((line) => {
    const [index, name, modified, path] = splitFields(line);
    return {
      index: Number(index),
      name: name ?? "",
      modified: modified === "true",
      path: path ? path : null,
    };
  });
}

async function openDocuments(): Promise<OpenDocument[]> {
  return parseOpenDocuments(await runScript(LIST_DOCUMENTS_SCRIPT));
}

/**
 * Refuse to write to a document the user has open.
 *
 * Saving underneath an open editor loses whatever they have not saved, and
 * Pages will later write its own copy back over ours.
 *
 * Both sides are resolved before comparing, and that resolution happens here
 * rather than at the call sites: Pages reports a document opened from `/tmp/x`
 * as `/private/tmp/x`, so comparing a caller's raw path silently matched
 * nothing and the guard passed every time. A caller writing a file that does
 * not exist yet has nothing to resolve, so its path is compared as given.
 */
async function refuseIfOpen(path: string): Promise<void> {
  const resolvedPath = await realpath(path).catch(() => path);
  const documents = await openDocuments();
  const conflict = documents.find((doc) => doc.path && isSamePath(doc.path, resolvedPath));
  if (conflict) {
    throw new PreflightError(
      `"${conflict.name}" is open in Pages${conflict.modified ? " with unsaved changes" : ""}. ` +
        "Close it there first — writing to it now would discard what is on screen.",
    );
  }
}

export const status = defineTool({
  namespace: NAMESPACE,
  access: "read",
  name: "status",
  description:
    "Check whether Pages is installed, running, and controllable. Does not launch Pages.",
  schema: {},
  handler: async () => {
    const installed = existsSync(PAGES_APP);
    if (!installed) {
      return {
        installed: false,
        running: false,
        automationAllowed: false,
        detail: "Pages is not installed at /Applications/Pages.app.",
      };
    }

    try {
      const [running, version, documentCount] = splitFields(await runScript(STATUS_SCRIPT));
      return {
        installed: true,
        running: running === "true",
        // Only a running Pages proves the automation grant: if it is closed,
        // nothing has asked it anything yet, so claiming "allowed" here would
        // be a guess dressed as a check.
        automationAllowed: running === "true" ? true : null,
        version: version || null,
        openDocuments: Number(documentCount),
        detail:
          running === "true"
            ? `Pages ${version} is running with ${documentCount} document(s) open.`
            : "Pages is installed but not running. Automation is untested until it is.",
      };
    } catch (error) {
      if (error instanceof PagesScriptError && error.kind === "permission-denied") {
        return {
          installed: true,
          running: null,
          automationAllowed: false,
          detail: error.message,
        };
      }
      throw error;
    }
  },
  cliFormat: (result) => (result as { detail: string }).detail,
});

export const listDocuments = defineTool({
  namespace: NAMESPACE,
  access: "read",
  name: "list_documents",
  description:
    "List documents currently open in Pages, with their paths and whether they have unsaved changes. Returns an empty list when Pages is not running.",
  schema: {},
  handler: async () => ({ documents: await openDocuments() }),
  cliFormat: (result) => {
    const { documents } = result as { documents: OpenDocument[] };
    if (!documents.length) return "No documents open in Pages.";
    return documents
      .map((doc) => `${doc.index}. ${doc.name}${doc.modified ? " (unsaved changes)" : ""} — ${doc.path ?? "never saved"}`)
      .join("\n");
  },
});

export const createDocument = defineTool({
  namespace: NAMESPACE,
  access: "write",
  name: "create_document",
  description:
    "Create a Pages document from plain text and save it. Paragraphs are separated by newlines. Use edit_document afterwards to add formatting, tables or images.",
  schema: {
    path: z.string().describe("Absolute path to save to, ending in .pages"),
    text: z.string().default("").describe("Body text; newlines separate paragraphs"),
    template: z
      .string()
      .default("Blank")
      .describe(
        "Template name (see list_templates). Setting body text replaces a template's own content, so anything other than Blank is best-effort.",
      ),
    overwrite: z.boolean().default(false).describe("Replace the file if it already exists"),
  },
  handler: async ({ path, text, template, overwrite }) => {
    await requireWritableTarget(path, "path");
    await requireOverwriteAllowed(path, overwrite, "path");
    await refuseIfOpen(path);

    const paragraphs = await runScript(CREATE_DOCUMENT_SCRIPT, [path, template, text]);
    return { path, paragraphCount: Number(paragraphs), template };
  },
  cliFormat: (result) => {
    const r = result as { path: string; paragraphCount: number };
    return `Created ${r.path} (${r.paragraphCount} paragraph(s)).`;
  },
});

export const readDocument = defineTool({
  namespace: NAMESPACE,
  access: "read",
  name: "read_document",
  description:
    "Read a Pages document's text: its body, plus every text box, including boxes nested in groups. Page-layout documents such as resumes keep all their text in boxes and have an empty body.",
  schema: {
    path: z.string().describe("Absolute path to a .pages document"),
    shape: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Read only this box, numbered as read_document reports them. Omit for the whole document."),
    group: z.number().int().min(1).optional().describe("1-based group number, when the box is inside a group"),
  },
  handler: async ({ path, shape, group }) => {
    const resolved = await requireExistingFile(path, "path");

    // Scoping to one box matters for editing: offsets computed against the whole
    // document's concatenated text point at the wrong characters.
    const text =
      shape === undefined
        ? await runScript(READ_TEXT_SCRIPT, [resolved])
        : await runScript(READ_SHAPE_TEXT_SCRIPT, [
            resolved,
            String(shape),
            group === undefined ? "" : String(group),
          ]);

    return { path: resolved, ...(shape === undefined ? {} : { shape, group }), text };
  },
  cliFormat: (result) => (result as { text: string }).text,
});

export const inspectDocument = defineTool({
  namespace: NAMESPACE,
  access: "read",
  name: "inspect_document",
  description:
    "Count the structure of a Pages document: paragraphs, words, characters, pages, sections, tables, images, shapes and groups.",
  schema: {
    path: z.string().describe("Absolute path to a .pages document"),
  },
  handler: async ({ path }) => {
    const resolved = await requireExistingFile(path, "path");
    const [paragraphs, words, characters, pages, sections, tables, images, shapes, groups] =
      splitFields(await runScript(INSPECT_SCRIPT, [resolved])).map(Number);

    return {
      path: resolved,
      paragraphs,
      words,
      characters,
      pages,
      sections,
      tables,
      images,
      // Pages models a text box as a shape, so this counts both.
      shapes,
      // Grouped shapes are not counted among the document's own, so groups
      // indicate text the other totals do not account for.
      groups,
    };
  },
  cliFormat: (result) => {
    const r = result as Record<string, number>;
    return `${r.pages} page(s), ${r.paragraphs} paragraph(s), ${r.words} word(s), ${r.tables} table(s), ${r.images} image(s), ${r.shapes} shape(s)`;
  },
});

export const editDocument = defineTool({
  namespace: NAMESPACE,
  access: "write",
  name: "edit_document",
  description:
    "Apply an ordered list of edits to an existing Pages document: replace or append body text, replace the text of an existing box (set_shape_text — the way to edit a resume or other page-layout document), style a paragraph, add page breaks, tables, cell values, images and text boxes. All edits are applied in one pass and saved.",
  schema: {
    path: z.string().describe("Absolute path to a .pages document"),
    operations: z
      .array(operationSchema)
      .min(1)
      .describe("Edits applied in order; later ones see the result of earlier ones"),
    preview: z
      .boolean()
      .default(false)
      .describe("Apply the edits, render the result, then roll back. Nothing is saved."),
  },
  handler: async ({ path, operations, preview }) => {
    const resolved = await requireExistingFile(path, "path");
    await refuseIfOpen(resolved);

    // Image paths get the same treatment as document paths: Pages stalls on a
    // missing one exactly the same way.
    for (const image of imagePaths(operations as Operation[])) {
      await requireExistingFile(image, "add_image.file");
    }

    const replacesBoxText = (operations as Operation[]).some((op) => op.kind === "set_shape_text");

    // Replacing a box's text loses list nesting, because Pages exposes no verb
    // for it — so the loss is announced here rather than found later in a
    // render. Only worth the export when an operation can actually cause it.
    let warning: string | undefined;
    if (replacesBoxText) {
      const nested = (await readParagraphs(resolved)).some((p) => p.level > 0);
      if (nested) {
        warning =
          "This document uses nested bullets, and replacing a box's text flattens them — " +
          "Pages exposes no way to set list level from AppleScript. Everything else is preserved.";
      }
    }

    // Roll back to exactly what was there, which means capturing each affected
    // box's text first — per box, because that is the granularity the edit
    // works at and the only text a rollback can put back accurately.
    const touchedBoxes = (operations as Operation[]).filter(
      (op): op is Extract<Operation, { kind: "set_shape_text" }> => op.kind === "set_shape_text",
    );
    const before: Array<{ op: (typeof touchedBoxes)[number]; text: string }> = [];
    if (preview) {
      for (const op of touchedBoxes) {
        before.push({
          op,
          text: await runScript(READ_SHAPE_TEXT_SCRIPT, [
            resolved,
            String(op.shape),
            op.group === undefined ? "" : String(op.group),
          ]),
        });
      }
    }

    const paragraphs = await runScript(EDIT_DOCUMENT_SCRIPT, [
      resolved,
      ...encodeOperations(operations as Operation[]),
    ]);

    if (!preview) {
      return {
        path: resolved,
        applied: true,
        operationsApplied: operations.length,
        paragraphCount: Number(paragraphs),
        ...(warning ? { warning } : {}),
      };
    }

    const rendered = resolved.replace(/\.pages$/, "") + "-preview.png";
    try {
      await renderDocument(resolved, rendered, 1200);
    } finally {
      // In `finally` on purpose: a preview that fails to render must still leave
      // the document as it found it. A rollback that only runs on success is a
      // rollback that fails exactly when it is needed.
      if (before.length > 0) {
        await runScript(EDIT_DOCUMENT_SCRIPT, [
          resolved,
          ...encodeOperations(before.map(({ op, text }) => ({ ...op, text }))),
        ]);
      }
    }

    return {
      path: resolved,
      applied: false,
      preview: rendered,
      operationsApplied: operations.length,
      ...(warning ? { warning } : {}),
    };
  },
  cliFormat: (result) => {
    const r = result as { applied: boolean; operationsApplied: number; path: string; preview?: string; warning?: string };
    const head = r.applied
      ? `Applied ${r.operationsApplied} edit(s) to ${r.path}.`
      : `Previewed ${r.operationsApplied} edit(s) — not saved. See ${r.preview}`;
    return r.warning ? `${head}\n${r.warning}` : head;
  },
});

export const exportDocument = defineTool({
  namespace: NAMESPACE,
  access: "write",
  name: "export_document",
  description: "Export a Pages document to PDF, Word, RTF, EPUB, plain text or Pages 09 format.",
  schema: {
    source: z.string().describe("Absolute path to a .pages document"),
    destination: z.string().describe("Absolute path to write the exported file to"),
    format: exportFormatSchema.describe("Output format"),
    overwrite: z.boolean().default(false).describe("Replace the destination if it exists"),
  },
  handler: async ({ source, destination, format, overwrite }) => {
    const resolved = await requireExistingFile(source, "source");
    await requireWritableTarget(destination, "destination");
    await requireOverwriteAllowed(destination, overwrite, "destination");

    await runScript(EXPORT_SCRIPT, [resolved, destination, toEnumerator(format)], {
      timeoutMs: EXPORT_TIMEOUT_MS,
    });

    return { source: resolved, destination, format };
  },
  cliFormat: (result) => {
    const r = result as { destination: string; format: string };
    return `Exported to ${r.destination} (${r.format}).`;
  },
});

export const convertDocuments = defineTool({
  namespace: NAMESPACE,
  access: "write",
  name: "convert_documents",
  description:
    "Export every .pages document in a directory to another format. Reports each file's result rather than stopping at the first failure.",
  schema: {
    directory: z.string().describe("Absolute path to a directory containing .pages documents"),
    format: exportFormatSchema.describe("Output format"),
    outputDirectory: z
      .string()
      .optional()
      .describe("Where to write results (defaults to the source directory)"),
    overwrite: z.boolean().default(false).describe("Replace existing output files"),
  },
  handler: async ({ directory, format, outputDirectory, overwrite }) => {
    const target = outputDirectory ?? directory;
    await requireWritableTarget(join(target, "probe"), "outputDirectory");

    const entries = (await readdir(directory)).filter((name) => extname(name) === ".pages").sort();

    const results: Array<{ source: string; destination?: string; ok: boolean; error?: string }> = [];
    for (const entry of entries) {
      const source = join(directory, entry);
      const destination = join(
        target,
        entry.replace(/\.pages$/, FORMAT_EXTENSIONS[format as ExportFormat]),
      );
      try {
        const resolved = await requireExistingFile(source, "source");
        await requireOverwriteAllowed(destination, overwrite, "destination");
        await runScript(EXPORT_SCRIPT, [resolved, destination, toEnumerator(format)], {
          timeoutMs: EXPORT_TIMEOUT_MS,
        });
        results.push({ source, destination, ok: true });
      } catch (error) {
        // One unreadable document should not strand the rest of the batch, but
        // it must still be reported — a silent skip would read as success.
        results.push({ source, ok: false, error: (error as Error).message });
      }
    }

    return { converted: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  },
  cliFormat: (result) => {
    const r = result as { converted: number; failed: number; results: Array<{ source: string; error?: string }> };
    const lines = [`Converted ${r.converted}, failed ${r.failed}.`];
    for (const item of r.results) {
      if (item.error) lines.push(`  ✗ ${item.source}: ${item.error}`);
    }
    return lines.join("\n");
  },
});

/**
 * Export to a scratch file, hand it to `use`, and clean up.
 *
 * Both `check_fit` and `read_formatted` work by exporting and reading the
 * result, and neither wants the export left on disk. The temp directory is
 * removed even when `use` throws, so a failed check does not accumulate copies
 * of the caller's document somewhere they would not think to look.
 */
async function withExport<T>(
  source: string,
  format: ExportFormat,
  use: (exportedPath: string) => Promise<T>,
): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "macos-pages-export-"));
  const exported = join(scratch, `export${FORMAT_EXTENSIONS[format]}`);
  try {
    await runScript(EXPORT_SCRIPT, [source, exported, toEnumerator(format)], {
      timeoutMs: EXPORT_TIMEOUT_MS,
    });
    return await use(exported);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * A document's paragraphs with their styling, via a DOCX round trip.
 *
 * Shared by `read_formatted` (which reports it) and `restore_styling` (which
 * uses it as the record of what a box looked like before an edit).
 */
async function readParagraphs(source: string) {
  return withExport(source, "docx", async (docx) => {
    const scratch = await mkdtemp(join(tmpdir(), "macos-pages-docx-"));
    try {
      await extractDocumentXml(docx, scratch);
      return parseDocx(await readFile(join(scratch, "word", "document.xml"), "utf8"));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

export const checkFit = defineTool({
  namespace: NAMESPACE,
  access: "read",
  name: "check_fit",
  description:
    "Check whether a document's text actually fits, by comparing what it contains against what its PDF renders. Reports any lines clipped out of view. Pages' own page count does not reveal this — a box can overflow and silently drop lines while the document still reports one page.",
  schema: {
    path: z.string().describe("Absolute path to a .pages document"),
  },
  handler: async ({ path }) => {
    const resolved = await requireExistingFile(path, "path");

    // The document's own text, from every box and group.
    const sourceText = await runScript(READ_TEXT_SCRIPT, [resolved]);

    const rendered = await withExport(resolved, "pdf", (pdf) => extractPdfContent(pdf));
    const clipped = findClippedLines(sourceText, rendered.text);

    return {
      path: resolved,
      fits: clipped.length === 0,
      pages: rendered.pages,
      clippedLines: clipped.length,
      // Verbatim, so the caller can see exactly what fell off rather than being
      // told a count and left to guess.
      clipped,
    };
  },
  cliFormat: (result) => {
    const r = result as { fits: boolean; pages: number; clipped: string[] };
    if (r.fits) return `Fits on ${r.pages} page(s); nothing clipped.`;
    return [
      `${r.clipped.length} line(s) do not fit and are not rendered:`,
      ...r.clipped.map((line) => `  ✗ ${line}`),
    ].join("\n");
  },
});

export const readFormatted = defineTool({
  namespace: NAMESPACE,
  access: "read",
  name: "read_formatted",
  description:
    "Read a document's text along with its real formatting — bold, italic, size, font and list nesting, per run. Use this before editing a styled document: AppleScript reports only each paragraph's first character, so a document with bold headings reads back as entirely bold.",
  schema: {
    path: z.string().describe("Absolute path to a .pages document"),
    includeRuns: z
      .boolean()
      .default(false)
      .describe("Include every styled run. Off by default — a long document has hundreds."),
  },
  handler: async ({ path, includeRuns }) => {
    const resolved = await requireExistingFile(path, "path");
    const paragraphs = await readParagraphs(resolved);

    return {
      path: resolved,
      summary: summarize(paragraphs),
      paragraphs: paragraphs.map((p) => ({
        text: p.text,
        level: p.level,
        ...(includeRuns ? { runs: p.runs } : {}),
      })),
    };
  },
  cliFormat: (result) => {
    const r = result as { summary: { paragraphs: number; runs: number; boldRuns: number; sizes: number[]; fonts: string[] } };
    const s = r.summary;
    return `${s.paragraphs} paragraphs, ${s.runs} runs (${s.boldRuns} bold). Sizes: ${s.sizes.join(", ")}pt. Fonts: ${s.fonts.join(", ")}.`;
  },
});

export const restoreStyling = defineTool({
  namespace: NAMESPACE,
  access: "write",
  name: "restore_styling",
  description:
    "Re-apply a document's own formatting after its text was replaced. Replacing a text box's contents makes every character inherit the box's first character's style, which turns a styled document uniformly bold. Capture the styling first (this tool reads it), replace the text, then run this to put bold, italic and sizes back on the words that survived.",
  schema: {
    path: z.string().describe("Absolute path to a .pages document"),
    shape: z.number().int().min(1).describe("1-based shape number, in read_document order"),
    group: z.number().int().min(1).optional().describe("1-based group number, if the box is in a group"),
    runs: z
      .array(
        z.object({
          text: z.string(),
          bold: z.boolean().default(false),
          italic: z.boolean().default(false),
          size: z.number().positive().optional(),
          font: z.string().optional(),
        }),
      )
      .min(1)
      .describe("The styling captured before the edit — read_formatted's runs, with includeRuns: true"),
    baseFace: z
      .string()
      .default("Times-Roman")
      .describe("The face plain body text should wear. The whole box is reset to this first, then styled runs go on top. Pass \"\" to skip the reset and only add styling."),
    baseSize: z.number().positive().optional().describe("The size plain body text should wear"),
  },
  handler: async ({ path, shape, group, runs, baseFace, baseSize }) => {
    const resolved = await requireExistingFile(path, "path");

    // Match against the text as it is NOW, after the replacement.
    const currentText = await runScript(READ_SHAPE_TEXT_SCRIPT, [
      resolved,
      String(shape),
      group === undefined ? "" : String(group),
    ]);

    const { targets, unmatched } = matchRuns(runs, currentText);
    const worthDoing = withoutRedundant(targets, baseFace, baseSize);

    const argv = [resolved, String(shape), group === undefined ? "" : String(group)];

    // Reset the whole box to a baseline first, then style on top.
    //
    // Without this, restoring made things worse rather than better. A flattened
    // box wears the heading's bold everywhere; applying styling only to the runs
    // that matched leaves every unmatched line — most of the body, after real
    // edits — still bold. Measured on the resume: bold runs went 145 → 159 when
    // they should have been heading toward 115. Resetting first put them at 87.
    //
    // An empty `baseFace` skips the reset, which is how a caller adds styling to
    // a box without disturbing what is already there.
    const resetPasses = baseFace === "" ? 0 : currentText.split("\n").length;
    for (let paragraph = 1; paragraph <= resetPasses; paragraph++) {
      argv.push(
        String(paragraph),
        "1",
        // -1 as a sentinel for "to the end of the paragraph"; the script
        // resolves it, since only AppleScript knows the paragraph's length.
        "-1",
        baseFace,
        baseSize === undefined ? "" : String(baseSize),
      );
    }

    for (const target of worthDoing) {
      argv.push(
        String(target.paragraph),
        String(target.from),
        String(target.to),
        target.face,
        target.size === undefined ? "" : String(target.size),
      );
    }

    // The script counts every range it styled, resets included. Subtracting the
    // resets it was *asked* for would go negative whenever some were skipped —
    // a paragraph can be empty, and an empty range is not stylable. Clamping at
    // zero keeps the number meaning "styled runs applied" rather than becoming
    // an arithmetic artefact.
    const totalApplied = Number(await runScript(STYLE_RUNS_SCRIPT, argv));
    const applied = Math.max(0, Math.min(worthDoing.length, totalApplied - resetPasses));

    return {
      path: resolved,
      // Counts, not a bare "ok". A restore that matched nothing is a real
      // outcome the caller has to see rather than infer.
      restored: applied,
      skippedAsRedundant: targets.length - worthDoing.length,
      unmatched: unmatched.length,
      unmatchedText: unmatched.map((run) => run.text).slice(0, 20),
      unresolvedFonts: worthDoing.filter((t) => !t.exact).length,
    };
  },
  cliFormat: (result) => {
    const r = result as { restored: number; unmatched: number; unmatchedText: string[] };
    const lines = [`Restored styling on ${r.restored} range(s); ${r.unmatched} could not be matched.`];
    for (const text of r.unmatchedText) lines.push(`  ? ${text}`);
    return lines.join("\n");
  },
});

export const diffDocuments = defineTool({
  namespace: NAMESPACE,
  access: "read",
  name: "diff_documents",
  description:
    "Compare a document's text against another document or a supplied string, and report which lines were added and removed. Use it to confirm an edit changed only what was intended.",
  schema: {
    path: z.string().describe("Absolute path to the .pages document to compare"),
    against: z.string().optional().describe("Absolute path to a second .pages document"),
    text: z.string().optional().describe("Text to compare against, instead of a second document"),
  },
  handler: async ({ path, against, text }) => {
    if ((against === undefined) === (text === undefined)) {
      throw new PreflightError("Pass exactly one of `against` (a document) or `text`.");
    }

    const resolved = await requireExistingFile(path, "path");
    const current = await runScript(READ_TEXT_SCRIPT, [resolved]);

    const other =
      against !== undefined
        ? await runScript(READ_TEXT_SCRIPT, [await requireExistingFile(against, "against")])
        : (text as string);

    const lines = (value: string) =>
      value.split("\n").map((l) => l.trim()).filter(Boolean);

    const currentLines = lines(current);
    const otherLines = lines(other);
    const currentSet = new Set(currentLines);
    const otherSet = new Set(otherLines);

    // Set difference rather than a positional diff: the question these tools
    // answer is "did any content disappear", which reordering should not affect.
    const removed = otherLines.filter((l) => !currentSet.has(l));
    const added = currentLines.filter((l) => !otherSet.has(l));

    return {
      path: resolved,
      unchanged: currentLines.length - added.length,
      added,
      removed,
    };
  },
  cliFormat: (result) => {
    const r = result as { added: string[]; removed: string[]; unchanged: number };
    const out = [`${r.unchanged} line(s) unchanged, ${r.added.length} added, ${r.removed.length} removed.`];
    for (const line of r.removed) out.push(`  - ${line}`);
    for (const line of r.added) out.push(`  + ${line}`);
    return out.join("\n");
  },
});

export const unblockDocument = defineTool({
  namespace: NAMESPACE,
  access: "write",
  name: "unblock_document",
  description:
    "Remove the quarantine flag macOS puts on a downloaded .pages file. Pages refuses to open a quarantined document under automation, failing with 'can't be opened right now' rather than naming the cause.",
  schema: {
    path: z.string().describe("Absolute path to a .pages document"),
  },
  handler: async ({ path }) => {
    const resolved = await requireExistingFile(path, "path");
    const result = await unblock(resolved);
    return {
      path: result.path,
      removed: result.removed,
      detail: result.removed
        ? "Quarantine flag removed; Pages can open this file now."
        : "The file was not quarantined, so nothing changed.",
    };
  },
  cliFormat: (result) => (result as { detail: string }).detail,
});

export const renderDocumentTool = defineTool({
  namespace: NAMESPACE,
  access: "read",
  name: "render_document",
  description:
    "Render a Pages document's first page as an image, to see its actual layout and formatting. Works without launching Pages, and on copies Pages refuses to open. Shows the last saved state, not unsaved edits.",
  schema: {
    path: z.string().describe("Absolute path to a .pages document"),
    destination: z
      .string()
      .optional()
      .describe("Absolute path for the .png (defaults to alongside the document)"),
    width: z.number().int().min(200).max(4000).default(1200).describe("Image width in pixels"),
  },
  handler: async ({ path, destination, width }) => {
    const resolved = await requireExistingFile(path, "path");
    const target = destination ?? resolved.replace(/\.pages$/, "") + "-preview.png";
    await requireWritableTarget(target, "destination");

    const result = await renderDocument(resolved, target, width);

    return {
      path: result.path,
      route: result.route,
      documentModified: result.documentModified.toISOString(),
      // The two routes differ in how current they are, and a stale image that
      // looks current is worse than none — so say which one this is.
      note:
        result.route === "quicklook"
          ? "Rendered from the saved file. Unsaved changes in an open window are not shown."
          : "QuickLook was unavailable, so this is the preview Pages embedded at its last save — it may be older than the file.",
    };
  },
  cliFormat: (result) => {
    const r = result as { path: string; note: string };
    return `${r.path}\n${r.note}`;
  },
});

export const listTemplates = defineTool({
  namespace: NAMESPACE,
  access: "read",
  name: "list_templates",
  description: "List the Pages templates available for create_document.",
  schema: {},
  handler: async () => {
    const output = await runScript(LIST_TEMPLATES_SCRIPT);
    return { templates: output ? output.split("\n") : [] };
  },
  cliFormat: (result) => (result as { templates: string[] }).templates.join("\n"),
});

export const readTable = defineTool({
  namespace: NAMESPACE,
  access: "read",
  name: "read_table",
  description: "Read the cell values of one table in a Pages document, as rows of strings.",
  schema: {
    path: z.string().describe("Absolute path to a .pages document"),
    table: z.number().int().min(1).default(1).describe("1-based table number"),
  },
  handler: async ({ path, table }) => {
    const resolved = await requireExistingFile(path, "path");
    const output = await runScript(READ_TABLE_SCRIPT, [resolved, String(table)]);
    const [header, ...lines] = output ? output.split("\n") : [];
    const columns = Number(header ?? 0);

    // Every row arrives led by its row number and with trailing empty cells
    // already lost to trimming, so drop the number and pad back to width. A row
    // that is short here would otherwise read as a table with ragged rows.
    const rows = lines.map((line) => {
      const cells = splitFields(line).slice(1);
      while (cells.length < columns) cells.push("");
      return cells;
    });

    return { path: resolved, table, columns, rows };
  },
  cliFormat: (result) => {
    const { rows } = result as { rows: string[][] };
    return rows.map((row) => row.join("\t")).join("\n");
  },
});
