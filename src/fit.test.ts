import { describe, expect, it } from "vitest";
import { findClippedLines } from "./fit.js";

/**
 * This comparison is the whole fit check. Its failure mode is silence: a broken
 * version returns an empty list, which reads as "everything fits" on a document
 * that is dropping lines. That is the case these tests exist to make loud.
 */
describe("findClippedLines", () => {
  it("reports nothing when every line was rendered", () => {
    const text = "GovDash — Software Engineer\nBuilt data collection pipelines";
    expect(findClippedLines(text, text)).toEqual([]);
  });

  /**
   * Taken from the real failure: a resume whose text box overflowed still
   * reported one page, while two jobs were missing from the render.
   */
  it("names the lines a render dropped", () => {
    const source = [
      "GovDash — Software Engineer",
      "Chess.com — Software Engineer",
      "Exec Online — Software Developer Intern",
      "Tactile Brain — Software Developer Intern",
    ].join("\n");
    const rendered = "GovDash — Software Engineer\nChess.com — Software Engineer";

    expect(findClippedLines(source, rendered)).toEqual([
      "Exec Online — Software Developer Intern",
      "Tactile Brain — Software Developer Intern",
    ]);
  });

  it("ignores where a PDF re-wraps lines", () => {
    // A PDF breaks lines wherever the column ends and collapses runs of spaces,
    // so a literal comparison would call every line missing.
    const source = "Built   data collection pipelines\tand implemented CI/CD";
    const rendered = "Built data collection\npipelines and implemented CI/CD";
    expect(findClippedLines(source, rendered)).toEqual([]);
  });

  it("ignores case differences", () => {
    expect(findClippedLines("Software Engineer at Vantage", "SOFTWARE ENGINEER AT VANTAGE")).toEqual([]);
  });

  /**
   * Fragments like a bare year or a bullet character may not survive as their
   * own token even when the line they belong to is drawn. Reporting them would
   * bury the real losses.
   */
  it("does not report short fragments as clipped", () => {
    const source = "2024\n•\nA line long enough to actually matter here";
    const rendered = "A line long enough to actually matter here";
    expect(findClippedLines(source, rendered)).toEqual([]);
  });

  /**
   * A heading is written as `Company — Title<tab><padding>Date` and drawn as
   * two columns, so the source line never appears contiguously in the rendered
   * text. Matching whole lines called these clipped when every word was on the
   * page — two false positives on the real resume, which is worse than no check
   * because it hides the genuine losses.
   */
  it("does not flag a heading the layout splits into columns", () => {
    const source = "GovDash — Software Engineer\t                    February 2024 - July 2024";
    const rendered = "GovDash — Software Engineer                         February 2024 - July 2024";
    expect(findClippedLines(source, rendered)).toEqual([]);
  });

  it("still catches a heading that genuinely did not render", () => {
    const source = "Exec Online — Software Developer Intern\t          June - July 2018";
    expect(findClippedLines(source, "GovDash — Software Engineer")).toHaveLength(1);
  });

  it("reports everything when nothing rendered at all", () => {
    const source = "A line long enough to count\nAnother line long enough to count";
    expect(findClippedLines(source, "")).toHaveLength(2);
  });
});
