/**
 * The edit vocabulary, and how a list of edits crosses into AppleScript.
 *
 * Edits are described as data and applied in one pass so that a document is
 * opened, changed and saved once, rather than once per change. The alternative
 * — a tool per verb — means a document round trip for every styled paragraph.
 *
 * Encoding: each operation becomes a fixed number of argv items, `kind` first.
 * The AppleScript walks argv with a cursor, reading the count each kind
 * declares. Nothing is interpolated, so a table cell containing a tab, a quote
 * or a newline is still just a value.
 */

import { z } from "zod";

/** 0–65535 per channel, which is the range Pages' `color` property uses. */
const colorSchema = z
  .tuple([z.number().int().min(0).max(65535), z.number().int().min(0).max(65535), z.number().int().min(0).max(65535)])
  .describe("RGB, each channel 0-65535 (Pages' scale, not 0-255)");

/** A point on the page in points, origin top-left. */
const positionSchema = z
  .tuple([z.number(), z.number()])
  .describe("Position in points from the top-left of the page");

export const operationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("set_text"),
    text: z.string().describe("Replaces the entire body text"),
  }),
  z.object({
    kind: z.literal("append_text"),
    text: z.string().describe("Added to the end of the body text"),
  }),
  z.object({
    kind: z.literal("page_break"),
  }).describe("Appends a page break to the body text"),
  z.object({
    kind: z.literal("style_paragraph"),
    index: z.number().int().min(1).describe("1-based paragraph number"),
    font: z.string().optional().describe("PostScript or display name, e.g. 'Helvetica-Bold'"),
    size: z.number().positive().optional().describe("Point size"),
    color: colorSchema.optional(),
  }),
  z.object({
    kind: z.literal("add_table"),
    rows: z.number().int().min(1).max(999),
    columns: z.number().int().min(1).max(999),
    page: z.number().int().min(1).default(1).describe("Page to place the table on"),
  }),
  z.object({
    kind: z.literal("set_cell"),
    table: z.number().int().min(1).describe("1-based table number"),
    row: z.number().int().min(1),
    column: z.number().int().min(1),
    value: z.string().describe("Pages converts numeric-looking text to a number, so '42' reads back as 42"),
  }),
  z.object({
    kind: z.literal("add_image"),
    file: z.string().describe("Absolute path to the image"),
    position: positionSchema.optional(),
    width: z.number().positive().optional().describe("Width in points; height follows the aspect ratio"),
    page: z.number().int().min(1).default(1),
  }),
  z.object({
    kind: z.literal("add_text_item"),
    text: z.string(),
    position: positionSchema.optional(),
    page: z.number().int().min(1).default(1),
  }),
  /**
   * Replace the text of a box that already exists. This is how a page-layout
   * document gets edited: a resume or flyer keeps its words in shapes, so
   * `set_text` — which writes the document body — would leave every visible
   * word untouched.
   *
   * `group` addresses a box nested one level inside a group, the same nesting
   * `read_document` walks. Numbering follows the order `read_document` reports,
   * so read the document first and count from its output.
   */
  z.object({
    kind: z.literal("set_shape_text"),
    shape: z.number().int().min(1).describe("1-based shape number, in read_document order"),
    group: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("1-based group number, when the box is inside a group"),
    text: z.string().describe("Replaces the box's entire text"),
  }),
]);

export type Operation = z.infer<typeof operationSchema>;

/** Absent optionals travel as this, since argv has no null. */
const ABSENT = "";

/**
 * Flatten operations into argv items.
 *
 * Field order per kind is the contract between this function and
 * EDIT_DOCUMENT_SCRIPT; operations.test.ts pins it, because a mismatch would
 * misread later operations rather than fail outright.
 */
export function encodeOperations(operations: Operation[]): string[] {
  const argv: string[] = [];

  for (const op of operations) {
    argv.push(op.kind);
    switch (op.kind) {
      case "set_text":
      case "append_text":
        argv.push(op.text);
        break;
      case "page_break":
        break;
      case "style_paragraph":
        argv.push(
          String(op.index),
          op.font ?? ABSENT,
          op.size === undefined ? ABSENT : String(op.size),
          op.color ? op.color.join(",") : ABSENT,
        );
        break;
      case "add_table":
        argv.push(String(op.rows), String(op.columns), String(op.page));
        break;
      case "set_cell":
        argv.push(String(op.table), String(op.row), String(op.column), op.value);
        break;
      case "add_image":
        argv.push(
          op.file,
          op.position ? String(op.position[0]) : ABSENT,
          op.position ? String(op.position[1]) : ABSENT,
          op.width === undefined ? ABSENT : String(op.width),
          String(op.page),
        );
        break;
      case "add_text_item":
        argv.push(
          op.text,
          op.position ? String(op.position[0]) : ABSENT,
          op.position ? String(op.position[1]) : ABSENT,
          String(op.page),
        );
        break;
      case "set_shape_text":
        argv.push(String(op.shape), op.group === undefined ? ABSENT : String(op.group), op.text);
        break;
    }
  }

  return argv;
}

/** Paths an operation needs to exist before Pages is asked to open them. */
export function imagePaths(operations: Operation[]): string[] {
  return operations.filter((op) => op.kind === "add_image").map((op) => op.file);
}
