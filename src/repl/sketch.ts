/**
 * Sketch notation: the whole request written as one page of plain text, the way you would scribble
 * a rubric on paper. The shape of each question is read off its punctuation, so there is nothing to
 * select — you write what you mean and the gutter tells you what it became.
 *
 * ```text
 * The payout failed again, third time this month. I'm done waiting.
 * ---
 * is_urgent? The message conveys urgency or time-sensitivity
 *   yes: A deadline, a threat to leave, or "ASAP"
 *   no: Routine, no time pressure
 *
 * department: Which team should handle this
 *   billing = Payment or subscription issues
 *   technical = Bugs or integration problems
 *   sales
 *
 * frustration: How frustrated the customer appears
 *   Calm < Frustrated but civil < Very angry
 * ```
 *
 * - Everything above the first `---` line is the state (JSON if it parses as JSON).
 * - `name? instructions` is a yes/no question (noul); `yes:` / `no:` lines describe the outcomes.
 * - `name: instructions` followed by `label = description` lines (or bare labels) is a choice.
 * - `name: instructions` followed by levels joined with `<` is a score, lowest first.
 * - `name! {json}` sends a hand-built question object.
 * - The parts of a question can also go on its first line, separated by `|`.
 * - `@model jev-2` pins the model; `#` starts a comment. Indentation is only for reading.
 * - `@threshold 0.6` under a noul, or `@confidence 0.7` under a choice or a score, writes down the
 *   bar its answer is acted on at. It stays on the page and is never sent.
 */

import type { Json } from "../json.js";
import { compact, pretty, tryParse } from "../json.js";
import type { ChoiceOption, Question } from "../typesafe/questions.js";
import {
  choice as makeChoice,
  noul as makeNoul,
  questionToJson,
  raw as makeRaw,
  score as makeScore,
} from "../typesafe/questions.js";
import type { Color, Line, Style } from "../tui/style.js";
import { line, span } from "../tui/style.js";
import { ACCENT, CHOICE, DIM, NOUL, SCORE, WARN } from "./format.js";
import type { Entry } from "./session.js";
import { Session } from "./session.js";

/** What one line of a sketch turned out to be; shown in the editor gutter. */
export type Tag =
  | "blank"
  | "state"
  | "rule"
  | "comment"
  | "model"
  | "noul"
  | "choice"
  | "score"
  | "raw"
  | "yes"
  | "no"
  | "option"
  | "level"
  | "json"
  /** `@threshold` or `@confidence`: the bar the question above is acted on at. */
  | "bar"
  /** A line that could not be placed; it always carries a problem. */
  | "stray";

const LABELS: Record<Tag, string> = {
  blank: "",
  rule: "",
  state: "state",
  comment: "#",
  model: "model",
  noul: "noul",
  choice: "choice",
  score: "score",
  raw: "raw",
  yes: "yes",
  no: "no",
  option: "option",
  level: "level",
  json: "json",
  bar: "bar",
  stray: "?",
};

export function tagLabel(tag: Tag): string {
  return LABELS[tag];
}

export function tagColor(tag: Tag): Color {
  switch (tag) {
    case "noul":
    case "yes":
    case "no":
      return NOUL;
    case "choice":
    case "option":
      return CHOICE;
    case "score":
    case "level":
      return SCORE;
    case "raw":
    case "json":
      return WARN;
    case "bar":
      return ACCENT;
    case "stray":
      return "red";
    default:
      return DIM;
  }
}

/** Body lines carry their question's colour; heads are bold. */
export function isHead(tag: Tag): boolean {
  return tag === "noul" || tag === "choice" || tag === "score" || tag === "raw";
}

export interface Problem {
  /** Zero-based line. */
  readonly line: number;
  readonly message: string;
}

/** Where a question sits on the page, so a bar can be written back without redrawing the page. */
export interface BlockSpan {
  /** Zero-based line of the question's head. */
  readonly head: number;
  /** Zero-based line of the last line that belongs to it: a part, a criterion, its bar. */
  readonly last: number;
  /** Zero-based line of its `@threshold` or `@confidence`, when it has one. */
  readonly bar: number | undefined;
}

/**
 * A parsed sketch. Questions with problems are left out of `questions` but keep their tags, so the
 * page still reads sensibly while it is being fixed.
 */
export class ParsedSketch {
  state: Json = "";
  model: string | undefined;
  questions: Entry[] = [];
  /** Each question's bar, from its `@threshold` or `@confidence` line. */
  bars: Map<string, number> = new Map();
  /** Every question that parsed, by name: where it is on the page. */
  blocks: Map<string, BlockSpan> = new Map();
  /** One per line of the input. */
  tags: Tag[] = [];
  problems: Problem[] = [];

  ok(): boolean {
    return this.problems.length === 0;
  }

  toSession(): Session {
    return Session.from({
      state: this.state,
      questions: this.questions.map(([name, q]) => [name, q] as Entry),
      model: this.model,
      bars: this.bars,
    });
  }

  /** The first problem on a line — what the status line shows for the cursor. */
  problemAt(line: number): Problem | undefined {
    return this.problems.find((p) => p.line === line);
  }
}

/** A question block under construction: its head, and the parts collected from the lines below. */
interface Block {
  line: number;
  name: string;
  marker: string;
  /** The head line after the marker, unsplit — raw questions need it whole. */
  rest: string;
  parts: Array<[number, string]>;
  /** `@threshold` / `@confidence` lines: the line, which of the two, and the number. */
  bars: Array<[line: number, directive: Bar, value: number]>;
}

/** The two directives that set a question's bar. */
type Bar = "threshold" | "confidence";

export function parse(text: string): ParsedSketch {
  const lines = text.split("\n");
  const out = new ParsedSketch();
  out.tags = new Array<Tag>(lines.length).fill("blank");

  const ruleAt = lines.findIndex((l) => l.trim() === "---");
  const stateEnd = ruleAt === -1 ? lines.length : ruleAt;
  for (let i = 0; i < stateEnd; i += 1) {
    out.tags[i] = (lines[i] as string).trim() === "" ? "blank" : "state";
  }
  out.state = stateValue(lines.slice(0, stateEnd).join("\n"));

  if (ruleAt === -1) {
    if (lines.some((l) => l.trim() !== "")) {
      out.problems.push({
        line: lines.length - 1,
        message: "no `---` yet — the questions go below one",
      });
    }
    return out;
  }
  out.tags[ruleAt] = "rule";

  let block: Block | undefined;
  for (let i = ruleAt + 1; i < lines.length; i += 1) {
    const text = (lines[i] as string).trim();
    if (text === "") continue;
    if (text.startsWith("#")) {
      out.tags[i] = "comment";
      continue;
    }
    if (text.startsWith("@")) {
      const directive = text.slice(1);
      const at = directive.search(/\s/);
      const name = at === -1 ? directive : directive.slice(0, at);
      const arg = at === -1 ? "" : directive.slice(at + 1).trim();
      if (name === "threshold" || name === "confidence") {
        const bar = parseBar(arg.trim());
        if (bar === undefined) {
          out.tags[i] = "stray";
          out.problems.push({
            line: i,
            message: `\`@${name}\` takes a number from 0 to 1, e.g. \`@${name} 0.6\``,
          });
        } else if (!block) {
          out.tags[i] = "stray";
          out.problems.push({
            line: i,
            message:
              name === "threshold"
                ? "`@threshold` belongs under a question — put it below the `name?` line it sets"
                : "`@confidence` belongs under a question — put it below the choice or score it gates",
          });
        } else {
          block.bars.push([i, name, bar]);
        }
      } else if (name === "model" && arg !== "") {
        out.tags[i] = "model";
        out.model = arg;
      } else if (name === "model") {
        out.tags[i] = "stray";
        out.problems.push({
          line: i,
          message: "`@model` needs a name, e.g. `@model jev-latest`",
        });
      } else {
        out.tags[i] = "stray";
        out.problems.push({
          line: i,
          message: `unknown directive \`@${name}\`; there is \`@model\`, and \`@threshold\` or \`@confidence\` under a question`,
        });
      }
      continue;
    }
    const parsedHead = head(text);
    if (parsedHead) {
      if (block) finish(block, out);
      block = {
        line: i,
        name: parsedHead.name,
        marker: parsedHead.marker,
        rest: parsedHead.rest,
        parts: [],
        bars: [],
      };
      continue;
    }
    if (block) {
      block.parts.push([i, text]);
    } else {
      out.tags[i] = "stray";
      out.problems.push({
        line: i,
        message: "not a question — start one with `name?` (yes/no) or `name:` (options or levels)",
      });
    }
  }
  if (block) finish(block, out);
  return out;
}

/**
 * `name?` / `name:` / `name!` at the start of a line, with the name a plain identifier.
 * `yes:` and `no:` are a noul's body, never a head.
 */
function head(text: string): { name: string; marker: string; rest: string } | undefined {
  const end = text.search(/[?:!]/);
  if (end === -1) return undefined;
  const name = text.slice(0, end);
  if (!isName(name)) return undefined;
  const marker = text[end] as string;
  const after = text.slice(end + 1);
  if (!(after === "" || /^\s/.test(after))) return undefined;
  if (marker === ":" && isCriterion(name)) return undefined;
  return { name, marker, rest: after.trim() };
}

function isName(s: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(s);
}

function isCriterion(word: string): boolean {
  const w = word.toLowerCase();
  return w === "yes" || w === "no" || w === "true" || w === "false";
}

/**
 * A bar as the page writes it: a plain decimal from 0 to 1. Plain, so `1e-1` and `0x1` are
 * refused the same way in every port rather than read however a runtime happens to read them.
 */
export function parseBar(text: string): number | undefined {
  if (!/^(\d+\.?\d*|\.\d+)$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 0 && n <= 1 ? n : undefined;
}

/** Turn a finished block into a question and its bar, or into problems. */
function finish(b: Block, out: ParsedSketch): void {
  const before = out.questions.length;
  finishQuestion(b, out);
  const added = out.questions.length > before;
  const kind = added ? out.questions[out.questions.length - 1]?.[1].kind : undefined;
  let last = b.line;
  for (const [i] of b.parts) last = Math.max(last, i);
  let barAt: number | undefined;
  for (const [i, directive, value] of b.bars) {
    last = Math.max(last, i);
    out.tags[i] = "bar";
    // A question that did not parse has problems enough; its bar waits until it does.
    if (!added) continue;
    const refuse = (message: string): void => {
      out.tags[i] = "stray";
      out.problems.push({ line: i, message });
    };
    if (barAt !== undefined) refuse(`\`${b.name}\` already has a bar on line ${barAt + 1}`);
    else if (kind === "raw") refuse("a raw question takes no bar — jev cannot read its answer");
    else if (kind === "noul" && directive === "confidence") {
      refuse("a yes/no question takes `@threshold`, not `@confidence`");
    } else if (kind !== "noul" && directive === "threshold") {
      refuse("a choice or a score takes `@confidence`, not `@threshold`");
    } else {
      barAt = i;
      out.bars.set(b.name, value);
    }
  }
  if (added) out.blocks.set(b.name, { head: b.line, last, bar: barAt });
}

function finishQuestion(b: Block, out: ParsedSketch): void {
  const problem = (line: number, message: string): void => {
    out.problems.push({ line, message });
  };
  if (out.questions.some(([n]) => n === b.name)) {
    out.tags[b.line] = "stray";
    problem(b.line, `another question is already named \`${b.name}\``);
    return;
  }

  if (b.marker === "!") {
    out.tags[b.line] = "raw";
    let text = b.rest;
    for (const [i, part] of b.parts) {
      out.tags[i] = "json";
      text += `\n${part}`;
    }
    let parsed: Json;
    try {
      parsed = JSON.parse(text) as Json;
    } catch (e) {
      problem(b.line, `raw question is not valid JSON: ${e instanceof Error ? e.message : e}`);
      return;
    }
    const type =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed["type"]
        : undefined;
    if (typeof type !== "string" || type === "") {
      problem(
        b.line,
        'a raw question is a JSON object with a `type`, e.g. {"type": "noul", "instructions": "…"}',
      );
      return;
    }
    out.questions.push([b.name, makeRaw(parsed)]);
    return;
  }

  // `name: instructions | part | part` — inline parts join the ones below.
  const inline = splitTop(b.rest, "|").map((p) => p.trim());
  const instructionsText = inline.shift() ?? "";
  const parts: Array<[number, string]> = inline
    .filter((p) => p !== "")
    .map((p) => [b.line, p] as [number, string]);
  parts.push(...b.parts.map(([i, p]) => [i, p] as [number, string]));
  for (const pair of parts) {
    const bullet = /^([-*•])\s+(.*)$/.exec(pair[1]);
    if (bullet) pair[1] = (bullet[2] ?? "").trim();
  }

  if (instructionsText === "") {
    out.tags[b.line] = "stray";
    problem(
      b.line,
      `\`${b.name}\` needs instructions after the \`${b.marker}\` — what should the model decide?`,
    );
    return;
  }
  const instructions = value(instructionsText);

  const allCriteria =
    parts.length > 0 &&
    parts.every(([, p]) => {
      const at = p.indexOf(":");
      return at >= 0 && isCriterion(p.slice(0, at).trim());
    });

  if (b.marker === "?" || allCriteria) {
    out.tags[b.line] = "noul";
    let yes: Json | undefined;
    let no: Json | undefined;
    let bad = false;
    for (const [i, part] of parts) {
      const at = part.indexOf(":");
      const tag = at >= 0 ? part.slice(0, at).trim() : "";
      if (at >= 0 && isCriterion(tag)) {
        const isYes = tag.toLowerCase() === "yes" || tag.toLowerCase() === "true";
        out.tags[i] = isYes ? "yes" : "no";
        const text = value(part.slice(at + 1).trim());
        if (isYes) yes = text;
        else no = text;
      } else {
        bad = true;
        out.tags[i] = "stray";
        problem(i, "a yes/no question only takes `yes: …` and `no: …` lines");
      }
    }
    if (!bad) out.questions.push([b.name, makeNoul(instructions, { yes, no })]);
    return;
  }

  if (parts.length === 0) {
    out.tags[b.line] = "stray";
    problem(
      b.line,
      "add options (`billing = Payments`) or ordered levels (`Calm < Annoyed < Furious`), or end the name with `?` for yes/no",
    );
    return;
  }

  const isChoice = parts.some(([, p]) => splitTop(p, "=").length > 1);
  // A `<` only means "level" in a part that is not an option; descriptions may contain one.
  const hasLevels = parts.some(
    ([, p]) => splitTop(p, "=").length === 1 && splitTop(p, "<").length > 1,
  );
  if (isChoice && hasLevels) {
    out.tags[b.line] = "stray";
    for (const [i, part] of parts) {
      out.tags[i] = splitTop(part, "=").length > 1 ? "option" : "level";
    }
    problem(
      b.line,
      "options (`label = why`) and levels (`low < high`) are mixed — a question is a choice or a score, not both",
    );
    return;
  }

  if (!isChoice && hasLevels) {
    out.tags[b.line] = "score";
    const levels: Json[] = [];
    for (const [i, part] of parts) {
      out.tags[i] = "level";
      for (const level of splitTop(part, "<")) {
        const trimmed = level.trim();
        if (trimmed !== "") levels.push(value(trimmed));
      }
    }
    if (levels.length < 2) {
      problem(b.line, "a score needs at least two levels, lowest first");
      return;
    }
    out.questions.push([b.name, makeScore(instructions, levels)]);
    return;
  }

  out.tags[b.line] = "choice";
  const options: ChoiceOption[] = [];
  let bad = false;
  for (const [i, part] of parts) {
    out.tags[i] = "option";
    const pieces = splitTop(part, "=");
    const label = (pieces.length > 1 ? (pieces[0] as string) : part).trim();
    const desc = pieces.length > 1 ? (pieces[1] as string).trim() : "";
    if (label === "") {
      bad = true;
      out.tags[i] = "stray";
      problem(i, "an option needs a label before the `=`");
      continue;
    }
    options.push([label, desc === "" ? null : value(desc)]);
  }
  if (bad) return;
  if (options.length < 2) {
    problem(
      b.line,
      "one option is not a choice — add another, or write ordered levels as `a < b < c`",
    );
    return;
  }
  out.questions.push([b.name, makeChoice(instructions, options)]);
}

/**
 * Split on `sep`, except inside a double-quoted JSON string — so a quoted value can carry the
 * notation's own punctuation. Splits at most once for `=`, since a description may contain one.
 */
export function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\" && quoted) {
      escaped = true;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (c === sep && !quoted && (sep !== "=" || parts.length === 0)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Text becomes a JSON value when it is written as one (an object, an array or a quoted string);
 * anything else is sent as the plain string it is.
 */
export function value(text: string): Json {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[") || t.startsWith('"')) {
    const parsed = tryParse(t);
    if (parsed !== undefined) return parsed;
  }
  return t;
}

function stateValue(text: string): Json {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    const parsed = tryParse(t);
    if (parsed !== undefined) return parsed;
  }
  return t;
}

// ---- rendering ------------------------------------------------------------------------------

/**
 * The session as a sketch — the inverse of {@link parse}, so a page can be opened, edited and
 * applied without losing anything.
 */
export function render(session: Session): string {
  let out = "";
  if (typeof session.state === "string") out += session.state.replace(/\s+$/, "");
  else if (session.state !== null) out += pretty(session.state);
  out += "\n---\n";
  if (session.model !== undefined) out += `@model ${session.model}\n`;
  session.questions.forEach(([name, question], i) => {
    if (i > 0 || session.model !== undefined) out += "\n";
    out += renderQuestion(name, question);
    const bar = session.bar(name);
    const directive = barDirective(question.kind);
    if (bar !== undefined && directive !== undefined) out += `  ${directive} ${String(bar)}\n`;
  });
  return out;
}

/** Which directive holds a question's bar, by its kind; a raw question has none. */
function barDirective(kind: Question["kind"]): string | undefined {
  if (kind === "noul") return "@threshold";
  if (kind === "choice" || kind === "score") return "@confidence";
  return undefined;
}

/**
 * Write bars into a page without redrawing it: each named question's bar line is replaced, or a
 * new one is added at the end of its block, and every other line — comments, blank lines, the way
 * someone chose to lay out their options — stays exactly as it was.
 *
 * Questions the page does not have, raw ones and pages that do not parse are left alone; the
 * caller has already parsed the page and knows which it is.
 */
export function setBars(text: string, bars: ReadonlyMap<string, number>): string {
  const parsed = parse(text);
  const lines = text.split("\n");
  const cr = text.includes("\r\n") ? "\r" : "";
  const inserts: Array<[after: number, line: string]> = [];
  for (const [name, value] of bars) {
    const block = parsed.blocks.get(name);
    const question = parsed.questions.find(([n]) => n === name)?.[1];
    const directive = question === undefined ? undefined : barDirective(question.kind);
    if (block === undefined || directive === undefined) continue;
    if (block.bar !== undefined) {
      const old = lines[block.bar] as string;
      const indent = /^[ \t]*/.exec(old)?.[0] ?? "";
      lines[block.bar] = `${indent}${directive} ${String(value)}${old.endsWith("\r") ? "\r" : ""}`;
      continue;
    }
    let indent = "  ";
    for (let i = block.head + 1; i <= block.last; i += 1) {
      const tag = parsed.tags[i];
      if (tag !== undefined && tag !== "blank" && tag !== "comment") {
        indent = /^[ \t]*/.exec(lines[i] as string)?.[0] ?? "  ";
        break;
      }
    }
    inserts.push([block.last, `${indent}${directive} ${String(value)}${cr}`]);
  }
  inserts.sort((x, y) => y[0] - x[0]);
  for (const [after, line] of inserts) lines.splice(after + 1, 0, line);
  return lines.join("\n");
}

function renderQuestion(name: string, question: Question): string {
  if (question.kind === "raw") return `${name}! ${compact(question.value)}\n`;
  const v = questionToJson(question);
  const obj = typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
  const instructions = part(obj["instructions"]);
  const criteria = obj["criteria"];
  let s = "";
  if (question.kind === "noul") {
    s += `${name}? ${instructions}\n`;
    if (typeof criteria === "object" && criteria !== null && !Array.isArray(criteria)) {
      if (criteria["true"] !== undefined) s += `  yes: ${part(criteria["true"])}\n`;
      if (criteria["false"] !== undefined) s += `  no: ${part(criteria["false"])}\n`;
    }
    return s;
  }
  if (question.kind === "choice") {
    s += `${name}: ${instructions}\n`;
    for (const [label, desc] of question.options) {
      s += desc === null ? `  ${label}\n` : `  ${label} = ${part(desc)}\n`;
    }
    return s;
  }
  s += `${name}: ${instructions}\n`;
  const levels = question.levels.map((l) => part(l));
  const oneLine = levels.join(" < ");
  if ([...oneLine].length <= 60) {
    s += `  ${oneLine}\n`;
  } else {
    levels.forEach((level, i) => {
      s += i === 0 ? `  ${level}\n` : `  < ${level}\n`;
    });
  }
  return s;
}

/**
 * A value as it goes on a sketch line: plain text when it can be read back as itself, a JSON
 * literal when it could not (structured values, or text the notation would otherwise split).
 */
function part(v: Json | undefined): string {
  if (v === undefined) return "";
  if (
    typeof v === "string" &&
    !/[|<=\n\r]/.test(v) &&
    !/^[{["#@\-*•]/.test(v) &&
    head(v) === undefined &&
    v.trim() === v &&
    v !== ""
  ) {
    return v;
  }
  return compact(v);
}

/** A sketch, highlighted for the transcript: heads bold in their kind's colour, bodies in it. */
export function highlight(text: string): Line[] {
  const parsed = parse(text);
  return text.split("\n").map((l, i) => {
    const tag = parsed.tags[i] ?? "blank";
    const style: Style = isHead(tag)
      ? { fg: tagColor(tag), bold: true }
      : tag === "state"
        ? {}
        : tag === "rule" || tag === "comment" || tag === "blank"
          ? { fg: DIM }
          : { fg: tagColor(tag) };
    return line([span("  "), span(l, style)]);
  });
}
