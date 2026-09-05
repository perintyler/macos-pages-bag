# macos-pages

Apple Pages, driven from Barry: author documents, read and edit existing ones,
see what they actually look like, and export to PDF, Word, RTF, EPUB or plain
text.

Everything goes through Pages' AppleScript object model or macOS' own rendering.
Nothing in this bag drives the interface — no synthetic clicks, no keystrokes, no
System Events.

## Requirements

macOS with Pages installed, and permission for the node running Barry to control
it. **Automation grants attach to a specific binary**, so a working `osascript`
in your own terminal says nothing about whether this bag is allowed; the first
denial appears as error 1743 and is fixed in System Settings → Privacy &
Security → Automation.

`status` distinguishes not-installed from denied from working, so start there
when something looks wrong.

## Tools

**Reading**

| tool | what it does |
|---|---|
| `status` | Whether Pages is installed, running and controllable. Never launches it. |
| `read_document` | A document's text — body plus every text box, including boxes inside groups. Pass `shape`/`group` to read one box. |
| `read_formatted` | Text *with* its styling: bold, italic, size, font, list nesting, per run. |
| `inspect_document` | Counts: paragraphs, words, characters, pages, sections, tables, images, shapes, groups. |
| `render_document` | An image of the first page. Works without launching Pages, and on copies Pages refuses to open. |
| `check_fit` | Whether the text actually fits, by comparing what the document holds against what its PDF renders. Names the lines that were clipped. |
| `list_documents` | What is open in Pages right now, and whether it has unsaved changes. |
| `list_templates` | Template names for `create_document`. Deferred. |
| `read_table` | The cells of one table. Deferred. |
| `diff_documents` | Compare a document against another, or against supplied text. Deferred. |

**Writing**

| tool | what it does |
|---|---|
| `create_document` | New document from plain text, saved to a path. |
| `edit_document` | Apply an ordered list of edits in one pass. Supports `preview`. |
| `restore_styling` | Put formatting back after replacing a box's text. |
| `export_document` | Export to `pdf`, `docx`, `rtf`, `epub`, `text` or `pages09`. |
| `convert_documents` | Export every `.pages` file in a directory. |
| `unblock_document` | Clear the quarantine flag on a downloaded file. Deferred. |

## Editing a styled document

Worth reading before you touch a resume, a flyer, or anything else with real
formatting.

`set_shape_text` replaces a text box's contents, and **every character inherits
the style of the box's first character**. If that first character is a bold
heading, the whole box comes out bold. Pages offers no way to set text and
styling together.

So the sequence is capture, replace, restore:

```jsonc
// 1. capture what the box looks like
read_formatted { path, includeRuns: true }

// 2. replace the text
edit_document { path, operations: [{ kind: "set_shape_text", shape: 1, group: 2, text }] }

// 3. put the styling back
restore_styling { path, shape: 1, group: 2, runs, baseFace: "Times-Roman", baseSize: 12 }
```

`restore_styling` sets the whole box to `baseFace`/`baseSize` first, then applies
each captured run on top. That order matters: styling only the runs that still
match leaves every rewritten line wearing the heading's bold.

It is **best-effort**, and says so. Runs are matched by their text, so anything
you rewrote has no styling to come back to — the result reports `restored` and
`unmatched` counts, and a low `restored` means most of the box is now plain body
text. Check the render.

### Try before you commit

```jsonc
edit_document { path, operations: [...], preview: true }
```

Applies the edits, renders the page, rolls the text back, and returns the image
path. Nothing is saved. Use it to answer "does this still fit" without touching
the document.

## What it will not do

- **Close or quit anything.** There is no such tool, and no script closes a
  document it did not open. Asked to write to a document you have open, it
  refuses and names it rather than overwriting your unsaved work.
- **Nested bullets.** Pages exposes no list-level vocabulary to AppleScript at
  all — no `list style`, no `indent level`. Replacing a box's text flattens two
  levels of bullets into one, and nothing can put them back. `edit_document`
  warns when it is about to do this.
- **Markdown.** `create_document` takes plain text. Use `edit_document` for
  formatting, or the `md_to_pdf` bag for styled markdown.
- **Templates faithfully.** Setting body text replaces a template's own content,
  so most of its design is lost. `Blank` is the default; anything else is
  best-effort.

## Things that will surprise you

Verified against Pages 14.1.

- **A sandbox grant is per file, and per file *identity*.** macOS lets Pages open
  a document a person opened, and that grant does not survive copying — a copy of
  a working document fails with "Operation not permitted". Overwriting a granted
  file's bytes revokes it too. `render_document` sidesteps this via QuickLook;
  everything else inherits it.
- **A quarantined download cannot be opened under automation.** Pages puts up a
  modal alert naming no cause. `unblock_document` clears it.
- **`count of pages` does not detect overflow.** A box can overflow and silently
  drop its last lines while the document still reports one page. That is what
  `check_fit` is for.
- **`read_formatted` is a hint, not the authority.** Pages' DOCX exporter marks
  body text underlined when it plainly renders without an underline. It is
  reliable about headings and inline bold. When it matters, look at
  `render_document`.
- **A text box counts as a shape**, so `inspect_document` reports it under
  `shapes`.
- **Pages converts numeric-looking cell values**, so `set_cell` with `"42"` reads
  back as `42`.

## Installing

```bash
git clone git@github.com:perintyler/macos-pages-bag.git ~/repos/bags/macos-pages
barry install ~/repos/bags/macos-pages --as macos-pages
barry pack macos-pages
```

`package.json` depends on `@barry-rocks/tools` through a relative `link:`, which
assumes [barry](https://github.com/perintyler/barry) is checked out alongside
this bag — `../../barry/packages/tools` from here.

## Development

```bash
pnpm install
pnpm test          # unit tests, no Pages required
npx tsc --noEmit
```

`QA.md` covers what only a live Pages can show.
