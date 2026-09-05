import { describe, expect, it } from "vitest";
import { isBoldFace, resolveFace } from "./faces.js";

/**
 * Every face name asserted here was checked against NSFont on macOS before being
 * written down. That matters more than usual: Pages answers an unknown face by
 * leaving the text exactly as it was, so a typo does not raise — it silently
 * does nothing, and the caller sees "the styling had no effect".
 */
describe("resolveFace", () => {
  it("resolves all four cuts of Times", () => {
    const of = (bold: boolean, italic: boolean) =>
      resolveFace({ current: "Times-Roman", bold, italic }).face;
    expect(of(false, false)).toBe("Times-Roman");
    expect(of(true, false)).toBe("Times-Bold");
    expect(of(false, true)).toBe("Times-Italic");
    expect(of(true, true)).toBe("Times-BoldItalic");
  });

  it("uses each family's own name for slanted text", () => {
    // Helvetica calls it Oblique; HelveticaNeue calls it Italic. Assuming one
    // spelling for both produces a face that does not exist.
    expect(resolveFace({ current: "Helvetica", italic: true }).face).toBe("Helvetica-Oblique");
    expect(resolveFace({ current: "HelveticaNeue", italic: true }).face).toBe("HelveticaNeue-Italic");
  });

  it("resolves from any cut of a family, not just its regular", () => {
    // Captured runs arrive wearing whatever cut they already had, so bolding
    // something already italic has to start from the italic face.
    expect(resolveFace({ current: "Times-Italic", bold: true, italic: true }).face).toBe("Times-BoldItalic");
    expect(resolveFace({ current: "Times-Bold", bold: false, italic: false }).face).toBe("Times-Roman");
  });

  it("prefers the longer family stem", () => {
    // "HelveticaNeue-Bold" starts with "Helvetica" too; matching that first
    // would return a face from the wrong family.
    expect(resolveFace({ current: "HelveticaNeue-Bold", bold: true }).face).toBe("HelveticaNeue-Bold");
  });

  it("handles the Arial and Times New Roman naming schemes", () => {
    expect(resolveFace({ current: "ArialMT", bold: true }).face).toBe("Arial-BoldMT");
    expect(resolveFace({ current: "TimesNewRomanPSMT", bold: true }).face).toBe("TimesNewRomanPS-BoldMT");
  });

  /**
   * The important failure case. Appending "-Bold" to an unknown stem yields a
   * name that usually is not a real face, and Pages responds by doing nothing —
   * so the caller would be told the styling was applied when it was not.
   */
  it("leaves an unrecognised family alone and says so", () => {
    const result = resolveFace({ current: "SomeCustomFont-Light", bold: true });
    expect(result.face).toBe("SomeCustomFont-Light");
    expect(result.exact).toBe(false);
    expect(result.note).toMatch(/unrecognised/i);
  });

  it("marks a resolved face as exact", () => {
    expect(resolveFace({ current: "Times-Roman", bold: true }).exact).toBe(true);
  });
});

describe("isBoldFace", () => {
  it("recognises the bold cuts of known families", () => {
    expect(isBoldFace("Times-Bold")).toBe(true);
    expect(isBoldFace("Times-BoldItalic")).toBe(true);
    expect(isBoldFace("Arial-BoldMT")).toBe(true);
  });

  it("does not call a regular or italic face bold", () => {
    expect(isBoldFace("Times-Roman")).toBe(false);
    expect(isBoldFace("Times-Italic")).toBe(false);
  });

  it("falls back to the name for families it does not know", () => {
    expect(isBoldFace("SomeCustomFont-Bold")).toBe(true);
    expect(isBoldFace("SomeCustomFont-Light")).toBe(false);
  });
});
