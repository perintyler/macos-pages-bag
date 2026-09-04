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
 */

import { defineTool } from "@barry/tools";
import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";

import { exportFormatSchema, FORMAT_EXTENSIONS, toEnumerator, type ExportFormat } from "./format.js";
import { encodeOperations, imagePaths, operationSchema, type Operation } from "./operations.js";
import { EXPORT_TIMEOUT_MS, PagesScriptError, runScript, splitFields } from "./osascript.js";
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
  READ_TABLE_SCRIPT,
  READ_TEXT_SCRIPT,
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
  description: "Read the body text of a Pages document.",
  schema: {
    path: z.string().describe("Absolute path to a .pages document"),
  },
  handler: async ({ path }) => {
    const resolved = await requireExistingFile(path, "path");
    const text = await runScript(READ_TEXT_SCRIPT, [resolved]);
    return { path: resolved, text };
  },
  cliFormat: (result) => (result as { text: string }).text,
});

export const inspectDocument = defineTool({
  namespace: NAMESPACE,
  access: "read",
  name: "inspect_document",
  description:
    "Count the structure of a Pages document: paragraphs, words, characters, pages, sections, tables, images and shapes.",
  schema: {
    path: z.string().describe("Absolute path to a .pages document"),
  },
  handler: async ({ path }) => {
    const resolved = await requireExistingFile(path, "path");
    const [paragraphs, words, characters, pages, sections, tables, images, shapes] = splitFields(
      await runScript(INSPECT_SCRIPT, [resolved]),
    ).map(Number);

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
    "Apply an ordered list of edits to an existing Pages document: replace or append text, style a paragraph, add page breaks, tables, cell values, images and text boxes. All edits are applied in one pass and saved.",
  schema: {
    path: z.string().describe("Absolute path to a .pages document"),
    operations: z
      .array(operationSchema)
      .min(1)
      .describe("Edits applied in order; later ones see the result of earlier ones"),
  },
  handler: async ({ path, operations }) => {
    const resolved = await requireExistingFile(path, "path");
    await refuseIfOpen(resolved);

    // Image paths get the same treatment as document paths: Pages stalls on a
    // missing one exactly the same way.
    for (const image of imagePaths(operations as Operation[])) {
      await requireExistingFile(image, "add_image.file");
    }

    const paragraphs = await runScript(EDIT_DOCUMENT_SCRIPT, [
      resolved,
      ...encodeOperations(operations as Operation[]),
    ]);

    return {
      path: resolved,
      operationsApplied: operations.length,
      paragraphCount: Number(paragraphs),
    };
  },
  cliFormat: (result) => {
    const r = result as { operationsApplied: number; path: string };
    return `Applied ${r.operationsApplied} edit(s) to ${r.path}.`;
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
