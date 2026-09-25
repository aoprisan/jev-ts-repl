/** A screen buffer: cells in, ANSI (or plain text, for tests) out. */

import type { Rect } from "./layout.js";
import type { Line, Span, Style } from "./style.js";
import { NO_STYLE, sameStyle, sgr } from "./style.js";

interface Cell {
  ch: string;
  style: Style;
}

/** The rounded borders the panes are drawn with. */
const ROUNDED = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
};

export interface BlockOptions {
  title?: Line;
  titleBottom?: Line;
  borderStyle?: Style;
}

export class ScreenBuffer {
  readonly width: number;
  readonly height: number;
  readonly #cells: Cell[];

  constructor(width: number, height: number) {
    this.width = Math.max(0, width);
    this.height = Math.max(0, height);
    this.#cells = new Array<Cell>(this.width * this.height);
    for (let i = 0; i < this.#cells.length; i += 1) this.#cells[i] = { ch: " ", style: NO_STYLE };
  }

  /** The whole buffer as a rectangle. */
  get area(): Rect {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  set(x: number, y: number, ch: string, style: Style = NO_STYLE): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.#cells[y * this.width + x] = { ch, style };
  }

  /** Blank a region — what ratatui's `Clear` widget does before a popup. */
  clear(area: Rect): void {
    for (let y = area.y; y < area.y + area.height; y += 1) {
      for (let x = area.x; x < area.x + area.width; x += 1) this.set(x, y, " ");
    }
  }

  setString(
    x: number,
    y: number,
    text: string,
    style: Style = NO_STYLE,
    maxWidth?: number,
  ): number {
    let column = x;
    const limit = maxWidth === undefined ? this.width : Math.min(this.width, x + maxWidth);
    for (const ch of text) {
      if (column >= limit) break;
      this.set(column, y, ch, style);
      column += 1;
    }
    return column - x;
  }

  setSpans(x: number, y: number, spans: readonly Span[], maxWidth?: number): void {
    let column = x;
    const limit = maxWidth === undefined ? this.width : Math.min(this.width, x + maxWidth);
    for (const s of spans) {
      if (column >= limit) break;
      column += this.setString(column, y, s.text, s.style, limit - column);
    }
  }

  /** Draw lines into `area`, clipped rather than wrapped — panes pre-wrap what needs wrapping. */
  paragraph(area: Rect, lines: readonly Line[]): void {
    for (let i = 0; i < lines.length && i < area.height; i += 1) {
      const l = lines[i];
      if (l) this.setSpans(area.x, area.y + i, l.spans, area.width);
    }
  }

  /** Draw a rounded border with optional titles; returns the area inside it. */
  block(area: Rect, options: BlockOptions = {}): Rect {
    const style = options.borderStyle ?? NO_STYLE;
    const { x, y, width, height } = area;
    if (width === 0 || height === 0) return { x, y, width: 0, height: 0 };
    if (width === 1 || height === 1) {
      for (let i = 0; i < width; i += 1) this.set(x + i, y, ROUNDED.horizontal, style);
      return { x, y, width: 0, height: 0 };
    }
    const right = x + width - 1;
    const bottom = y + height - 1;
    for (let i = x + 1; i < right; i += 1) {
      this.set(i, y, ROUNDED.horizontal, style);
      this.set(i, bottom, ROUNDED.horizontal, style);
    }
    for (let i = y + 1; i < bottom; i += 1) {
      this.set(x, i, ROUNDED.vertical, style);
      this.set(right, i, ROUNDED.vertical, style);
    }
    this.set(x, y, ROUNDED.topLeft, style);
    this.set(right, y, ROUNDED.topRight, style);
    this.set(x, bottom, ROUNDED.bottomLeft, style);
    this.set(right, bottom, ROUNDED.bottomRight, style);
    if (options.title) this.setSpans(x + 1, y, options.title.spans, width - 2);
    if (options.titleBottom) this.setSpans(x + 1, bottom, options.titleBottom.spans, width - 2);
    return { x: x + 1, y: y + 1, width: width - 2, height: height - 2 };
  }

  /** Draw a single vertical rule — the gutter between two panes. */
  verticalRule(x: number, y: number, height: number, style: Style = NO_STYLE): void {
    for (let i = 0; i < height; i += 1) this.set(x, y + i, ROUNDED.vertical, style);
  }

  /**
   * The buffer as ANSI, one escape only where the style actually changes.
   *
   * Every row is positioned absolutely rather than ended with a newline, so a full frame never
   * scrolls the screen and a half-written frame cannot drift.
   */
  toAnsi(): string {
    const out: string[] = [];
    let current: Style | undefined;
    for (let y = 0; y < this.height; y += 1) {
      out.push(`\u001b[${y + 1};1H`);
      for (let x = 0; x < this.width; x += 1) {
        const cell = this.#cells[y * this.width + x] ?? { ch: " ", style: NO_STYLE };
        if (current === undefined || !sameStyle(current, cell.style)) {
          out.push(sgr(cell.style));
          current = cell.style;
        }
        out.push(cell.ch);
      }
    }
    out.push(sgr(NO_STYLE));
    return out.join("");
  }

  /** The buffer as plain text, the way ratatui's test backend prints a screen. */
  toString(): string {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y += 1) {
      let row = "";
      for (let x = 0; x < this.width; x += 1) {
        row += this.#cells[y * this.width + x]?.ch ?? " ";
      }
      rows.push(row.replace(/\s+$/, ""));
    }
    return rows.join("\n");
  }
}
