import { describe, expect, it } from "vitest";
import { matchRuns, withoutRedundant, type CapturedRun } from "./styling.js";

const run = (text: string, extra: Partial<CapturedRun> = {}): CapturedRun => ({
  text,
  bold: false,
  italic: false,
  font: "Times-Roman",
  ...extra,
});

describe("matchRuns", () => {
  it("locates a run and returns 1-based inclusive offsets", () => {
    // AppleScript addresses `characters N thru M` counting from 1 and including
    // both ends; off-by-one here styles the wrong span.
    const { targets } = matchRuns([run("PostgreSQL", { bold: true })], "Stored in PostgreSQL today");
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ paragraph: 1, from: 11, to: 20, face: "Times-Bold" });
  });

  it("finds text that moved to a different paragraph", () => {
    // The reason matching is by text and not by position: an edit that adds or
    // removes a line shifts everything after it.
    const { targets } = matchRuns([run("React", { bold: true })], "First line\nSecond\nBuilt with React here");
    expect(targets[0].paragraph).toBe(3);
  });

  /**
   * The failure this whole module has to be honest about. A rewritten bullet
   * simply is not there any more, and reporting it as restored would be the
   * silent lie the repo forbids.
   */
  it("reports a run whose text is gone rather than guessing", () => {
    const { targets, unmatched } = matchRuns([run("Tactile Brain", { bold: true })], "Completely different text");
    expect(targets).toHaveLength(0);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].text).toBe("Tactile Brain");
  });

  it("maps a repeated phrase to successive occurrences", () => {
    // Without consuming what it matched, every occurrence would collapse onto
    // the first and the later ones would go unstyled.
    const { targets } = matchRuns([run("React", { bold: true }), run("React", { bold: true })], "React and React");
    expect(targets.map((t) => t.from)).toEqual([1, 11]);
  });

  it("ignores runs too short to identify", () => {
    // A run holding " " or "—" occurs everywhere; the first match would almost
    // never be the right one. Not reported as unmatched — an unstyled space is
    // indistinguishable either way.
    const { targets, unmatched } = matchRuns([run(" "), run("—")], "Some — text here");
    expect(targets).toHaveLength(0);
    expect(unmatched).toHaveLength(0);
  });

  it("carries the size through", () => {
    const { targets } = matchRuns([run("Heading", { size: 15 })], "Heading text");
    expect(targets[0].size).toBe(15);
  });

  it("flags a run whose family could not be resolved", () => {
    const { targets } = matchRuns([run("Something", { font: "MysteryFont", bold: true })], "Something here");
    expect(targets[0].exact).toBe(false);
  });

  it("returns nothing for an empty capture", () => {
    expect(matchRuns([], "Any text at all")).toEqual({ targets: [], unmatched: [] });
  });
});

/**
 * Why the caller resets the box to a plain baseline before applying these
 * targets, rather than only styling what matched.
 *
 * A flattened box wears the heading's bold on every character. Styling only the
 * matched runs leaves every unmatched line — most of the body after a real edit
 * — still bold. Measured on the resume: bold runs went 145 → 159 when they
 * should have been heading toward 115. Resetting first put them at 87.
 *
 * This test pins the shape of the problem: after a substantial rewrite, most
 * captured runs do not match, so most of the box is *only* covered by the
 * baseline.
 */
describe("matching after a substantial rewrite", () => {
  it("leaves most runs unmatched, which is why a baseline reset is needed", () => {
    const captured = [
      run("Built data collection pipelines"),
      run("Used Temporal to schedule jobs"),
      run("PostgreSQL", { bold: true }),
    ];
    const rewritten = "Built Cost Alerts from the ground up\nShipped cost recommendations";

    const { targets, unmatched } = matchRuns(captured, rewritten);
    expect(targets).toHaveLength(0);
    expect(unmatched).toHaveLength(3);
  });
});

describe("withoutRedundant", () => {
  it("drops targets that match the text's existing style", () => {
    // Every target is an AppleScript round trip; restyling text to what it
    // already is buys nothing and a box can hold hundreds of runs.
    const targets = [
      { paragraph: 1, from: 1, to: 5, face: "Times-Roman", size: 12, exact: true },
      { paragraph: 1, from: 7, to: 9, face: "Times-Bold", size: 12, exact: true },
    ];
    expect(withoutRedundant(targets, "Times-Roman", 12)).toHaveLength(1);
    expect(withoutRedundant(targets, "Times-Roman", 12)[0].face).toBe("Times-Bold");
  });

  it("keeps a target whose size differs even when the face matches", () => {
    const targets = [{ paragraph: 1, from: 1, to: 5, face: "Times-Roman", size: 15, exact: true }];
    expect(withoutRedundant(targets, "Times-Roman", 12)).toHaveLength(1);
  });
});
