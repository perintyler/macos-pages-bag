/**
 * Putting a document's own styling back after its text has been replaced.
 *
 * `set_shape_text` replaces a box wholesale, and every character comes out
 * wearing the style of the box's first character. On a resume whose first run is
 * a bold underlined heading, that turns the entire section bold — plain body
 * text, inline bold tech names and italics all gone in one operation.
 *
 * The fix is to record what each run looked like before the edit and re-apply it
 * after. Runs are matched by their text, not their position: an edit that adds or
 * removes a line shifts every position after it, so positional matching would
 * confidently style the wrong words. Text matching degrades honestly instead —
 * rewritten content simply does not match, and is reported rather than guessed at.
 *
 * This is best-effort by construction. What keeps that from being a silent
 * failure is that the result names how many runs were restored and how many were
 * not; a caller seeing `restored: 0` knows nothing happened.
 */

import { resolveFace } from "./faces.js";

/** A run's styling, captured before an edit. */
export interface CapturedRun {
  text: string;
  bold: boolean;
  italic: boolean;
  size?: number;
  font?: string;
}

/** Where a captured run's text was found in the new content. */
export interface StyleTarget {
  /** 1-based paragraph number in the new text. */
  paragraph: number;
  /** 1-based character offsets within that paragraph, inclusive. */
  from: number;
  to: number;
  face: string;
  size?: number;
  /** False when the family was not recognised and the face was left alone. */
  exact: boolean;
}

export interface MatchResult {
  targets: StyleTarget[];
  /** Captured runs whose text no longer appears; their styling is lost. */
  unmatched: CapturedRun[];
}

/**
 * Runs shorter than this are not worth matching. A run holding " " or "—"
 * occurs in dozens of places, so the first match would almost never be the
 * right one, and styling the wrong span is worse than leaving it plain.
 */
const MIN_MATCHABLE = 3;

/**
 * Work out where each captured run's styling should land in the new text.
 *
 * Matching walks each paragraph left to right and consumes what it matches, so
 * a phrase repeated within a paragraph maps to successive occurrences rather
 * than all collapsing onto the first.
 */
export function matchRuns(captured: CapturedRun[], newText: string): MatchResult {
  const paragraphs = newText.split("\n");
  // How far into each paragraph matching has already consumed.
  const consumed = new Array<number>(paragraphs.length).fill(0);

  const targets: StyleTarget[] = [];
  const unmatched: CapturedRun[] = [];

  for (const run of captured) {
    const needle = run.text.trim();

    // Nothing distinctive to look for. Not a failure worth reporting — an
    // unstyled space looks the same either way.
    if (needle.length < MIN_MATCHABLE) continue;

    let placed = false;

    for (let index = 0; index < paragraphs.length; index++) {
      const at = paragraphs[index].indexOf(needle, consumed[index]);
      if (at === -1) continue;

      const { face, exact } = resolveFace({
        current: run.font ?? "Times-Roman",
        bold: run.bold,
        italic: run.italic,
      });

      targets.push({
        paragraph: index + 1,
        // AppleScript character indices are 1-based and inclusive.
        from: at + 1,
        to: at + needle.length,
        face,
        ...(run.size === undefined ? {} : { size: run.size }),
        exact,
      });

      consumed[index] = at + needle.length;
      placed = true;
      break;
    }

    if (!placed) unmatched.push(run);
  }

  return { targets, unmatched };
}

/**
 * Drop targets that would restyle a whole paragraph to the same thing.
 *
 * A box's text arrives already wearing one style, so a run asking for exactly
 * that face and size changes nothing. Every target costs an AppleScript round
 * trip, and a paragraph can hold dozens — filtering the no-ops out is the
 * difference between a fast restore and a slow one.
 */
export function withoutRedundant(
  targets: StyleTarget[],
  baseFace: string,
  baseSize?: number,
): StyleTarget[] {
  return targets.filter((target) => target.face !== baseFace || target.size !== baseSize);
}
