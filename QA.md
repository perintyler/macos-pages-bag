<!-- tools: Bash,Read -->
# QA: macos-pages

What only a live Pages can show. The unit tests cover the pure logic; these steps
cover the parts that involve a real application, real windows, and a document
somebody would mind losing.

## Requirements

- macOS with Pages installed.
- **Automation permission for the node that runs these steps.** The grant is
  per-binary, so `osascript` working in your shell proves nothing. A denial shows
  up as error 1743. If step 1 reports `automationAllowed: false`, that is a setup
  problem, not a bag bug.
- Pages **not running**, and no unsaved Pages documents open. Several steps check
  whether windows survive, which needs a known starting point.
- **A document Pages can actually open.** macOS grants access per file, when a
  person opens it. Copy your fixture into place and open it once in Finder before
  starting, or every write step will fail with "Operation not permitted".

## Setup

```bash
cd ~/repos/bags/macos-pages
pnpm install
rm -rf /tmp/qa-pages && mkdir -p /tmp/qa-pages/out
sips -s format png --resampleWidth 60 \
  /System/Library/CoreServices/DefaultDesktop.heic --out /tmp/qa-pages/img.png
```

Each step runs through a scratch file:

```bash
cat > qa-step.ts <<'EOF'
import * as t from "./src/tools.js";
const call = (tool: any, args: any) => tool.handler(args, undefined);
// step body goes here
EOF
npx tsx qa-step.ts
```

## Test Steps

### 1. It compiles and the unit tests pass

```bash
npx tsc --noEmit && npx vitest run
```

**Expected:** exit 0, 180 tests passed.

### 2. The guards fail when broken

A guard that has never been seen to fail is a claim, not a result. Break each and
confirm the suite goes red:

```bash
# The overwrite guard
sed -i '' 's/if (overwrite) return;/if (true) return;/' src/preflight.ts
npx vitest run src/preflight.test.ts   # Expected: 1 failed
git checkout src/preflight.ts

# The "only close what we opened" guard
sed -i '' 's/if not wasOpen then close d saving no/close d saving no/g' src/scripts.ts
npx vitest run src/scripts.test.ts     # Expected: 1 failed
git checkout src/scripts.ts

# The end-of-paragraph sentinel
sed -i '' 's/if c2 is -1 then set c2 to count of characters/set c2 to c2 -- /' src/scripts.ts
npx vitest run src/scripts.test.ts     # Expected: 1 failed
git checkout src/scripts.ts
```

### 3. `status` does not launch Pages

```bash
pgrep -x Pages || echo "not running"
# call status
pgrep -x Pages || echo "still not running"
```

**Expected:** not running before or after. `status` reports `installed: true`,
`running: false`, `automationAllowed: null` — null because nothing has asked
Pages anything yet.

### 4. A bad path fails fast instead of hanging

The motivating hazard: handed a path that does not exist, Pages puts up an alert
and blocks the Apple event for ~2 minutes.

```ts
const t0 = Date.now();
try { await call(t.readDocument, { path: "/tmp/qa-pages/nope.pages" }); }
catch (e) { console.log(Date.now() - t0, "ms:", (e as Error).message); }
```

**Expected:** rejects in **under 1 second**, and Pages is still not running.
*If this takes ~30 seconds, the preflight has regressed.*

### 5. Round trip, including text that would break a quoted script

```ts
const text = 'He said "hi" \\ back\nSecond paragraph.\nThird.';
await call(t.createDocument, { path: "/tmp/qa-pages/doc.pages", text, template: "Blank" });
const r = await call(t.readDocument, { path: "/tmp/qa-pages/doc.pages" });
console.log("identical:", r.text === text);
console.log(await call(t.inspectDocument, { path: "/tmp/qa-pages/doc.pages" }));
```

**Expected:** `identical: true`, 3 paragraphs / 7 words / 1 page. The quote and
backslash surviving is the point — they cross as argv, never as script text.

### 6. Overwrite is refused unless asked for

```ts
try { await call(t.createDocument, { path: "/tmp/qa-pages/doc.pages", text: "x" }); }
catch (e) { console.log("refused:", (e as Error).message); }
await call(t.createDocument, { path: "/tmp/qa-pages/doc.pages", text: "x", overwrite: true });
```

**Expected:** the first refuses naming the path; the second succeeds.

### 7. Editing, and reading a single box

```ts
await call(t.editDocument, { path: "/tmp/qa-pages/doc.pages", operations: [
  { kind: "set_text", text: "Title\nBody." },
  { kind: "style_paragraph", index: 1, font: "Helvetica-Bold", size: 28, color: [65535, 0, 0] },
  { kind: "add_table", rows: 3, columns: 2 },
  { kind: "set_cell", table: 1, row: 1, column: 1, value: "Header A" },
  { kind: "add_image", file: "/tmp/qa-pages/img.png", position: [80, 400], width: 150 },
  { kind: "add_text_item", text: "A caption", position: [60, 600] },
  { kind: "page_break" },
]});
console.log(await call(t.inspectDocument, { path: "/tmp/qa-pages/doc.pages" }));
console.log(await call(t.readTable, { path: "/tmp/qa-pages/doc.pages", table: 1 }));
console.log(await call(t.readDocument, { path: "/tmp/qa-pages/doc.pages", shape: 1 }));
```

**Expected:** 2 pages, 1 table, 1 image, 1 shape. `read_table` returns **three**
rows of **two** cells — `[["Header A", ""], ["", ""], ["", ""]]`. A short or
missing final row means the empty-cell handling has regressed; the words
"missing value" appearing as a cell value means the same. `read_document` with
`shape: 1` returns only that box's text, not the whole document.

### 8. Export and conversion

```ts
for (const format of ["pdf", "docx", "rtf"]) {
  await call(t.exportDocument, { source: "/tmp/qa-pages/doc.pages",
    destination: `/tmp/qa-pages/out/doc.${format}`, format, overwrite: true });
}
```

```bash
file /tmp/qa-pages/out/*   # Expected: a real PDF, a Word document, an RTF
```

### 9. Rendering works on a copy Pages will not open

```bash
cp /tmp/qa-pages/doc.pages /tmp/qa-pages/copy.pages
pgrep -x Pages | xargs -r kill -9
```

```ts
// A copy has no sandbox grant, so this must fail:
try { await call(t.readDocument, { path: "/tmp/qa-pages/copy.pages" }); }
catch (e) { console.log("read refused, as expected"); }

// ...but rendering goes through QuickLook and must succeed:
console.log(await call(t.renderDocumentTool, { path: "/tmp/qa-pages/copy.pages",
  destination: "/tmp/qa-pages/out/copy.png", width: 1000 }));
```

**Expected:** the read fails, the render succeeds with `route: "quicklook"`, and
`pgrep -x Pages` shows Pages never launched.

### 10. Preview does not save

```ts
const before = (await call(t.readDocument, { path: "/tmp/qa-pages/doc.pages" })).text;
const p = await call(t.editDocument, { path: "/tmp/qa-pages/doc.pages",
  operations: [{ kind: "set_shape_text", shape: 1, text: "COMPLETELY DIFFERENT" }],
  preview: true });
const after = (await call(t.readDocument, { path: "/tmp/qa-pages/doc.pages" })).text;
console.log("applied:", p.applied, "| unchanged:", before === after, "| image:", p.preview);
```

**Expected:** `applied: false`, `unchanged: true`, and an image on disk showing
the *changed* text. A preview that leaves the document modified is the failure
this step exists to catch.

### 11. Formatting survives an edit — the step this bag was built for

Use a document with real styling: bold headings, plain body text, bold words
inside sentences. A resume is the canonical case.

```ts
const path = "/tmp/qa-pages/styled.pages";   // your styled fixture
const before = await call(t.readFormatted, { path, includeRuns: true });
console.log("before:", before.summary);      // note boldRuns

const runs = before.paragraphs.flatMap((p: any) => p.runs ?? []);
await call(t.editDocument, { path, operations: [
  { kind: "set_shape_text", shape: 1, group: 2, text: "New body text here\nAnd another line" }]});

const flat = await call(t.readFormatted, { path });
console.log("flattened:", flat.summary);     // boldRuns jumps — everything inherited the heading

const rs = await call(t.restoreStyling, { path, shape: 1, group: 2, runs,
  baseFace: "Times-Roman", baseSize: 12 });
console.log("restore:", rs);

const after = await call(t.readFormatted, { path });
console.log("after:", after.summary);
await call(t.renderDocumentTool, { path, destination: "/tmp/qa-pages/out/restored.png", width: 1000 });
```

**Expected:** `flattened.boldRuns` is markedly **higher** than `before.boldRuns`
— that is the damage. After `restore_styling`, `after.boldRuns` is back at or
below the original, and the render shows **plain body text** with headings and
inline tech names still bold. `restore` reports non-zero `restored` and an honest
`unmatched` count for the text that was rewritten.

*If `after.boldRuns` is still near the flattened number, the baseline reset has
regressed and the restore is only styling matched runs.*

### 12. Nested bullets are announced, not silently lost

Run step 11 on a document with two bullet levels.

**Expected:** the `edit_document` result carries a `warning` naming nested
bullets. Pages exposes no list-level vocabulary, so the nesting really is gone —
the requirement is that the bag says so at the time rather than leaving it to be
found in a render.

### 13. Overflow is detected

```ts
console.log(await call(t.checkFit, { path: "/tmp/qa-pages/styled.pages" }));
```

**Expected:** `fits` and a `clipped` list naming any lines the PDF did not draw.
On a document that visibly overflows, the clipped lines match what is missing
from `render_document`'s image. On one that does not, `clipped` is empty.

*A `clipped` list full of lines that are plainly visible means the comparison has
regressed to matching whole lines, which false-positives on column layouts.*

### 14. Quarantine

```bash
xattr -w com.apple.quarantine "0081;00000000;Test;" /tmp/qa-pages/doc.pages
```

```ts
console.log(await call(t.unblockDocument, { path: "/tmp/qa-pages/doc.pages" }));
```

```bash
xattr /tmp/qa-pages/doc.pages   # Expected: no com.apple.quarantine, others intact
```

Also: `unblock_document` on a `.txt` must be refused.

### 15. Your open window is left alone — the step that needs a human

Open `/tmp/qa-pages/doc.pages` in Pages by hand and **type a word into it without
saving**. Then:

```ts
console.log(await call(t.listDocuments, {}));                 // shows it, modified: true
await call(t.readDocument, { path: "/tmp/qa-pages/doc.pages" });
await call(t.exportDocument, { source: "/tmp/qa-pages/doc.pages",
  destination: "/tmp/qa-pages/out/open.pdf", format: "pdf", overwrite: true });
try { await call(t.createDocument, { path: "/tmp/qa-pages/doc.pages", text: "x", overwrite: true }); }
catch (e) { console.log("refused:", (e as Error).message); }
```

**Expected:** `list_documents` reports it with `modified: true`. The read and the
export both succeed **and your window is still open with your typed word in it**.
The create is refused, naming the document.

This is the step that cannot be automated, and the one that matters most: an
earlier version of this bag closed the user's window on every read and export.

### 16. A file Pages will not open

```bash
echo "not a pages file" > /tmp/qa-pages/broken.pages
```

```ts
try { await call(t.readDocument, { path: "/tmp/qa-pages/broken.pages" }); }
catch (e) { console.log((e as Error).message); }
```

**Expected:** an error within ~30 seconds saying Pages is showing an alert that
blocks automation. Pages really will be showing *"broken.pages can't be opened
right now"* — dismiss it, or quit Pages, before continuing.

### 17. Cleanup

```bash
rm -rf /tmp/qa-pages qa-step.ts
```

Quit Pages by hand. The bag has no quit tool on purpose — quitting closes
documents somebody may be working in, and `quit saving no` was seen returning
"User canceled" and leaving Pages running anyway.

## Deployed check (manual, needs a human)

After `barry install ~/repos/bags/macos-pages --as macos-pages` and
`barry pack macos-pages`:

```bash
barry bag show macos-pages
pnpm --filter @barry-rocks/mcp-server build:http   # the prod bundle does NOT auto-rebuild
launchctl kickstart -k gui/$(id -u)/com.barry.mcp.barry
```

**Expected:** 16 tools. In a fresh session, `list_templates`, `read_table`,
`diff_documents` and `unblock_document` are **absent** from the tool list but
reachable through tool search; the other twelve are present.

Skipping the bundle rebuild is the single most likely reason a change appears to
have had no effect — it cost a full debugging cycle once already.
