/**
 * Export formats, named the way a caller thinks of them.
 *
 * Pages' dictionary spells these as phrases like `Microsoft Word` and
 * `formatted text`. Callers think in file extensions, so the extension is the
 * vocabulary and the enumerator stays an implementation detail.
 */

import { z } from "zod";

export const EXPORT_FORMATS = {
  pdf: "PDF",
  docx: "Microsoft Word",
  rtf: "formatted text",
  epub: "EPUB",
  text: "unformatted text",
  pages09: "Pages 09",
} as const;

export type ExportFormat = keyof typeof EXPORT_FORMATS;

export const exportFormatSchema = z.enum(
  Object.keys(EXPORT_FORMATS) as [ExportFormat, ...ExportFormat[]],
);

export function toEnumerator(format: ExportFormat): string {
  return EXPORT_FORMATS[format];
}

/** The extension each format should be written with, for defaulting a path. */
export const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  pdf: ".pdf",
  docx: ".docx",
  rtf: ".rtf",
  epub: ".epub",
  text: ".txt",
  pages09: ".pages",
};
