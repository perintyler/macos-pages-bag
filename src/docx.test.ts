import { describe, expect, it } from "vitest";
import { parseDocx, summarize } from "./docx.js";

/**
 * The XML below follows the shape Pages' own DOCX exporter produces — run
 * properties in `<w:rPr>`, sizes in half-points, `w:ascii` for the font. The
 * point of this parser is to recover formatting AppleScript refuses to report,
 * so the tests are about whether bold-inside-a-line survives, which is exactly
 * the case that was lost.
 */
const xml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
  <w:p><w:r><w:rPr><w:b/><w:sz w:val="44"/><w:rFonts w:ascii="Times Roman"/></w:rPr><w:t>Tyler Perin</w:t></w:r></w:p>
  <w:p>
    <w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:t>MySampler</w:t></w:r>
    <w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve"> is a plugin (</w:t></w:r>
    <w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:t>C++</w:t></w:r>
    <w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>)</w:t></w:r>
  </w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:rPr><w:i/></w:rPr><w:t>Won grants</w:t></w:r></w:p>
  <w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>Explicitly not bold</w:t></w:r></w:p>
  <w:p><w:r><w:t>Inherits its size</w:t></w:r></w:p>
  <w:p><w:r><w:t>   </w:t></w:r></w:p>
  <w:p><w:r><w:t>Tom &amp; Jerry &lt;3</w:t></w:r></w:p>
</w:body></w:document>`;

const parsed = parseDocx(xml);

describe("parseDocx", () => {
  it("drops paragraphs with no text", () => {
    // A Pages export is full of spacing paragraphs; returning them as empty
    // entries would bury the real content.
    expect(parsed.map((p) => p.text)).not.toContain("");
    expect(parsed).toHaveLength(6);
  });

  /**
   * The whole reason this parser exists. AppleScript reports one style per
   * paragraph, so a line reading "**MySampler** is a plugin (**C++**)" comes
   * back as uniformly bold. Here the bold and plain spans stay distinct.
   */
  it("keeps styling that changes within a single line", () => {
    const paragraph = parsed[1];
    expect(paragraph.text).toBe("MySampler is a plugin (C++)");
    expect(paragraph.runs.map((r) => r.bold)).toEqual([true, false, true, false]);
  });

  it("converts half-points to points", () => {
    // Word stores 22pt as 44; reporting the raw value would double every size.
    expect(parsed[0].runs[0].size).toBe(22);
    expect(parsed[1].runs[0].size).toBe(12);
  });

  it("reads the font", () => {
    expect(parsed[0].runs[0].font).toBe("Times Roman");
  });

  it("reads italics and list nesting", () => {
    expect(parsed[2].runs[0].italic).toBe(true);
    expect(parsed[2].level).toBe(1);
  });

  /**
   * `<w:b w:val="0"/>` turns bold OFF. Treating any `<w:b` as bold would report
   * plain text as bold — the same false positive that made the document look
   * uniformly styled in the first place.
   */
  it("does not read an explicit bold-off as bold", () => {
    expect(parsed[3].runs[0].bold).toBe(false);
  });

  it("leaves an inherited size absent rather than guessing one", () => {
    expect(parsed[4].runs[0].size).toBeUndefined();
  });

  it("decodes XML entities", () => {
    expect(parsed[5].text).toBe("Tom & Jerry <3");
  });

  it("preserves significant whitespace between runs", () => {
    expect(parsed[1].text).toContain("MySampler is");
  });
});

describe("summarize", () => {
  const summary = summarize(parsed);

  it("counts runs and styled runs", () => {
    expect(summary.runs).toBe(9);
    expect(summary.boldRuns).toBe(3);
    expect(summary.italicRuns).toBe(1);
  });

  it("lists the distinct sizes and fonts present", () => {
    // This is the at-a-glance answer to "is this uniformly styled?" — one size
    // and one font would mean an edit cannot lose anything.
    expect(summary.sizes).toEqual([12, 22]);
    expect(summary.fonts).toEqual(["Times Roman"]);
  });

  it("reports the deepest list nesting", () => {
    expect(summary.maxLevel).toBe(1);
  });
});
