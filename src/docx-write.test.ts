import { describe, expect, it } from "vitest";
import { runTexts } from "./docx-write.js";

/**
 * `runTexts` is what tells a caller which strings are matchable. That matters
 * more than it sounds: a document's text is split at every styling change, so
 * "Built a search engine (React)" with React in bold is three separate runs and
 * searching for the whole sentence finds nothing. Reporting the runs is how a
 * caller finds out what to search for instead of guessing.
 */
describe("runTexts", () => {
  it("returns each run's text in document order", () => {
    const xml = `<w:document><w:body>
      <w:p><w:r><w:t>Built a </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>search engine</w:t></w:r><w:r><w:t> from scratch</w:t></w:r></w:p>
    </w:body></w:document>`;
    expect(runTexts(xml)).toEqual(["Built a ", "search engine", " from scratch"]);
  });

  it("joins the pieces of a split run", () => {
    // Word splits a single run's text across several <w:t> elements when it
    // needs to preserve spacing; those are one run, not several.
    const xml = `<w:p><w:r><w:t xml:space="preserve">Hello </w:t><w:t>world</w:t></w:r></w:p>`;
    expect(runTexts(xml)).toEqual(["Hello world"]);
  });

  it("skips runs with no text", () => {
    // A run holding only a page break or a drawing has nothing to match on.
    const xml = `<w:p><w:r><w:br/></w:r><w:r><w:t>Real text</w:t></w:r></w:p>`;
    expect(runTexts(xml)).toEqual(["Real text"]);
  });

  it("returns nothing for a document with no runs", () => {
    expect(runTexts("<w:document><w:body/></w:document>")).toEqual([]);
  });
});
