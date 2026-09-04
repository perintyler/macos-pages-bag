import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@barry/tools";
import * as tools from "./tools.js";

// Object.values() over a module namespace yields a union of every export, and a
// type predicate must be assignable to its parameter type. Widening to unknown
// first lets us narrow to just the tool definitions without naming that union.
const allTools = (Object.values(tools) as unknown[]).filter(
  (v): v is ToolDefinition & { handler: (args: never) => unknown } =>
    typeof v === "object" && v !== null && "name" in v && "handler" in v,
);

const MANIFEST = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "bag.yaml"),
  "utf8",
);

describe("tool exports", () => {
  it("exports the tools the bag promises", () => {
    expect(allTools.length).toBe(10);
  });

  for (const tool of allTools) {
    describe(tool.name, () => {
      it("has required fields", () => {
        expect(tool.name).toBeTruthy();
        expect(tool.namespace).toBeTruthy();
        expect(typeof tool.handler).toBe("function");
        expect(tool.description).toBeTruthy();
      });

      it("is in the pages namespace", () => {
        expect(tool.namespace).toBe("pages");
      });

      it("does not repeat its namespace in its name", () => {
        // Namespaces already prefix the tool at the protocol level, so
        // `pages_status` would surface as `pages_pages_status`.
        expect(tool.name.startsWith("pages")).toBe(false);
      });

      it("declares an access level defineTool accepts", () => {
        // The manifest allows `readwrite`, defineTool does not — a tool that
        // used it would fail to load rather than fail a check here.
        expect(["read", "write"]).toContain(tool.access);
      });
    });
  }
});

describe("access levels", () => {
  it("marks everything that touches a document as a write", () => {
    const writes = allTools.filter((t) => t.access === "write").map((t) => t.name).sort();
    expect(writes).toEqual([
      "convert_documents",
      "create_document",
      "edit_document",
      "export_document",
    ]);
  });

  it("keeps the inspection tools read-only", () => {
    const reads = allTools.filter((t) => t.access === "read").map((t) => t.name).sort();
    expect(reads).toEqual([
      "inspect_document",
      "list_documents",
      "list_templates",
      "read_document",
      "read_table",
      "status",
    ]);
  });
});

describe("manifest agreement", () => {
  it("defers only tools that exist", () => {
    // A deferred name with no matching tool is silently ignored, leaving the
    // tool in tools/list where the manifest says it should not be.
    const deferred = [...MANIFEST.matchAll(/^\s+- (\w+)$/gm)].map((m) => m[1]);
    expect(deferred).toEqual(["list_templates", "read_table"]);
    for (const name of deferred) {
      expect(allTools.some((t) => t.name === name), `${name} must exist`).toBe(true);
    }
  });

  it("offers no way to close or quit Pages", () => {
    // Closing a document the user opened discards unsaved work with no undo.
    for (const tool of allTools) {
      expect(tool.name).not.toMatch(/^(quit|close)/);
    }
  });
});
