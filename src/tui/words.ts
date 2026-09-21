/**
 * Word-wise motion, and the keys that ask for it.
 *
 * Alt-← and Alt-→ are what a terminal user reaches for to cross a word, but terminals spell them
 * in more than one way: some send a modified arrow, some translate Alt into an Esc prefix, and
 * some send the readline bindings `Alt-b` and `Alt-f` instead. All of them mean the same thing, so
 * all of them are accepted here — along with Ctrl-←/→, which is the other common spelling.
 */

import type { KeyEvent } from "./keys.js";

function altChar(event: KeyEvent, ...chars: readonly string[]): boolean {
  return (
    event.alt &&
    event.code.kind === "char" &&
    chars.includes(event.code.char.toLowerCase()) &&
    !event.ctrl
  );
}

/** Alt-←, Ctrl-←, or Alt-b: move to the start of the word before the cursor. */
export function isWordLeft(event: KeyEvent): boolean {
  if (event.code.kind === "left") return event.alt || event.ctrl;
  return altChar(event, "b");
}

/** Alt-→, Ctrl-→, or Alt-f: move past the end of the word after the cursor. */
export function isWordRight(event: KeyEvent): boolean {
  if (event.code.kind === "right") return event.alt || event.ctrl;
  return altChar(event, "f");
}

/** Alt-Backspace: delete the word before the cursor. */
export function isDeleteWordLeft(event: KeyEvent): boolean {
  return event.alt && event.code.kind === "backspace";
}

const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

/**
 * The index the cursor lands on moving left by a word: over any spaces, then over the word.
 *
 * `chars` is code points rather than a string, because that is what every caller already has —
 * an editor counts columns in characters, not UTF-16 units.
 */
export function wordLeft(chars: readonly string[], cursor: number): number {
  let i = Math.min(cursor, chars.length);
  while (i > 0 && isSpace(chars[i - 1])) i -= 1;
  while (i > 0 && !isSpace(chars[i - 1])) i -= 1;
  return i;
}

/** The index the cursor lands on moving right by a word: over any spaces, then over the word. */
export function wordRight(chars: readonly string[], cursor: number): number {
  let i = Math.max(0, cursor);
  while (i < chars.length && isSpace(chars[i])) i += 1;
  while (i < chars.length && !isSpace(chars[i])) i += 1;
  return i;
}
