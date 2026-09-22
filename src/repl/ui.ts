/** Layout: a status strip, the transcript, a live view of the session, and the input line. */

import { questionToJson } from "../typesafe/questions.js";
import type { Buffer } from "../tui/buffer.js";
import type { Rect } from "../tui/layout.js";
import { centered, horizontal, length, min, percentage, vertical } from "../tui/layout.js";
import type { Line, Span, Style } from "../tui/style.js";
import { blankLine, line, span } from "../tui/style.js";
import type { App } from "./app.js";
import { COMMANDS } from "./app.js";
import type { Builder, Field } from "./builder.js";
import { kindAbout, sameField } from "./builder.js";
import * as codegen from "./codegen.js";
import type { Preview } from "./editor.js";
import { PREVIEWS } from "./editor.js";
import * as cost from "./cost.js";
import { ACCENT, answerLines, BAD, colorFor, costLines, DIM, dim, SCORE, WARN } from "./format.js";
import * as highlight from "./highlight.js";
import { LESSONS } from "./lessons.js";
import * as mock from "./mock.js";
import type { Session } from "./session.js";
import type { Tag } from "./sketch.js";
import { isHead, tagColor, tagLabel } from "./sketch.js";
import * as wrap from "./wrap.js";

/** Width of the label column in builder mode. */
const LABEL = 14;

const SPINNER = ["⠋", "⠙", "⠹", "⠸"];

/** Where the terminal's own cursor belongs after a frame. */
export interface Cursor {
  x: number;
  y: number;
}

const isKnownCommand = (cmd: string): boolean => COMMANDS.some(([c]) => c === cmd);

function padEnd(text: string, width: number): string {
  const len = [...text].length;
  return len >= width ? text : text + " ".repeat(width - len);
}

export function render(buffer: Buffer, app: App): Cursor | undefined {
  if (app.sketch) return sketchView(buffer, buffer.area, app);

  const [top, body, input] = vertical(buffer.area, [length(1), min(3), length(3)]);
  const [left, right] = horizontal(body as Rect, [min(40), length(36)]);

  status(buffer, top as Rect, app);
  transcript(buffer, left as Rect, app);
  panel(buffer, right as Rect, app);
  const cursor = prompt(buffer, input as Rect, app);
  if (app.builder) return builderView(buffer, buffer.area, app);
  return cursor;
}

function status(buffer: Buffer, area: Rect, app: App): void {
  const spans: Span[] = [
    span(" jev ", { fg: ACCENT, bold: true }),
    dim("│ "),
    span(app.modelName()),
    dim(" │ "),
    app.mock ? span("MOCK", { fg: WARN, bold: true }) : span("LIVE", { fg: SCORE, bold: true }),
    dim(
      ` │ ${app.session.questions.length} question(s) │ threshold ${app.threshold.toFixed(2)} │ lesson ${app.lesson + 1}/${LESSONS.length}`,
    ),
  ];
  buffer.paragraph(area, [line(spans)]);
}

function transcript(buffer: Buffer, area: Rect, app: App): void {
  const inner = buffer.block(area, {
    borderStyle: { fg: DIM },
    title: line([dim(" transcript ")]),
  });

  const lines = wrap.wrapAll(app.transcript, inner.width);
  // `scroll` counts lines back from the tail, so new output stays in view at rest.
  const maxScroll = Math.max(0, lines.length - inner.height);
  app.scroll = Math.min(app.scroll, maxScroll);
  const end = lines.length - app.scroll;
  const start = Math.max(0, end - inner.height);
  buffer.paragraph(inner, lines.slice(start, end));

  if (app.scroll > 0) {
    const hint = ` ${app.scroll} line(s) below · Esc to follow `;
    const width = Math.min([...hint].length, Math.max(0, area.width - 2));
    buffer.setSpans(
      area.x + Math.max(0, area.width - width - 1),
      area.y + Math.max(0, area.height - 1),
      [dim(hint)],
      width,
    );
  }
}

function panel(buffer: Buffer, area: Rect, app: App): void {
  const inner = buffer.block(area, {
    borderStyle: { fg: DIM },
    title: line([dim(" session ")]),
  });

  const lines: Line[] = [line([span("state", { fg: ACCENT, bold: true })])];
  if (app.session.stateIsEmpty()) {
    lines.push(line([dim("(empty — type some text)")]));
  } else {
    lines.push(...wrap.wrap(line(app.session.statePreview()), inner.width).slice(0, 6));
  }
  lines.push(blankLine());
  lines.push(line([span("questions", { fg: ACCENT, bold: true })]));
  if (app.session.questions.length === 0) {
    lines.push(line([dim("(none — :noul :choice :score)")]));
  }
  for (const [name, question] of app.session.questions) {
    const json = questionToJson(question);
    const kind =
      typeof json === "object" &&
      json !== null &&
      !Array.isArray(json) &&
      typeof json["type"] === "string"
        ? json["type"]
        : "raw";
    lines.push(line([span("• ", { fg: colorFor(kind) }), span(name), dim(`  ${kind}`)]));
  }

  if (app.session.questions.length > 0) {
    const estimate = cost.estimate(app.session, app.modelName());
    const spent = app.rates === undefined ? undefined : cost.priceEstimate(estimate, app.rates);
    lines.push(blankLine());
    lines.push(line([span("cost", { fg: ACCENT, bold: true }), dim("  estimated")]));
    lines.push(line([dim(`≈ ${estimate.inputTokens} in / ${estimate.outputTokens} out tok`)]));
    lines.push(
      line([
        spent === undefined
          ? dim(":cost 0.20/1.00 to price it")
          : span(`${cost.usd(spent.total)} per call`, { fg: SCORE }),
      ]),
    );
  }

  lines.push(blankLine());
  lines.push(line([span(`lesson ${app.lesson + 1}`, { fg: ACCENT, bold: true })]));
  lines.push(line([dim(LESSONS[app.lesson]?.title ?? "")]));
  if (app.suggested !== undefined) {
    lines.push(
      ...wrap.wrap(line([span(`^T  ${app.suggested}`, { fg: SCORE })]), inner.width).slice(0, 4),
    );
  }

  lines.push(blankLine());
  for (const hint of [
    "Enter   send the session",
    "^T/^N   try / next lesson",
    ":help   every command",
    ":json   the request body",
    ":ts     this session as code",
  ]) {
    lines.push(line([dim(hint)]));
  }

  buffer.paragraph(inner, lines);
}

function prompt(buffer: Buffer, area: Rect, app: App): Cursor | undefined {
  const title = app.pending
    ? line([
        span(` ${SPINNER[app.spinner % SPINNER.length] ?? ""} `, { fg: ACCENT }),
        dim("waiting for the API "),
      ])
    : line([dim(" ask ")]);
  const inner = buffer.block(area, {
    borderStyle: { fg: app.pending ? ACCENT : DIM },
    title,
  });
  if (inner.height === 0) return undefined;

  const width = Math.max(0, inner.width - 2);
  const chars = [...app.input];
  const offset = Math.max(0, app.cursor - width);
  const visible = chars.slice(offset).join("");

  const content =
    app.input === ""
      ? line([
          span("› ", { fg: ACCENT }),
          dim("type text to set the state, :help for commands, Enter to send"),
        ])
      : line([span("› ", { fg: ACCENT }), ...highlight.command(visible, isKnownCommand)]);
  buffer.paragraph(inner, [content]);
  return { x: inner.x + 2 + (app.cursor - offset), y: inner.y };
}

/** The builder-mode popup: a form on the left, the JSON it produces on the right. */
function builderView(buffer: Buffer, area: Rect, app: App): Cursor | undefined {
  const b = app.builder;
  if (!b) return undefined;
  const popup = centered(area, 92, 86);
  buffer.clear(popup);
  const inner = buffer.block(popup, {
    borderStyle: { fg: ACCENT },
    title: line([span(" build a question ", { fg: ACCENT, bold: true })]),
    titleBottom: line([
      dim(" Tab move · Alt-←→ word · ^O add row · ^X drop row · ^S add question · Esc close "),
    ]),
  });

  const [formArea, gutter, previewArea] = horizontal(inner, [percentage(55), length(2), min(20)]);
  if (!formArea || !gutter || !previewArea) return undefined;
  buffer.verticalRule(gutter.x + 1, gutter.y, gutter.height, { fg: DIM });

  const { lines, cursor } = form(b, formArea.width);
  buffer.paragraph(formArea, lines);

  const [jsonArea, commandArea] = vertical(previewArea, [min(3), length(6)]);
  if (jsonArea) {
    const pretty = JSON.stringify(b.preview(), null, 2) ?? "";
    buffer.paragraph(jsonArea, [line([dim("questions")]), ...highlight.json(pretty)]);
  }
  if (commandArea) {
    const tail: Line[] = [line([dim("same thing, one line")])];
    tail.push(
      ...wrap.wrap(line(highlight.command(b.asCommand(), isKnownCommand)), commandArea.width),
    );
    if (b.message !== undefined) {
      tail.push(blankLine());
      tail.push(line([span(b.message, { fg: BAD })]));
    }
    buffer.paragraph(commandArea, tail);
  }

  if (cursor && cursor.row < formArea.height) {
    return {
      x: formArea.x + Math.min(cursor.col, Math.max(0, formArea.width - 1)),
      y: formArea.y + cursor.row,
    };
  }
  return undefined;
}

/** The form rows, plus where the terminal cursor belongs. */
function form(
  b: Builder,
  width: number,
): { lines: Line[]; cursor: { col: number; row: number } | undefined } {
  const lines: Line[] = [];
  let cursor: { col: number; row: number } | undefined;
  const focused = b.focused();
  const fieldWidth = Math.max(8, width - (LABEL + 1));

  const row = (label: string, field: Field, hint: string): void => {
    const isFocused = sameField(field, focused);
    const text = b.text(field);
    const [shown, offset] = view(text, b.cursor, fieldWidth, isFocused);
    const spans: Span[] = [span(padEnd(label, LABEL), { fg: isFocused ? ACCENT : DIM })];
    if (shown === "" && hint !== "") spans.push(dim(hint));
    else spans.push(span(shown, isFocused ? { bold: true } : {}));
    if (isFocused) cursor = { col: LABEL + Math.max(0, b.cursor - offset), row: lines.length };
    lines.push(line(spans));
  };

  row("state", { kind: "state" }, "the text being judged");
  lines.push(blankLine());
  row("name", { kind: "name" }, "answers come back under this");
  if (b.existing.length > 0) {
    lines.push(line([span(" ".repeat(LABEL)), dim(`already asked: ${b.existing.join(", ")}`)]));
  }

  // The type row is a cycler, not a text field.
  const kindFocused = focused.kind === "type";
  lines.push(
    line([
      span(padEnd("type", LABEL), { fg: kindFocused ? ACCENT : DIM }),
      span(`‹ ${b.kind} ›`, { fg: colorFor(b.kind), bold: true }),
      dim(`  ${kindAbout(b.kind)}`),
    ]),
  );
  if (kindFocused) {
    lines.push(line([span(" ".repeat(LABEL)), dim("← → or n/c/s to switch")]));
  }
  row("instructions", { kind: "instructions" }, "what the model should decide");
  lines.push(blankLine());

  if (b.kind === "noul") {
    row("yes means", { kind: "yes" }, "optional");
    row("no means", { kind: "no" }, "optional");
  } else if (b.kind === "choice") {
    b.options.forEach((_, i) => {
      row(`option ${i + 1}`, { kind: "optionLabel", index: i }, "label");
      row("  describe", { kind: "optionDesc", index: i }, "optional, but this is what sharpens it");
    });
  } else {
    b.levels.forEach((_, i) => {
      row(`level ${i}`, { kind: "level", index: i }, i === 0 ? "lowest" : "");
    });
  }
  return { lines, cursor };
}

/** Slide a long value so the cursor stays visible; returns the text and the column it starts at. */
function view(
  text: string,
  cursor: number,
  width: number,
  focused: boolean,
): [shown: string, offset: number] {
  const chars = [...text];
  if (chars.length < width) return [text, 0];
  if (!focused) return [`${chars.slice(0, Math.max(0, width - 1)).join("")}…`, 0];
  const offset = Math.max(0, cursor - Math.max(0, width - 1));
  return [chars.slice(offset).join(""), offset];
}

/** Width of the sketch gutter: a six-letter tag, a problem mark, and the rule. */
const GUTTER = 8;

/**
 * Sketch mode: the page on the left with a gutter saying what each line became, a preview on the
 * right, and a status line that explains whatever the cursor is on.
 */
function sketchView(buffer: Buffer, area: Rect, app: App): Cursor | undefined {
  const ed = app.sketch;
  if (!ed) return undefined;
  const threshold = app.threshold;
  const defaultModel = app.modelName();
  const rates = app.rates;
  const parsed = ed.parsed();

  buffer.clear(area);
  const inner = buffer.block(area, {
    borderStyle: { fg: ACCENT },
    title: line([span(" sketch · the request as one page ", { fg: ACCENT, bold: true })]),
    titleBottom: line([
      dim(
        " ^S apply · ^G apply & send · ^P preview · ^X/^U cut/paste line · Alt-↑↓ move line · Alt-←→ word · Esc close ",
      ),
    ]),
  });

  const [pageArea, statusArea] = vertical(inner, [min(3), length(1)]);
  if (!pageArea || !statusArea) return undefined;
  const [editArea, gutter, previewArea] = horizontal(pageArea, [
    percentage(56),
    length(2),
    min(24),
  ]);
  if (!editArea || !gutter || !previewArea) return undefined;
  buffer.verticalRule(gutter.x + 1, gutter.y, gutter.height, { fg: DIM });

  // ---- the page ----
  const height = editArea.height;
  if (height > 0) {
    if (ed.row < ed.top) ed.top = ed.row;
    else if (ed.row >= ed.top + height) ed.top = ed.row + 1 - height;
  }
  const textWidth = Math.max(8, editArea.width - GUTTER);
  const stateEmpty = !parsed.tags.includes("state");
  const lines: Line[] = [];
  let cursor: { col: number; row: number } | undefined;
  let previous: Tag | undefined;
  for (let i = ed.top; i < ed.lines.length && lines.length < height; i += 1) {
    const text = ed.lines[i] ?? "";
    const tag = parsed.tags[i] ?? "blank";
    const isCurrent = i === ed.row;
    const problem = parsed.problemAt(i) !== undefined;
    // A long state reads better labelled once.
    const label = tag === "state" && previous === "state" ? "" : tagLabel(tag);
    previous = tag;

    const tagStyle: Style = { fg: tagColor(tag) };
    const spans: Span[] = [
      span(padEnd(label, 6), isHead(tag) ? { ...tagStyle, bold: true } : tagStyle),
      span(problem ? "!" : " ", { fg: BAD, bold: true }),
      span("│", { fg: isCurrent ? ACCENT : DIM }),
    ];
    const [shown, offset] = view(text, ed.col, textWidth, isCurrent);
    if (shown === "" && i === 0 && stateEmpty) {
      spans.push(dim("the state — the text or JSON the questions are about"));
    } else {
      const style: Style = isHead(tag)
        ? { fg: tagColor(tag), bold: true }
        : tag === "rule" || tag === "comment"
          ? { fg: DIM }
          : tag === "state" || tag === "blank"
            ? {}
            : { fg: tagColor(tag) };
      spans.push(span(shown, style));
    }
    if (isCurrent) cursor = { col: GUTTER + Math.max(0, ed.col - offset), row: lines.length };
    lines.push(line(spans));
  }
  buffer.paragraph(editArea, lines);

  // ---- the preview ----
  const tabs: Span[] = [];
  PREVIEWS.forEach((p, i) => {
    if (i > 0) tabs.push(dim(" · "));
    tabs.push(p === ed.preview ? span(p, { fg: ACCENT, bold: true }) : dim(p));
  });
  tabs.push(dim("   ^P"));
  if (parsed.problems.length > 0) {
    tabs.push(span(`   ${parsed.problems.length} problem(s)`, { fg: BAD }));
  }
  const preview: Line[] = [line(tabs), blankLine()];
  // Problems go first: they are what to act on, and a long preview must not hide them.
  if (parsed.problems.length > 0) {
    preview.push(line([span("problems", { fg: BAD, bold: true })]));
    for (const p of parsed.problems.slice(0, 6)) {
      preview.push(
        line([span(`  ${String(p.line + 1).padStart(3)}  `, { fg: BAD }), span(p.message)]),
      );
    }
    preview.push(blankLine());
  }

  const session = parsed.toSession();
  const model = session.model ?? defaultModel;
  preview.push(...previewLines(ed.preview, session, model, threshold, rates));
  buffer.paragraph(previewArea, wrap.wrapAll(preview, previewArea.width));

  // ---- the status line: what the cursor is on ----
  const tag = parsed.tags[ed.row] ?? "blank";
  const ruleAt = parsed.tags.indexOf("rule");
  const belowRule = ruleAt >= 0 && ed.row > ruleAt;
  const problem = parsed.problemAt(ed.row);
  const statusSpan =
    ed.message !== undefined
      ? span(ed.message, { fg: WARN })
      : problem
        ? span(problem.message, { fg: BAD })
        : dim(hintFor(tag, belowRule));
  buffer.paragraph(statusArea, [line([span(" "), statusSpan])]);

  if (cursor) {
    return {
      x: editArea.x + Math.min(cursor.col, Math.max(0, editArea.width - 1)),
      y: editArea.y + cursor.row,
    };
  }
  return undefined;
}

function previewLines(
  preview: Preview,
  session: Session,
  model: string,
  threshold: number,
  rates: cost.Rates | undefined,
): Line[] {
  if (preview === "json") return highlight.json(session.requestJson(model));
  if (preview === "ts") {
    return highlight.typescript(codegen.typescript(session, model, threshold));
  }
  if (preview === "cost") {
    if (session.questions.length === 0) {
      return [line([dim("  add a question below the --- line to see what a call would cost")])];
    }
    return costLines(
      cost.estimate(session, model),
      rates,
      ":cost 0.20/1.00 prices it, dollars per million tokens",
    );
  }
  if (session.questions.length === 0) {
    return [line([dim("  add a question below the --- line to see the shape of its answer")])];
  }
  const out: Line[] = [line([dim("  simulated answers — the shape is real, the numbers are not")])];
  for (const [name, q] of session.questions) {
    const answer = mock.answer(session.state, name, questionToJson(q));
    if (answer) out.push(...answerLines(name, answer, session.thresholdOf(name, threshold)));
    else out.push(line([dim(`  ${name}: no simulation for this question shape`)]));
  }
  return out;
}

/** One line about the kind of line under the cursor — the notation explains itself in place. */
function hintFor(tag: Tag, belowRule: boolean): string {
  switch (tag) {
    case "state":
      return "state — the text or JSON the questions are about; a --- line ends it";
    case "rule":
      return "--- separates the state above from the questions below";
    case "blank":
      return belowRule
        ? "name? asks yes/no · name: then `label = why` lines (choice) or `low < high` (score) · name! {json} sends it raw"
        : "state — the text or JSON the questions are about; a --- line ends it";
    case "comment":
      return "a comment — ignored";
    case "model":
      return "@model pins the model this session sends to";
    case "noul":
      return "noul — the answer is the probability of yes; `yes:` and `no:` lines say what each means";
    case "yes":
    case "no":
      return "what a yes or a no means — sharper criteria, higher confidence";
    case "choice":
      return "choice — one label out of these options; `label = why` describes each";
    case "option":
      return "an option — `label = when it applies`; a bare label works but is vaguer";
    case "score":
      return "score — ordered levels, lowest first; the answer is a weighted position along them";
    case "level":
      return "a level — write them lowest to highest, joined with <";
    case "raw":
      return "raw — a JSON object sent as it is; it needs a `type`";
    case "json":
      return "continues the raw JSON above";
    case "bar":
      return "a bar — @threshold is where a noul reads as yes; @confidence is how sure a choice or score must be to act on";
    case "stray":
      return "this line could not be placed";
  }
}
