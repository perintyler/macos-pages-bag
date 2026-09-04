<!-- tools: Bash,Read -->
# QA: macos-pages

What only a live Pages can show. The unit tests cover the pure logic; these
steps cover the parts that involve a real application with real windows.

## Requirements

- macOS with Pages installed.
- **Automation permission for the node that runs these steps.** The grant is
  per-binary, so `osascript` working in your shell proves nothing. A denial
  shows up as error 1743. If step 1 reports `automationAllowed: false`, that is
  a setup problem, not a bag bug.
- Pages **not running**, and no unsaved Pages documents open. Several steps
  check whether windows survive, which needs a known starting point.

## Setup

```bash
cd ~/repos/bags/macos-pages
pnpm install
rm -rf /tmp/qa-pages && mkdir -p /tmp/qa-pages/out
sips -s format png --resampleWidth 60 \
  /System/Library/CoreServices/DefaultDesktop.heic --out /tmp/qa-pages/img.png
```

Each step below runs through a scratch file:

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

**Expected:** exit 0, 101 tests passed.

### 2. The guards fail when broken

A guard that has never been seen to fail is a claim, not a result. Break each
one and confirm the suite goes red:

```bash
# The overwrite guard
sed -i '' 's/if (overwrite) return;/if (true) return;/' src/preflight.ts
npx vitest run src/preflight.test.ts   # Expected: 1 failed
git checkout src/preflight.ts

# The "only close what we opened" guard
sed -i '' 's/if not wasOpen then close d saving no/close d saving no/g' src/scripts.ts
npx vitest run src/scripts.test.ts     # Expected: 1 failed
git checkout src/scripts.ts
```

**Expected:** each sabotage produces exactly one failure, and `git checkout`
returns the suite to green.

### 3. `status` does not launch Pages

```bash
pgrep -x Pages || echo "not running"
# call status
pgrep -x Pages || echo "still not running"
```

**Expected:** Pages is not running before or after. `status` reports
`installed: true`, `running: false`, and `automationAllowed: null` — null rather
than true because nothing has asked Pages anything yet.

### 4. A bad path fails fast instead of hanging

The motivating hazard: handed a path that does not exist, Pages puts up an alert
and blocks the Apple event for ~2 minutes.

```ts
const t0 = Date.now();
try { await call(t.readDocument, { path: "/tmp/qa-pages/nope.pages" }); }
catch (e) { console.log(Date.now() - t0, "ms:", (e as Error).message); }
```

**Expected:** rejects in **under 1 second** with "path does not exist", and
Pages is still not running. *If this takes ~30 seconds, the preflight has
regressed — that is the red state.*

### 5. Round trip, including text that would break a quoted script

```ts
const text = 'He said "hi" \\ back\nSecond paragraph.\nThird.';
await call(t.createDocument, { path: "/tmp/qa-pages/doc.pages", text, template: "Blank" });
const r = await call(t.readDocument, { path: "/tmp/qa-pages/doc.pages" });
console.log("identical:", r.text === text);
console.log(await call(t.inspectDocument, { path: "/tmp/qa-pages/doc.pages" }));
```

**Expected:** `identical: true`, and 3 paragraphs / 7 words / 1 page. The quote
and backslash surviving is the point — they cross as argv, never as script text.

### 6. Overwrite is refused unless asked for

```ts
try { await call(t.createDocument, { path: "/tmp/qa-pages/doc.pages", text: "x" }); }
catch (e) { console.log("refused:", (e as Error).message); }
await call(t.createDocument, { path: "/tmp/qa-pages/doc.pages", text: "x", overwrite: true });
```

**Expected:** the first refuses naming the path; the second succeeds.

### 7. Editing

```ts
await call(t.editDocument, { path: "/tmp/qa-pages/doc.pages", operations: [
  { kind: "set_text", text: "Title\nBody." },
  { kind: "style_paragraph", index: 1, font: "Helvetica-Bold", size: 28, color: [65535, 0, 0] },
  { kind: "add_table", rows: 3, columns: 2 },
  { kind: "set_cell", table: 1, row: 1, column: 1, value: "Header A" },
  { kind: "add_image", file: "/tmp/qa-pages/img.png", position: [80, 400], width: 150 },
  { kind: "page_break" },
  { kind: "append_text", text: "Second page." },
]});
console.log(await call(t.inspectDocument, { path: "/tmp/qa-pages/doc.pages" }));
console.log(await call(t.readTable, { path: "/tmp/qa-pages/doc.pages", table: 1 }));
```

**Expected:** 2 pages, 1 table, 1 image, 1 shape. `read_table` returns **three**
rows of **two** cells — `[["Header A", ""], ["", ""], ["", ""]]`. A short or
missing final row means the empty-cell handling has regressed; the words
"missing value" appearing as a cell value means the same.

### 8. Export

```ts
for (const format of ["pdf", "docx", "rtf"]) {
  await call(t.exportDocument, { source: "/tmp/qa-pages/doc.pages",
    destination: `/tmp/qa-pages/out/doc.${format}`, format, overwrite: true });
}
```

```bash
file /tmp/qa-pages/out/*   # Expected: a real PDF, a Word document, an RTF
```

### 9. Your open window is left alone — the step that needs a human

Open `/tmp/qa-pages/doc.pages` in Pages by hand and **type a word into it
without saving**. Then:

```ts
console.log(await call(t.listDocuments, {}));                       // shows it, modified: true
await call(t.readDocument, { path: "/tmp/qa-pages/doc.pages" });    // read it
await call(t.exportDocument, { source: "/tmp/qa-pages/doc.pages",
  destination: "/tmp/qa-pages/out/open.pdf", format: "pdf", overwrite: true });
try { await call(t.createDocument, { path: "/tmp/qa-pages/doc.pages", text: "x", overwrite: true }); }
catch (e) { console.log("refused:", (e as Error).message); }
```

**Expected:** `list_documents` reports it with `modified: true`. The read and the
export both succeed **and your window is still open with your typed word still
in it**. The create is refused, naming the document.

This is the step that cannot be automated, and the one that matters most: an
earlier version of this bag closed the user's window on every read and export.

### 10. A file Pages will not open

```bash
echo "not a pages file" > /tmp/qa-pages/broken.pages
```

```ts
try { await call(t.readDocument, { path: "/tmp/qa-pages/broken.pages" }); }
catch (e) { console.log((e as Error).message); }
```

**Expected:** an error within ~30 seconds saying Pages is showing an alert that
blocks automation. Pages really will be showing *"broken.pages can't be opened
right now"* — dismiss it, or quit Pages, before continuing. Nothing in this bag
can dismiss it, which is why the message says so rather than pretending it
recovered.

### 11. Cleanup

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
```

**Expected:** 10 tools listed. In a fresh session, `list_templates` and
`read_table` are **absent** from the tool list but reachable through tool
search; the other eight are present.
