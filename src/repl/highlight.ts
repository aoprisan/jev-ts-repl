/**
 * Small hand-rolled highlighters for the three languages this REPL shows: the JSON going over the
 * wire, the TypeScript it generates, and the command line you are typing.
 */

import type { Color, Line, Span } from "../tui/style.js";
import { line, span } from "../tui/style.js";

const KEY: Color = "cyan";
const STRING: Color = "green";
const NUMBER: Color = "yellow";
const LITERAL: Color = "magenta";
const PUNCT: Color = "darkGray";
const KEYWORD: Color = "magenta";
const TYPE: Color = "cyan";
const COMMENT: Color = "darkGray";

function colored(text: string, color: Color): Span {
  return span(text, { fg: color });
}

const isAlphabetic = (c: string): boolean => /\p{L}/u.test(c);
const isAlphanumeric = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/** Highlight pretty-printed JSON, indented into the transcript. */
export function json(text: string): Line[] {
  return text.split("\n").map((l) => line([span("  "), ...jsonSpans(l)]));
}

/** One line of JSON. Keys are told from strings by the colon that follows them. */
export function jsonSpans(text: string): Span[] {
  const chars = [...text];
  const spans: Span[] = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i] as string;
    if (c === '"') {
      const [literal, next] = readString(chars, i);
      const after = chars.slice(next).find((ch) => ch.trim() !== "");
      spans.push(colored(literal, after === ":" ? KEY : STRING));
      i = next;
    } else if (c === "-" || isDigit(c)) {
      const start = i;
      while (
        i < chars.length &&
        (isDigit(chars[i] as string) || "-+.eE".includes(chars[i] as string))
      ) {
        i += 1;
      }
      spans.push(colored(chars.slice(start, i).join(""), NUMBER));
    } else if (isAlphabetic(c)) {
      const start = i;
      while (i < chars.length && isAlphabetic(chars[i] as string)) i += 1;
      const word = chars.slice(start, i).join("");
      spans.push(
        word === "true" || word === "false" || word === "null"
          ? colored(word, LITERAL)
          : colored(word, "reset"),
      );
    } else if ("{}[]:,".includes(c)) {
      spans.push(colored(c, PUNCT));
      i += 1;
    } else {
      const start = i;
      while (i < chars.length && (chars[i] as string).trim() === "") i += 1;
      if (i === start) i += 1;
      spans.push(span(chars.slice(start, i).join("")));
    }
  }
  return spans;
}

const TS_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "const",
  "else",
  "export",
  "false",
  "for",
  "from",
  "function",
  "if",
  "import",
  "let",
  "new",
  "of",
  "return",
  "true",
  "type",
  "void",
  "while",
]);

const RUST_KEYWORDS = new Set([
  "async",
  "await",
  "else",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "match",
  "mut",
  "pub",
  "return",
  "struct",
  "use",
  "while",
  "true",
  "false",
]);

/** Highlight generated TypeScript, indented into the transcript. */
export function typescript(text: string): Line[] {
  return text.split("\n").map((l) => line([span("  "), ...codeSpans(l, TS_KEYWORDS)]));
}

/** Highlight generated Rust, indented into the transcript. */
export function rust(text: string): Line[] {
  return text.split("\n").map((l) => line([span("  "), ...codeSpans(l, RUST_KEYWORDS)]));
}

function codeSpans(text: string, keywords: ReadonlySet<string>): Span[] {
  const chars = [...text];
  const spans: Span[] = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i] as string;
    if (c === "/" && chars[i + 1] === "/") {
      spans.push(colored(chars.slice(i).join(""), COMMENT));
      break;
    }
    if (c === '"' || c === "`") {
      const [literal, next] = readString(chars, i, c);
      spans.push(colored(literal, STRING));
      i = next;
    } else if (isDigit(c)) {
      const start = i;
      while (i < chars.length && (isAlphanumeric(chars[i] as string) || chars[i] === ".")) i += 1;
      spans.push(colored(chars.slice(start, i).join(""), NUMBER));
    } else if (isAlphabetic(c) || c === "_") {
      const start = i;
      while (i < chars.length && (isAlphanumeric(chars[i] as string) || chars[i] === "_")) i += 1;
      const word = chars.slice(start, i).join("");
      const macroCall = chars[i] === "!";
      if (macroCall) i += 1;
      const color = macroCall
        ? "lightBlue"
        : keywords.has(word)
          ? KEYWORD
          : /^\p{Lu}/u.test(word)
            ? TYPE
            : "reset";
      spans.push(colored(macroCall ? `${word}!` : word, color as Color));
    } else if ("(){}[];,.:?&<>=".includes(c)) {
      spans.push(colored(c, PUNCT));
      i += 1;
    } else {
      spans.push(span(c));
      i += 1;
    }
  }
  return spans;
}

/**
 * Highlight the input line: the command, the question name, the `|` separators, and the
 * `label=description` / `yes:` criteria inside them.
 */
export function command(input: string, known: (cmd: string) => boolean): Span[] {
  if (input.length === 0) return [];
  if (!input.startsWith(":")) {
    // Bare text becomes the state.
    return [span(input)];
  }
  const at = input.search(/\s/);
  const cmd = at === -1 ? input : input.slice(0, at);
  const rest = at === -1 ? undefined : input.slice(at + 1);
  const spans: Span[] = [span(cmd, known(cmd) ? { fg: "lightBlue", bold: true } : { fg: "red" })];
  if (rest === undefined) return spans;
  spans.push(span(" "));

  const takesName = [":noul", ":choice", ":score", ":raw", ":rm", ":drop"].includes(cmd);
  let body = rest;
  if (takesName) {
    const split = rest.search(/\s/);
    if (split === -1) {
      spans.push(span(rest, { bold: true }));
      return spans;
    }
    spans.push(span(rest.slice(0, split), { bold: true }));
    spans.push(span(" "));
    body = rest.slice(split + 1);
  }

  body.split("|").forEach((part, i) => {
    if (i > 0) spans.push(colored("|", PUNCT));
    const trimmed = part.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      spans.push(...jsonSpans(part));
      return;
    }
    const eq = part.indexOf("=");
    if (eq >= 0 && i > 0) {
      spans.push(colored(part.slice(0, eq), LITERAL));
      spans.push(colored("=", PUNCT));
      spans.push(span(part.slice(eq + 1)));
      return;
    }
    const colon = part.indexOf(":");
    if (colon >= 0 && ["yes", "no", "true", "false"].includes(part.slice(0, colon).trim())) {
      spans.push(colored(part.slice(0, colon), KEY));
      spans.push(colored(":", PUNCT));
      spans.push(span(part.slice(colon + 1)));
      return;
    }
    spans.push(span(part));
  });
  return spans;
}

function readString(chars: string[], start: number, quote = '"'): [string, number] {
  let i = start + 1;
  while (i < chars.length) {
    const c = chars[i];
    if (c === "\\") {
      i += 2;
    } else if (c === quote) {
      i += 1;
      break;
    } else {
      i += 1;
    }
  }
  const end = Math.min(i, chars.length);
  return [chars.slice(start, end).join(""), end];
}
