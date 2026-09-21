/** Turning answers, questions and errors into styled transcript lines. */

import { isObject, textOf } from "../json.js";
import type { Answer } from "../typesafe/responses.js";
import { isYes, mostLikelyLevel, ranked, roundedLevel } from "../typesafe/responses.js";
import {
  ApiError,
  ConfigError,
  ConnectionError,
  InvalidRequestError,
  ResponseValidationError,
  TimeoutError,
} from "../typesafe/errors.js";
import type { Question } from "../typesafe/questions.js";
import { questionToJson } from "../typesafe/questions.js";
import type { Color, Line, Span } from "../tui/style.js";
import { line, span } from "../tui/style.js";
import type { Estimate, Rates, Thread } from "./cost.js";
import { formatRates, price, priceEstimate, usd } from "./cost.js";
import type { Turn } from "./session.js";

export const NOUL: Color = "cyan";
export const CHOICE: Color = "magenta";
export const SCORE: Color = "green";
export const DIM: Color = "darkGray";
export const WARN: Color = "yellow";
export const BAD: Color = "red";
export const ACCENT: Color = "lightBlue";

export function dim(text: string): Span {
  return span(text, { fg: DIM });
}

export function plain(text: string): Line {
  return line(text);
}

export function styled(text: string, color: Color): Line {
  return line([span(text, { fg: color })]);
}

export function bold(text: string): Span {
  return span(text, { bold: true });
}

/** A probability meter. Eighteen columns is enough to read a distribution at a glance. */
export function bar(p: number, width: number): string {
  const clamped = Math.min(1, Math.max(0, p));
  const filled = Math.min(width, Math.round(clamped * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function colorFor(kind: string): Color {
  switch (kind) {
    case "noul":
      return NOUL;
    case "choice":
      return CHOICE;
    case "score":
      return SCORE;
    default:
      return DIM;
  }
}

function fixed(n: number, digits = 2): string {
  return n.toFixed(digits);
}

function padEnd(text: string, width: number): string {
  const len = [...text].length;
  return len >= width ? text : text + " ".repeat(width - len);
}

function padStart(text: string, width: number): string {
  const len = [...text].length;
  return len >= width ? text : " ".repeat(width - len) + text;
}

function confidenceSpan(c: number): Span {
  const color = c >= 0.6 ? SCORE : c >= 0.35 ? WARN : BAD;
  return span(fixed(c), { fg: color });
}

/** Render one answer: the number, the distribution it came from, and what it means. */
export function answerLines(name: string, answer: Answer, threshold: number): Line[] {
  const kind = answer.type;
  const out: Line[] = [
    line([span("  "), bold(name), span("  "), span(kind, { fg: colorFor(kind) })]),
  ];

  if (answer.type === "noul") {
    const yes = isYes(answer, threshold);
    out.push(
      line([
        span("    "),
        bold(fixed(answer.noul)),
        span("  "),
        span(bar(answer.noul, 18), { fg: NOUL }),
        span("  "),
        span(yes ? "yes" : "no", { fg: yes ? SCORE : DIM, bold: true }),
        dim(` at threshold ${fixed(threshold)}`),
      ]),
    );
  } else if (answer.type === "choice") {
    out.push(
      line([
        span("    → "),
        span(answer.choice, { fg: CHOICE, bold: true }),
        span("   "),
        dim("confidence "),
        confidenceSpan(answer.confidence),
      ]),
    );
    const rows = ranked(answer);
    const pad = rows.reduce((width, [label]) => Math.max(width, [...label].length), 0);
    for (const [label, p] of rows) {
      out.push(
        line([
          span("      "),
          span(padEnd(label, pad), { fg: label === answer.choice ? "reset" : DIM }),
          span("  "),
          span(fixed(p)),
          span("  "),
          span(bar(p, 18), { fg: CHOICE }),
        ]),
      );
    }
  } else {
    const levels = [...answer.legend.keys()];
    const top = levels.length > 0 ? (levels[levels.length - 1] as number) : 0;
    const likely = mostLikelyLevel(answer);
    out.push(
      line([
        span("    "),
        span(fixed(answer.score), { fg: SCORE, bold: true }),
        dim(` of ${top}`),
        span("   "),
        dim("confidence "),
        confidenceSpan(answer.confidence),
        dim(`   most likely level ${likely === undefined ? "-" : likely}`),
      ]),
    );
    const labels: Array<[number, string]> = [...answer.legend.entries()].map(([i, v]) => [
      i,
      textOf(v),
    ]);
    const pad = Math.min(
      40,
      labels.reduce((width, [, label]) => Math.max(width, [...label].length), 0),
    );
    const rounded = roundedLevel(answer);
    for (const [level, label] of labels) {
      const p = answer.probabilities.get(level) ?? 0;
      const marker = rounded === level ? "▸" : " ";
      out.push(
        line([
          span(`     ${marker} `),
          dim(`${level} `),
          span(padEnd(label, pad), { fg: "reset" }),
          span("  "),
          span(fixed(p)),
          span("  "),
          span(bar(p, 18), { fg: SCORE }),
        ]),
      );
    }
  }
  return out;
}

/**
 * The cost estimate as a small table: which question spends what, and — when rates are set — the
 * money at the bottom. Tokens are estimated, so the numbers are a shape, not a bill. `hint` is how
 * this host sets rates, since the terminal has `:cost` and the web has a dialog.
 */
export function costLines(
  estimate: Estimate,
  rates: Rates | undefined,
  hint = "set a price to see the money: dollars per million tokens, input then output",
  thread?: Thread,
): Line[] {
  const names = [...estimate.questions.map((q) => q.name), "state", "envelope", "total"];
  const pad = names.reduce((width, name) => Math.max(width, [...name].length), 0);
  // `noul` and `choice` fit the seven the table has always been; a long enough thread does not.
  const turns = thread === undefined ? "" : `${thread.turns} turn${thread.turns === 1 ? "" : "s"}`;
  const kindPad = Math.max(7, [...turns].length);
  const row = (name: string, kind: string, input: string, output: string, style?: Color): Line =>
    line([
      span("  "),
      span(padEnd(name, pad), style === undefined ? {} : { fg: style }),
      span("  "),
      dim(padEnd(kind, kindPad)),
      span(padStart(input, 6)),
      span(padStart(output, 6)),
    ]);

  const out: Line[] = [
    line([
      span("  "),
      dim(padEnd("", pad)),
      span("  "),
      dim(padEnd("", kindPad)),
      dim(padStart("in", 6)),
      dim(padStart("out", 6)),
    ]),
  ];
  for (const q of estimate.questions) {
    out.push(
      row(
        q.name,
        q.kind,
        String(q.inputTokens),
        q.assumed ? `~${q.outputTokens}` : String(q.outputTokens),
        colorFor(q.kind),
      ),
    );
  }
  out.push(row("state", turns, String(estimate.stateTokens), "·"));
  out.push(
    row("envelope", "", String(estimate.envelopeTokens), String(estimate.answerEnvelopeTokens)),
  );
  out.push(
    line([
      span("  "),
      bold(padEnd("total", pad)),
      span("  "),
      dim(padEnd("", kindPad)),
      bold(padStart(String(estimate.inputTokens), 6)),
      bold(padStart(String(estimate.outputTokens), 6)),
      dim(`   ${estimate.inputTokens + estimate.outputTokens} tokens per call`),
    ]),
  );

  if (rates === undefined) {
    out.push(line([span("    "), dim(`no rates set — ${hint}`)]));
    out.push(...threadLines(thread, rates));
    return out;
  }
  const cost = priceEstimate(estimate, rates);
  out.push(
    line([
      span("    "),
      span(usd(cost.total), { fg: SCORE, bold: true }),
      dim(" per call   ·   "),
      span(usd(cost.total * 1000), { fg: SCORE }),
      dim(" per 1,000 calls"),
    ]),
  );
  out.push(line([span("    "), dim(`at ${formatRates(rates)}`)]));
  out.push(...threadLines(thread, rates));
  return out;
}

/**
 * The line under the table when the state is a conversation: a call per turn, all of it added up.
 *
 * A thread is sent whole every time it is asked about, so the tokens grow with the square of the
 * turns rather than with the transcript. Saying so once, in numbers, is cheaper than finding out.
 */
function threadLines(thread: Thread | undefined, rates: Rates | undefined): Line[] {
  if (thread === undefined) return [];
  const calls = `${thread.turns} call${thread.turns === 1 ? "" : "s"}`;
  const total = thread.inputTokens + thread.outputTokens;
  const spans: Span[] = [
    span("    "),
    dim("asked after every turn: "),
    span(calls),
    dim(`, ${thread.inputTokens} in / ${thread.outputTokens} out`),
    dim(`   ${total} tokens for the thread`),
  ];
  if (rates !== undefined) {
    const spent = price(thread.inputTokens, thread.outputTokens, rates);
    spans.push(dim("   ·   "), span(usd(spent.total), { fg: SCORE }));
  }
  return [line(spans)];
}

/** One turn of the conversation held as the state, as `:turn` and `:state` echo it back. */
export function turnLines(index: number, turn: Turn): Line[] {
  return [
    line([
      dim(`  ${index + 1}. `),
      turn.who === undefined ? dim("(unattributed)") : span(turn.who, { fg: ACCENT }),
      span("  "),
      span(turn.said),
    ]),
  ];
}

/** One line per question, the way it will go on the wire. */
export function questionLines(index: number, name: string, question: Question): Line[] {
  const v = questionToJson(question);
  const obj = isObject(v) ? v : {};
  const kind = typeof obj["type"] === "string" ? obj["type"] : "raw";
  const instructions = textOf(obj["instructions"]);
  const lines: Line[] = [
    line([
      dim(`  ${index + 1}. `),
      bold(name),
      span("  "),
      span(kind, { fg: colorFor(kind) }),
      span("  "),
      dim(instructions),
    ]),
  ];
  const criteria = obj["criteria"];
  if (kind === "choice" && isObject(criteria)) {
    for (const [label, desc] of Object.entries(criteria)) {
      lines.push(
        line([
          span("       "),
          span(label, { fg: CHOICE }),
          dim(desc === null ? "" : ` — ${textOf(desc)}`),
        ]),
      );
    }
  } else if (kind === "score" && Array.isArray(criteria)) {
    criteria.forEach((level, i) => {
      lines.push(line([span("       "), span(String(i), { fg: SCORE }), dim(` ${textOf(level)}`)]));
    });
  } else if (kind === "noul" && isObject(criteria)) {
    for (const [key, value] of Object.entries(criteria)) {
      lines.push(
        line([
          span("       "),
          span(key === "true" ? "yes" : "no", { fg: NOUL }),
          dim(` — ${textOf(value)}`),
        ]),
      );
    }
  }
  return lines;
}

/** Errors are part of the lesson: show the variant, what it means, and what to do. */
export function errorLines(error: unknown): Line[] {
  const { variant, advice } = classify(error);
  const message = error instanceof Error ? error.message : String(error);
  const lines: Line[] = [line([span(`  ${variant}  `, { fg: BAD, bold: true }), span(message)])];
  if (error instanceof ResponseValidationError) {
    lines.push(line([span("    "), dim(`field_path: ${error.fieldPath}`)]));
  }
  if (error instanceof ApiError) {
    const wait = error.retryAfterMs();
    lines.push(
      line([
        span("    "),
        dim(`kind: ${error.kind}`),
        dim(wait === undefined ? "" : `   retry after ${(wait / 1000).toFixed(1)}s`),
      ]),
    );
  }
  const requestId =
    error instanceof ApiError || error instanceof ResponseValidationError
      ? error.requestId
      : undefined;
  if (requestId !== undefined) {
    lines.push(line([span("    "), dim(`request_id: ${requestId}`)]));
  }
  lines.push(line([span("    "), dim(advice)]));
  return lines;
}

function classify(error: unknown): { variant: string; advice: string } {
  if (error instanceof ConfigError) {
    return { variant: "Config", advice: "Fix the client settings — :key sets an API key." };
  }
  if (error instanceof InvalidRequestError) {
    return {
      variant: "InvalidRequest",
      advice: "Rejected before anything was sent; nothing reached the API.",
    };
  }
  if (error instanceof ApiError) {
    return { variant: "Api", advice: apiAdvice(error.httpStatus) };
  }
  if (error instanceof ConnectionError) {
    return {
      variant: "Connection",
      advice: "No response: DNS, TLS, reset or a dropped body.",
    };
  }
  if (error instanceof TimeoutError) {
    return {
      variant: "Timeout",
      advice: "An attempt ran past its per-attempt timeout — see :timeout.",
    };
  }
  if (error instanceof ResponseValidationError) {
    return {
      variant: "ResponseValidation",
      advice: "A 2xx body was missing required data; field_path points at it.",
    };
  }
  return { variant: "Error", advice: "Unhandled variant." };
}

function apiAdvice(status: number): string {
  switch (status) {
    case 401:
      return "The API key is missing or wrong.";
    case 403:
      return "The key is valid but not allowed to do this.";
    case 422:
      return "The server rejected the body — check the question criteria.";
    case 429:
      return "Rate limited; the SDK already retried with backoff.";
    default:
      return status >= 500
        ? "Server-side; the SDK already retried with backoff."
        : "Non-2xx after retries.";
  }
}
