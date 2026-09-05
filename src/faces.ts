/**
 * Turning "bold" into something Pages will accept.
 *
 * Pages exposes a paragraph's typeface as a single `font` string and offers no
 * boolean for bold or italic. Asking for bold means naming a different face:
 * `Times-Bold` rather than `Times-Roman`. So a caller who says `bold: true` has
 * to be translated into whatever that family calls its bold cut, and families
 * disagree — `Times-Bold`, `Helvetica-Bold`, `HelveticaNeue-Bold`,
 * `TimesNewRomanPS-BoldMT`.
 *
 * Getting this wrong is quiet: Pages rejects an unknown face by leaving the text
 * as it was, so a mistyped name reads as "the styling silently did nothing".
 * That is why the mapping is a table of families known to exist on macOS plus a
 * documented fallback, rather than string surgery on whatever it is handed.
 */

export interface FaceRequest {
  /** A face already in use, e.g. "Times-Roman" or "HelveticaNeue-Light". */
  current: string;
  bold?: boolean;
  italic?: boolean;
}

/**
 * The four cuts of the families this bag actually meets. Keys are the family
 * stem shared by every cut, so a face is matched by finding its stem.
 */
const FAMILIES: Record<string, { regular: string; bold: string; italic: string; boldItalic: string }> = {
  Times: {
    regular: "Times-Roman",
    bold: "Times-Bold",
    italic: "Times-Italic",
    boldItalic: "Times-BoldItalic",
  },
  TimesNewRomanPS: {
    regular: "TimesNewRomanPSMT",
    bold: "TimesNewRomanPS-BoldMT",
    italic: "TimesNewRomanPS-ItalicMT",
    boldItalic: "TimesNewRomanPS-BoldItalicMT",
  },
  Helvetica: {
    regular: "Helvetica",
    bold: "Helvetica-Bold",
    italic: "Helvetica-Oblique",
    boldItalic: "Helvetica-BoldOblique",
  },
  HelveticaNeue: {
    regular: "HelveticaNeue",
    bold: "HelveticaNeue-Bold",
    italic: "HelveticaNeue-Italic",
    boldItalic: "HelveticaNeue-BoldItalic",
  },
  ArialMT: {
    regular: "ArialMT",
    bold: "Arial-BoldMT",
    italic: "Arial-ItalicMT",
    boldItalic: "Arial-BoldItalicMT",
  },
};

/**
 * Longest stem first, so `HelveticaNeue-Bold` matches HelveticaNeue rather than
 * Helvetica. Sorted once at module load rather than per call.
 */
const STEMS = Object.keys(FAMILIES).sort((a, b) => b.length - a.length);

export interface FaceResolution {
  /** The face to set. Equals `current` when nothing could be improved on. */
  face: string;
  /**
   * True when the family was recognised and the requested cut exists. False
   * means the caller asked for something this family cannot express, and the
   * text will not look the way they asked.
   */
  exact: boolean;
  /** Set when `exact` is false, saying what could not be honoured. */
  note?: string;
}

/**
 * Resolve a face for the requested weight and slant.
 *
 * An unrecognised family is returned unchanged with `exact: false` rather than
 * guessed at. Appending "-Bold" to an unknown stem produces a face name that
 * usually does not exist, and Pages answers that by doing nothing at all — a
 * silent no-op is worse than an honest "this family is not in the table".
 */
export function resolveFace(request: FaceRequest): FaceResolution {
  const { current, bold = false, italic = false } = request;

  const stem = STEMS.find((candidate) => current.startsWith(candidate));
  if (!stem) {
    return {
      face: current,
      exact: false,
      note: `Unrecognised font family "${current}"; left unchanged rather than guessing a face name Pages may reject silently.`,
    };
  }

  const family = FAMILIES[stem];
  const wanted = bold && italic ? "boldItalic" : bold ? "bold" : italic ? "italic" : "regular";

  return { face: family[wanted], exact: true };
}

/** Whether a face is the bold cut of its family — used to verify a style landed. */
export function isBoldFace(face: string): boolean {
  const stem = STEMS.find((candidate) => face.startsWith(candidate));
  if (!stem) return /-(Bold|Black|Heavy)/i.test(face);
  const family = FAMILIES[stem];
  return face === family.bold || face === family.boldItalic;
}
