import { describe, expect, it } from "vitest";
import { classifyError, extractErrorCode } from "./classify-error.js";

/**
 * The stderr strings below were copied from real osascript runs against Pages
 * 14.1 rather than written from memory — a classifier tested only against
 * invented input proves nothing about the errors it will actually meet.
 */
const REAL_NOT_FOUND =
  'edit.applescript:129:189: execution error: Pages got an error: Can’t get template "NoSuchTemplate". (-1728)';
const REAL_TIMEOUT =
  "probe.scpt:37:76: execution error: Pages got an error: AppleEvent timed out. (-1712)";
const REAL_CANCELLED =
  "osascript:28:42: execution error: Pages got an error: User canceled. (-128)";

describe("extractErrorCode", () => {
  it("reads the trailing code", () => {
    expect(extractErrorCode(REAL_NOT_FOUND)).toBe(-1728);
    expect(extractErrorCode(REAL_TIMEOUT)).toBe(-1712);
  });

  it("returns null when there is no code", () => {
    expect(extractErrorCode("something broke")).toBeNull();
  });

  it("ignores a number that is not the trailing code", () => {
    // A document's own text can reach stderr; a parenthesised number inside it
    // must not be mistaken for the error code.
    expect(extractErrorCode("error: the text said (-1728) and then stopped")).toBeNull();
  });
});

describe("classifyError", () => {
  it("classifies a missing object", () => {
    expect(classifyError(1, null, REAL_NOT_FOUND).kind).toBe("not-found");
  });

  it("classifies an AppleEvent timeout", () => {
    expect(classifyError(1, null, REAL_TIMEOUT).kind).toBe("timeout");
  });

  it("classifies a cancellation", () => {
    expect(classifyError(1, null, REAL_CANCELLED).kind).toBe("cancelled");
  });

  it("classifies a TCC refusal by code", () => {
    const error = classifyError(1, null, "execution error: Not authorized to send Apple events to Pages. (-1743)");
    expect(error.kind).toBe("permission-denied");
  });

  it("classifies a TCC refusal by wording when no code is printed", () => {
    expect(classifyError(1, null, "osascript is not allowed assistive access").kind).toBe(
      "permission-denied",
    );
  });

  it("treats a killed process as a timeout", () => {
    // The outer ceiling fires when Pages is wedged behind a dialog, so no
    // AppleScript error is ever printed — the signal is the only evidence.
    const error = classifyError(null, "SIGKILL", "");
    expect(error.kind).toBe("timeout");
    // The caller has to know a dialog may still be on screen.
    expect(error.message).toMatch(/dialog/i);
  });

  it("passes an unrecognised failure through rather than guessing", () => {
    const error = classifyError(1, null, "execution error: something new. (-9999)");
    expect(error.kind).toBe("pages-error");
    expect(error.message).toContain("-9999");
  });

  it("explains that the automation grant is per-binary", () => {
    // The usual first-run failure is a grant that exists for the user's shell
    // but not for this node, so the message has to point there.
    const error = classifyError(1, null, "not authorized (-1743)");
    expect(error.message).toMatch(/per binary|Automation/i);
  });
});
