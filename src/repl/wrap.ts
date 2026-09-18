/** Word wrapping that keeps span styles, so the transcript can be scrolled by exact line count. */

import type { Line, Span, Style } from "../tui/style.js";
import { blankLine, span } from "../tui/style.js";

/** Wrap one styled line to `width` columns. Continuation lines keep the original indentation. */
export function wrap(l: Line, width: number): Line[] {
  if (width <= 0) return [blankLine()];
  const first = l.spans[0];
  const leading = first ? [...first.text].length - [...first.text.trimStart()].length : 0;
  const indent = Math.min(leading, Math.floor(width / 2));

  const w = new Wrapper(width, indent);
  for (const s of l.spans) {
    let rest = s.text;
    while (rest.length > 0) {
      const at = rest.indexOf(" ");
      const end = at === -1 ? rest.length : at;
      if (end === 0) {
        w.space(s.style);
        rest = rest.slice(1);
      } else {
        w.word(rest.slice(0, end), s.style);
        rest = rest.slice(end);
      }
    }
  }
  return w.finish();
}

/** Wrap every line and return them in order — what the transcript pane actually draws. */
export function wrapAll(lines: readonly Line[], width: number): Line[] {
  return lines.flatMap((l) => wrap(l, width));
}

class Wrapper {
  readonly #lines: Line[] = [];
  #current: Span[] = [];
  #column = 0;

  constructor(
    private readonly width: number,
    private readonly indent: number,
  ) {}

  word(word: string, style: Style): void {
    const chars = [...word];
    const len = chars.length;
    if (this.#column + len > this.width && this.#column > this.indent) this.newline();
    if (len > this.width) {
      // A single word longer than the pane: hard-break it.
      let i = 0;
      while (i < len) {
        const room = Math.max(1, this.width - this.#column);
        const chunk = chars.slice(i, i + room).join("");
        i += room;
        this.#column += [...chunk].length;
        this.#current.push(span(chunk, style));
        if (i < len) this.newline();
      }
      return;
    }
    this.#current.push(span(word, style));
    this.#column += len;
  }

  space(style: Style): void {
    if (this.#column === 0 || this.#column >= this.width) {
      // Leading indentation is re-applied by `newline`; trailing spaces are dropped.
      if (this.#column === 0 && this.#current.length === 0 && this.#lines.length === 0) {
        this.#current.push(span(" ", style));
        this.#column += 1;
      }
      return;
    }
    this.#current.push(span(" ", style));
    this.#column += 1;
  }

  newline(): void {
    this.#lines.push({ spans: this.#current });
    this.#current = [];
    this.#column = 0;
    if (this.indent > 0) {
      this.#current.push(span(" ".repeat(this.indent)));
      this.#column = this.indent;
    }
  }

  finish(): Line[] {
    if (this.#current.length > 0 || this.#lines.length === 0) {
      this.#lines.push({ spans: this.#current });
    }
    return this.#lines;
  }
}
