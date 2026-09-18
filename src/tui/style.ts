/** Styled text: the spans and lines every pane is drawn from. */

/** The palette the REPL draws with — the sixteen-colour set every terminal has. */
export type Color =
  | "reset"
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "gray"
  | "darkGray"
  | "lightRed"
  | "lightGreen"
  | "lightYellow"
  | "lightBlue"
  | "lightMagenta"
  | "lightCyan"
  | "white";

export interface Style {
  fg?: Color;
  bold?: boolean;
  reverse?: boolean;
}

export interface Span {
  text: string;
  style: Style;
}

export interface Line {
  spans: Span[];
}

export const NO_STYLE: Style = {};

export function span(text: string, style: Style = NO_STYLE): Span {
  return { text, style };
}

export function line(spans: Span[] | string): Line {
  return typeof spans === "string" ? { spans: [span(spans)] } : { spans };
}

export function blankLine(): Line {
  return { spans: [] };
}

/** Put `base` underneath every span's own style, the way ratatui patches a line. */
export function patchStyle(l: Line, base: Style): Line {
  if (base.fg === undefined && base.bold === undefined && base.reverse === undefined) return l;
  return {
    spans: l.spans.map((s) => ({ text: s.text, style: { ...base, ...s.style } })),
  };
}

/** Width in columns; the REPL counts characters, as the Rust original does. */
export function spanWidth(s: Span): number {
  return [...s.text].length;
}

export function lineWidth(l: Line): number {
  let width = 0;
  for (const s of l.spans) width += spanWidth(s);
  return width;
}

/** The line's text with the styling dropped — what the transcript tests read. */
export function lineText(l: Line): string {
  return l.spans.map((s) => s.text).join("");
}

export function linesText(lines: readonly Line[]): string {
  return lines.map(lineText).join("\n");
}

const FG: Record<Color, number> = {
  reset: 39,
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 37,
  darkGray: 90,
  lightRed: 91,
  lightGreen: 92,
  lightYellow: 93,
  lightBlue: 94,
  lightMagenta: 95,
  lightCyan: 96,
  white: 97,
};

const ESC = "\u001b";

/** The SGR sequence for a style, or the reset sequence when it is the terminal default. */
export function sgr(style: Style): string {
  const codes: number[] = [0];
  if (style.bold) codes.push(1);
  if (style.reverse) codes.push(7);
  if (style.fg !== undefined && style.fg !== "reset") codes.push(FG[style.fg]);
  return `${ESC}[${codes.join(";")}m`;
}

export function sameStyle(a: Style, b: Style): boolean {
  return a.fg === b.fg && !!a.bold === !!b.bold && !!a.reverse === !!b.reverse;
}
