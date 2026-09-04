# macos-pages

Apple Pages, driven from Barry: author documents, read and edit existing ones,
and export to PDF, Word, RTF, EPUB or plain text.

Everything goes through Pages' AppleScript object model. Nothing in this bag
drives the interface — no synthetic clicks, no keystrokes, no System Events.

## Requirements

macOS with Pages installed, and permission for the node running Barry to control
it. **Automation grants attach to a specific binary**, so a working `osascript`
in your own terminal says nothing about whether this bag is allowed; the first
denial appears as error 1743 and is fixed in System Settings → Privacy &
Security → Automation.

`status` distinguishes the three states — not installed, installed but denied,
and working — so start there when something looks wrong.

## Tools

| tool | what it does |
|---|---|
| `status` | Whether Pages is installed, running and controllable. Never launches it. |
| `create_document` | New document from plain text, saved to a path. |
| `read_document` | The body text of a document. |
| `inspect_document` | Counts: paragraphs, words, characters, pages, sections, tables, images, shapes. |
| `edit_document` | Apply an ordered list of edits in one pass — see below. |
| `export_document` | Export to `pdf`, `docx`, `rtf`, `epub`, `text` or `pages09`. |
| `convert_documents` | Export every `.pages` file in a directory. |
| `list_documents` | What is open in Pages right now, and whether it has unsaved changes. |
| `list_templates` | Template names for `create_document`. Deferred — find it with tool search. |
| `read_table` | The cells of one table. Deferred. |

### Editing

`edit_document` takes an ordered list of operations, applied in one visit to the
document:

```json
{
  "path": "/Users/me/report.pages",
  "operations": [
    { "kind": "style_paragraph", "index": 1, "font": "Helvetica-Bold", "size": 28, "color": [65535, 0, 0] },
    { "kind": "add_table", "rows": 3, "columns": 2 },
    { "kind": "set_cell", "table": 1, "row": 1, "column": 1, "value": "Header" },
    { "kind": "add_image", "file": "/Users/me/chart.png", "position": [80, 400], "width": 150 },
    { "kind": "page_break" },
    { "kind": "append_text", "text": "On the next page." }
  ]
}
```

Also available: `set_text`, `add_text_item`.

Colours are `[r, g, b]` on Pages' 0–65535 scale, not 0–255. Positions are in
points from the top-left of the page.

## What it will not do

- **Close or quit anything.** There is no such tool, and no script closes a
  document it did not open. If you ask it to write to a document you have open,
  it refuses and names the document rather than overwriting your unsaved work.
- **Markdown.** `create_document` takes plain text. Pages' scripting surface
  cannot express headings or lists on inserted text, so a markdown converter
  here would produce something that looked right and was not. Use
  `edit_document` for formatting, or the `md_to_pdf` bag for styled markdown.
- **Templates faithfully.** Setting body text replaces a template's own content,
  so most of its design is lost. `Blank` is the default; anything else is
  best-effort.

## Notes from the dictionary

Behaviour verified against Pages 14.1. A few things are surprising enough to be
worth knowing:

- A text box counts as a shape, so `inspect_document` reports it under `shapes`.
- Pages converts numeric-looking cell values, so `set_cell` with `"42"` reads
  back as `42`.
- Handed a file it will not open, Pages puts up an alert that blocks automation
  until somebody dismisses it. This bag checks paths before Pages sees them,
  which is what keeps that from happening; if it does happen, the error says so.

## Installing

```bash
git clone git@github.com:perintyler/macos-pages-bag.git ~/repos/bags/macos-pages
barry install ~/repos/bags/macos-pages --as macos-pages
barry pack macos-pages
```

`package.json` depends on `@barry/tools` through a relative `link:`, which
assumes [barry](https://github.com/perintyler/barry) is checked out alongside
this bag — `../../barry/packages/tools` from here. Clone it somewhere else and
point that specifier at wherever your checkout actually is.

## Development

```bash
pnpm install
pnpm test          # unit tests, no Pages required
npx tsc --noEmit
```

`QA.md` covers what only a live Pages can show.
