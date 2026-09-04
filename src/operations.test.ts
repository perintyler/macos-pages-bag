import { describe, expect, it } from "vitest";
import { encodeOperations, imagePaths, operationSchema, type Operation } from "./operations.js";
import { EDIT_DOCUMENT_SCRIPT } from "./scripts.js";

/**
 * The encoder and EDIT_DOCUMENT_SCRIPT agree on how many argv items each
 * operation occupies. If they ever disagree, the script does not fail — it
 * reads the next operation's fields as its own and applies something nobody
 * asked for. These tests are what makes that disagreement loud.
 */
const FIELD_COUNTS: Record<Operation["kind"], number> = {
  set_text: 1,
  append_text: 1,
  page_break: 0,
  style_paragraph: 4,
  add_table: 3,
  set_cell: 4,
  add_image: 5,
  add_text_item: 4,
  set_shape_text: 3,
};

function parse(input: unknown): Operation {
  return operationSchema.parse(input);
}

describe("encodeOperations", () => {
  it("puts the kind first and the declared number of fields after it", () => {
    for (const [kind, count] of Object.entries(FIELD_COUNTS) as Array<[Operation["kind"], number]>) {
      const argv = encodeOperations([sample(kind)]);
      expect(argv[0], `${kind} leads with its kind`).toBe(kind);
      expect(argv.length, `${kind} encodes ${count} field(s)`).toBe(count + 1);
    }
  });

  it("matches the cursor steps in the AppleScript", () => {
    // The script advances by 1 for the kind plus one per field. Reading those
    // steps out of the script itself keeps this test honest if it changes.
    for (const [kind, count] of Object.entries(FIELD_COUNTS) as Array<[Operation["kind"], number]>) {
      const branch = new RegExp(`op is "${kind}" then[\\s\\S]*?set i to i \\+ (\\d+)`);
      const match = branch.exec(EDIT_DOCUMENT_SCRIPT);
      expect(match, `${kind} has a branch`).not.toBeNull();
      expect(Number(match![1]), `${kind} advances past its fields`).toBe(count + 1);
    }
  });

  it("encodes several operations back to back", () => {
    const argv = encodeOperations([
      parse({ kind: "set_text", text: "Hello" }),
      parse({ kind: "page_break" }),
      parse({ kind: "set_cell", table: 1, row: 2, column: 3, value: "x" }),
    ]);
    expect(argv).toEqual(["set_text", "Hello", "page_break", "set_cell", "1", "2", "3", "x"]);
  });

  it("passes text through untouched", () => {
    // Quotes, backslashes and newlines are the whole reason for argv.
    const text = 'He said "hi" \\ back\nand stopped.';
    expect(encodeOperations([parse({ kind: "set_text", text })])[1]).toBe(text);
  });

  it("sends absent optionals as empty, which the script tests for", () => {
    const argv = encodeOperations([parse({ kind: "style_paragraph", index: 1, size: 12 })]);
    expect(argv).toEqual(["style_paragraph", "1", "", "12", ""]);
  });

  it("joins colour channels the way parseColor splits them", () => {
    const argv = encodeOperations([parse({ kind: "style_paragraph", index: 2, color: [65535, 0, 128] })]);
    expect(argv[4]).toBe("65535,0,128");
  });
});

describe("operationSchema", () => {
  it("rejects an unknown operation", () => {
    expect(() => parse({ kind: "delete_everything" })).toThrow();
  });

  it("rejects a colour channel outside Pages' range", () => {
    // Pages uses 0-65535, not 0-255; 255 is legal but dark, while 70000 is not
    // legal at all.
    expect(() => parse({ kind: "style_paragraph", index: 1, color: [70000, 0, 0] })).toThrow();
  });

  it("rejects a paragraph index of zero", () => {
    // AppleScript indexes from 1; a 0 would be a silent off-by-one.
    expect(() => parse({ kind: "style_paragraph", index: 0 })).toThrow();
  });

  it("defaults a placement to the first page", () => {
    expect(parse({ kind: "add_table", rows: 2, columns: 2 })).toMatchObject({ page: 1 });
  });
});

describe("imagePaths", () => {
  it("finds the paths that must exist before Pages opens them", () => {
    const ops = [
      parse({ kind: "set_text", text: "x" }),
      parse({ kind: "add_image", file: "/tmp/a.png" }),
      parse({ kind: "add_image", file: "/tmp/b.png" }),
    ];
    expect(imagePaths(ops)).toEqual(["/tmp/a.png", "/tmp/b.png"]);
  });

  it("returns nothing when no images are involved", () => {
    expect(imagePaths([parse({ kind: "page_break" })])).toEqual([]);
  });
});

function sample(kind: Operation["kind"]): Operation {
  switch (kind) {
    case "set_text":
      return parse({ kind, text: "x" });
    case "append_text":
      return parse({ kind, text: "x" });
    case "page_break":
      return parse({ kind });
    case "style_paragraph":
      return parse({ kind, index: 1, font: "Helvetica", size: 12, color: [0, 0, 0] });
    case "add_table":
      return parse({ kind, rows: 2, columns: 2, page: 1 });
    case "set_cell":
      return parse({ kind, table: 1, row: 1, column: 1, value: "x" });
    case "add_image":
      return parse({ kind, file: "/tmp/a.png", position: [1, 2], width: 3, page: 1 });
    case "add_text_item":
      return parse({ kind, text: "x", position: [1, 2], page: 1 });
    case "set_shape_text":
      return parse({ kind, shape: 1, group: 2, text: "x" });
  }
}
