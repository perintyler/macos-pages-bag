import { describe, expect, it } from "vitest";
import { EXPORT_FORMATS, exportFormatSchema, FORMAT_EXTENSIONS, toEnumerator, type ExportFormat } from "./format.js";
import { EXPORT_SCRIPT } from "./scripts.js";

const FORMATS = Object.keys(EXPORT_FORMATS) as ExportFormat[];

describe("export formats", () => {
  it("maps every format to the term Pages actually accepts", () => {
    // Verified against Pages 14.1's dictionary — these are dictionary keywords,
    // so a near-miss like "Word" is not a synonym, it is an error.
    expect(EXPORT_FORMATS).toEqual({
      pdf: "PDF",
      docx: "Microsoft Word",
      rtf: "formatted text",
      epub: "EPUB",
      text: "unformatted text",
      pages09: "Pages 09",
    });
  });

  /**
   * The export script matches the enumerator by string and raises on anything
   * it does not recognise. A format in the schema with no branch would pass
   * validation and then fail at the very end, after opening the document.
   */
  it("has a branch in the script for every format the schema accepts", () => {
    for (const format of FORMATS) {
      expect(EXPORT_SCRIPT, `${format} needs a branch`).toContain(`if fmt is "${toEnumerator(format)}"`);
    }
  });

  it("gives every format a file extension", () => {
    for (const format of FORMATS) {
      expect(FORMAT_EXTENSIONS[format], `${format} needs an extension`).toMatch(/^\./);
    }
  });

  it("accepts exactly the formats it maps", () => {
    expect(exportFormatSchema.options.slice().sort()).toEqual(FORMATS.slice().sort());
  });

  it("rejects a format it cannot export", () => {
    expect(() => exportFormatSchema.parse("doc")).toThrow();
    expect(() => exportFormatSchema.parse("pages")).toThrow();
  });
});
