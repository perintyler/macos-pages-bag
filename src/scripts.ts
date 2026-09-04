/**
 * The AppleScript this bag runs.
 *
 * Every script here is a plain constant. Nothing is interpolated into them —
 * not even a timeout — because "only safe values are interpolated" is a rule
 * that erodes. User data arrives through `on run argv` and is read with
 * `item N of argv`, so text containing quotes, backslashes or newlines is inert.
 * `scripts.test.ts` fails if a template placeholder ever appears in this file,
 * which is what keeps string building from creeping back in.
 *
 * The 20-second `with timeout` is Pages' own ceiling, well under its ~2 minute
 * default, so a wedge surfaces as a -1712 this bag can classify rather than a
 * hang the caller has to wait out. Export is the one script without it: a long
 * document takes real time to re-encode, and the process-level ceiling in
 * osascript.ts already bounds it.
 *
 * Records come back tab-delimited. Free-form text (a document's body, a table's
 * cells) is never joined with anything that could occur inside it — the body is
 * returned as a script's entire reply.
 *
 * Every `open` is followed by a `missing value` check. Handed a file it will not
 * accept — a damaged bundle, something that is not really a document — Pages
 * does not raise; it hands back `missing value` and lets the script carry on
 * until some later line fails with a message about types that says nothing
 * about the file. Checking at the point of failure is what makes the error name
 * the document.
 *
 * Every script that opens a document also asks `isAlreadyOpen` first and closes
 * only what it opened itself. `open` on a document already on screen hands back
 * that same window, so an unconditional `close ... saving no` shuts the document
 * the user was working in and throws away their unsaved edits — an export was
 * seen closing the user's window before this was added. The probe runs outside
 * the `tell` block because `POSIX path of` is not something Pages can answer
 * (-1700); AppleScript has to coerce the alias itself.
 */

/**
 * Whether Pages is installed and reachable, without launching it.
 *
 * `is running` is answered by the system rather than by Pages, so a closed
 * Pages stays closed. Reading `version` is the automation probe: that is the
 * call TCC refuses, which is what separates "denied" from "not installed" —
 * without it, both look identical and the check would be worthless.
 *
 * Returns: running <tab> version <tab> openDocuments
 */
export const STATUS_SCRIPT = `
on run argv
  set isRunning to (application "Pages" is running)
  if not isRunning then return "false" & tab & "" & tab & "0"
  with timeout of 20 seconds
    tell application "Pages"
      set v to version
      set n to count of documents
    end tell
  end timeout
  return "true" & tab & v & tab & (n as text)
end run
`;

/**
 * Documents currently open, one per line:
 *   index <tab> name <tab> modified <tab> posixPath
 *
 * Returns nothing when Pages is closed rather than launching it to find out.
 *
 * The path is resolved outside the `tell` block on purpose: inside it,
 * `POSIX path of (file of d)` is sent to Pages, which cannot coerce it and
 * fails with -1700. Resolving it here, where AppleScript itself handles the
 * alias, is what makes the path come back at all. An unsaved document has no
 * file and reports an empty path — the only case the `try` is there to absorb.
 */
export const LIST_DOCUMENTS_SCRIPT = `
on run argv
  if not (application "Pages" is running) then return ""
  set out to {}
  with timeout of 20 seconds
    tell application "Pages"
      set docCount to count of documents
    end tell
    repeat with i from 1 to docCount
      tell application "Pages"
        set docName to name of document i
        set wasModified to modified of document i
      end tell
      set p to ""
      try
        tell application "Pages" to set f to file of document i
        set p to POSIX path of (f as alias)
      end try
      set end of out to (i as text) & tab & docName & tab & (wasModified as text) & tab & p
    end repeat
  end timeout
  set AppleScript's text item delimiters to linefeed
  return out as text
end run
`;

/** Template names, one per line. */
export const LIST_TEMPLATES_SCRIPT = `
on run argv
  with timeout of 20 seconds
    tell application "Pages" to set t to name of every template
  end timeout
  set AppleScript's text item delimiters to linefeed
  return t as text
end run
`;

/**
 * Create a document and save it.
 *
 * argv: 1 path, 2 template, 3 body text
 *
 * Closing at the end is safe because this script created the document. A
 * document the user already had open is never closed by this bag.
 */
export const CREATE_DOCUMENT_SCRIPT = `
on run argv
  set targetPath to item 1 of argv
  set templateName to item 2 of argv
  set bodyContent to item 3 of argv
  with timeout of 20 seconds
    tell application "Pages"
      set d to make new document with properties {document template:template templateName}
      if bodyContent is not "" then set body text of d to bodyContent
      save d in file ((POSIX file targetPath) as text)
      set n to count of paragraphs of body text of d
      close d saving no
    end tell
  end timeout
  return n as text
end run
`;

/**
 * A document's body text and nothing else, so the reply cannot collide with a
 * delimiter no matter what the document contains.
 *
 * argv: 1 path
 */
export const READ_TEXT_SCRIPT = `
on run argv
  set sourcePath to item 1 of argv
  with timeout of 20 seconds
    set wasOpen to my isAlreadyOpen(sourcePath)
    tell application "Pages"
      set d to open (POSIX file sourcePath)
      if d is missing value then error "Pages could not open the document: " & sourcePath
      set t to body text of d as text
      if not wasOpen then close d saving no
    end tell
  end timeout
  return t
end run

on isAlreadyOpen(targetPath)
  tell application "Pages" to set n to count of documents
  repeat with i from 1 to n
    try
      tell application "Pages" to set f to file of document i
      if (POSIX path of (f as alias)) is targetPath then return true
    end try
  end repeat
  return false
end isAlreadyOpen

`;

/**
 * Structure counts for a document, without its text.
 *
 * argv: 1 path
 * Returns: paragraphs <tab> words <tab> characters <tab> pages <tab> sections
 *          <tab> tables <tab> images <tab> shapes
 *
 * Note `shapes` counts text items too — Pages models a text box as a shape.
 */
export const INSPECT_SCRIPT = `
on run argv
  set sourcePath to item 1 of argv
  with timeout of 20 seconds
    set wasOpen to my isAlreadyOpen(sourcePath)
    tell application "Pages"
      set d to open (POSIX file sourcePath)
      if d is missing value then error "Pages could not open the document: " & sourcePath
      set bt to body text of d
      set res to (count of paragraphs of bt) as text
      set res to res & tab & ((count of words of bt) as text)
      set res to res & tab & ((count of characters of bt) as text)
      set res to res & tab & ((count of pages of d) as text)
      set res to res & tab & ((count of sections of d) as text)
      set res to res & tab & ((count of tables of d) as text)
      set res to res & tab & ((count of images of d) as text)
      set res to res & tab & ((count of shapes of d) as text)
      if not wasOpen then close d saving no
    end tell
  end timeout
  return res
end run

on isAlreadyOpen(targetPath)
  tell application "Pages" to set n to count of documents
  repeat with i from 1 to n
    try
      tell application "Pages" to set f to file of document i
      if (POSIX path of (f as alias)) is targetPath then return true
    end try
  end repeat
  return false
end isAlreadyOpen

`;

/**
 * A table's cells. The first line is the column count; each line after it is
 * one row, led by its row number: rowNumber <tab> cell <tab> cell ...
 *
 * argv: 1 path, 2 table index
 *
 * Three details keep an empty table readable, because trailing empty strings
 * disappear at every join and trim between here and the caller:
 *
 * - An empty cell reads as AppleScript's `missing value`, which coerces to the
 *   literal text "missing value" — indistinguishable from a cell somebody typed
 *   that into. It is tested for before coercing.
 * - Each row line leads with its row number, so a row of empty cells is still a
 *   non-empty line and survives the trim.
 * - The column count comes first so the caller can pad each row back to full
 *   width. Without it, a trailing run of empty cells is simply missing, and a
 *   3x2 table reads back with a short final row.
 */
export const READ_TABLE_SCRIPT = `
on run argv
  set sourcePath to item 1 of argv
  set tableIndex to (item 2 of argv) as integer
  set out to {}
  with timeout of 20 seconds
    set wasOpen to my isAlreadyOpen(sourcePath)
    tell application "Pages"
      set d to open (POSIX file sourcePath)
      if d is missing value then error "Pages could not open the document: " & sourcePath
      set t to table tableIndex of d
      set colCount to column count of t
      set end of out to colCount as text
      repeat with r from 1 to row count of t
        set rowCells to {r as text}
        repeat with c from 1 to colCount
          set v to ""
          try
            set raw to value of cell c of row r of t
            if raw is not missing value then set v to raw as text
          end try
          set end of rowCells to v
        end repeat
        set AppleScript's text item delimiters to tab
        set end of out to rowCells as text
      end repeat
      if not wasOpen then close d saving no
    end tell
  end timeout
  set AppleScript's text item delimiters to linefeed
  return out as text
end run

on isAlreadyOpen(targetPath)
  tell application "Pages" to set n to count of documents
  repeat with i from 1 to n
    try
      tell application "Pages" to set f to file of document i
      if (POSIX path of (f as alias)) is targetPath then return true
    end try
  end repeat
  return false
end isAlreadyOpen

`;

/**
 * Apply a list of edits to a document in one pass.
 *
 * argv: 1 path, then operations flattened by `encodeOperations`, each starting
 * with its kind and followed by the fields that kind declares. The cursor
 * advances by the field count per kind, so the two must agree — operations.ts
 * owns that contract and operations.test.ts pins it.
 *
 * Three things here were found the hard way and should not be "simplified":
 *
 * - Paragraph styling sets properties through the full reference
 *   (`font of paragraph N of body text of d`). Assigning the paragraph to a
 *   variable first copies its text value, and setting a property on that copy
 *   fails with -10006.
 * - Colour parsing happens in a handler, outside the `tell` block. Inside it,
 *   `text items of` is sent to Pages, which cannot answer it (-1728).
 * - Tables, images and text items are made on a `page`, not on the document —
 *   making them on the document fails with -2763.
 *
 * An unrecognised operation raises rather than being skipped, so a typo cannot
 * report success having done nothing.
 */
export const EDIT_DOCUMENT_SCRIPT = `
on run argv
  set targetPath to item 1 of argv
  set argc to count of argv
  set i to 2
  with timeout of 20 seconds
    set wasOpen to my isAlreadyOpen(targetPath)
    tell application "Pages"
      set d to open (POSIX file targetPath)
      if d is missing value then error "Pages could not open the document: " & targetPath
      repeat while i <= argc
        set op to item i of argv
        if op is "set_text" then
          set body text of d to (item (i + 1) of argv)
          set i to i + 2
        else if op is "append_text" then
          set body text of d to ((body text of d as text) & (item (i + 1) of argv))
          set i to i + 2
        else if op is "page_break" then
          set body text of d to ((body text of d as text) & (ASCII character 12))
          set i to i + 1
        else if op is "style_paragraph" then
          set pIdx to (item (i + 1) of argv) as integer
          set fName to item (i + 2) of argv
          set fSize to item (i + 3) of argv
          set fColor to item (i + 4) of argv
          if fName is not "" then set font of paragraph pIdx of body text of d to fName
          if fSize is not "" then set size of paragraph pIdx of body text of d to (fSize as real)
          if fColor is not "" then
            set color of paragraph pIdx of body text of d to my parseColor(fColor)
          end if
          set i to i + 5
        else if op is "add_table" then
          set rCount to (item (i + 1) of argv) as integer
          set cCount to (item (i + 2) of argv) as integer
          set pNum to (item (i + 3) of argv) as integer
          tell page pNum of d
            make new table with properties {row count:rCount, column count:cCount}
          end tell
          set i to i + 4
        else if op is "set_cell" then
          set tIdx to (item (i + 1) of argv) as integer
          set rIdx to (item (i + 2) of argv) as integer
          set cIdx to (item (i + 3) of argv) as integer
          set value of cell cIdx of row rIdx of table tIdx of d to (item (i + 4) of argv)
          set i to i + 5
        else if op is "add_image" then
          set imgPath to item (i + 1) of argv
          set px to item (i + 2) of argv
          set py to item (i + 3) of argv
          set iw to item (i + 4) of argv
          set pNum to (item (i + 5) of argv) as integer
          tell page pNum of d
            set im to make new image with properties {file:(POSIX file imgPath)}
          end tell
          if px is not "" and py is not "" then set position of im to {px as integer, py as integer}
          if iw is not "" then set width of im to (iw as integer)
          set i to i + 6
        else if op is "add_text_item" then
          set txt to item (i + 1) of argv
          set px to item (i + 2) of argv
          set py to item (i + 3) of argv
          set pNum to (item (i + 4) of argv) as integer
          tell page pNum of d
            set ti to make new text item with properties {object text:txt}
          end tell
          if px is not "" and py is not "" then set position of ti to {px as integer, py as integer}
          set i to i + 5
        else
          if not wasOpen then close d saving no
          error "Unknown operation: " & op
        end if
      end repeat
      save d
      set n to count of paragraphs of body text of d
      if not wasOpen then close d saving no
    end tell
  end timeout
  return n as text
end run

on parseColor(spec)
  set AppleScript's text item delimiters to ","
  set parts to text items of spec
  set AppleScript's text item delimiters to ""
  return {(item 1 of parts) as integer, (item 2 of parts) as integer, (item 3 of parts) as integer}
end parseColor
on isAlreadyOpen(targetPath)
  tell application "Pages" to set n to count of documents
  repeat with i from 1 to n
    try
      tell application "Pages" to set f to file of document i
      if (POSIX path of (f as alias)) is targetPath then return true
    end try
  end repeat
  return false
end isAlreadyOpen

`;

/**
 * Export a document to another format.
 *
 * argv: 1 source, 2 destination, 3 format enumerator
 *
 * The format is a dictionary keyword, not a string, so it cannot be passed as a
 * variable — hence the ladder. `run script` would collapse this into one line
 * and is exactly the string building this file exists to avoid. An unrecognised
 * format raises rather than falling through to a no-op that reports success.
 */
export const EXPORT_SCRIPT = `
on run argv
  set sourcePath to item 1 of argv
  set destPath to item 2 of argv
  set fmt to item 3 of argv
  set wasOpen to my isAlreadyOpen(sourcePath)
  tell application "Pages"
    set d to open (POSIX file sourcePath)
    if d is missing value then error "Pages could not open the document: " & sourcePath
    if fmt is "PDF" then
      export d to file ((POSIX file destPath) as text) as PDF
    else if fmt is "Microsoft Word" then
      export d to file ((POSIX file destPath) as text) as Microsoft Word
    else if fmt is "formatted text" then
      export d to file ((POSIX file destPath) as text) as formatted text
    else if fmt is "EPUB" then
      export d to file ((POSIX file destPath) as text) as EPUB
    else if fmt is "unformatted text" then
      export d to file ((POSIX file destPath) as text) as unformatted text
    else if fmt is "Pages 09" then
      export d to file ((POSIX file destPath) as text) as Pages 09
    else
      if not wasOpen then close d saving no
      error "Unknown export format: " & fmt
    end if
    if not wasOpen then close d saving no
  end tell
  return "ok"
end run

on isAlreadyOpen(targetPath)
  tell application "Pages" to set n to count of documents
  repeat with i from 1 to n
    try
      tell application "Pages" to set f to file of document i
      if (POSIX path of (f as alias)) is targetPath then return true
    end try
  end repeat
  return false
end isAlreadyOpen

`;
