/**
 * jev with no terminal in the way: a page in, an answer page out.
 *
 * The REPL is the place to shape a request; once it is shaped, the same session is something a
 * script wants — in a pipe, in a Makefile, in CI. Everything here is the pure half of that: text
 * in, text out, no `node:` imports and no process, so the terminal build and the web build can
 * both reach it and a test can drive it without a PTY.
 *
 * ```ts
 * const loaded = headless.load("A payout failed.\n---\nis_urgent? Conveys urgency");
 * if (loaded.ok) console.log(headless.requestText(loaded.value, "jev-latest"));
 * ```
 */

import type { Json } from "../json.js";
import { pretty } from "../json.js";
import { questionToJson } from "../typesafe/questions.js";
import type { Answer, SystemOneResponse, Usage } from "../typesafe/responses.js";
import { linesText } from "../tui/style.js";
import * as codegen from "./codegen.js";
import type { Rates } from "./cost.js";
import * as cost from "./cost.js";
import { answerLines, costLines } from "./format.js";
import * as mock from "./mock.js";
import type { Parsed } from "./session.js";
import { fromBody, Session } from "./session.js";
import * as sketch from "./sketch.js";

/** The subcommands that run without a terminal. */
export const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["run", "send the request and print the answers"],
  ["json", "the exact request body this session POSTs"],
  ["cost", "what a call costs, per question and on both sides of the wire"],
  ["ts", "the session as a TypeScript program"],
  ["rust", "the session as a Rust program against typesafe-ai-sdk"],
  ["check", "parse the input and report what is wrong with it"],
];

export type Command = "run" | "json" | "cost" | "ts" | "rust" | "check";

/** Whether `word` names a subcommand, so `jev <word>` is not mistaken for a flag or a path. */
export function isCommand(word: string): word is Command {
  return COMMANDS.some(([name]) => name === word);
}

/** One question's answer, or `undefined` when nothing answered it. */
export type Answered = readonly [name: string, answer: Answer | undefined];

/**
 * Read a session from a sketch page or a request body.
 *
 * Which one it is comes from the text, not the file name: stdin has no extension, and a here-doc
 * piped in should behave the same as the file it was copied from. A leading `{` is a request body;
 * anything else is a page.
 */
export function load(text: string): Parsed<Session> {
  if (text.trim() === "") return { ok: false, error: "Nothing to read: the input is empty." };
  if (text.trimStart().startsWith("{")) return fromBody(text);
  const page = sketch.parse(text);
  const problem = page.problems[0];
  if (problem) return { ok: false, error: `line ${problem.line + 1}: ${problem.message}` };
  return { ok: true, value: page.toSession() };
}

/** What `jev check` says about a page: every problem, not just the first. */
export function checkText(text: string): Parsed<string> {
  if (text.trim() === "") return { ok: false, error: "Nothing to read: the input is empty." };
  if (text.trimStart().startsWith("{")) {
    const parsed = fromBody(text);
    return parsed.ok ? { ok: true, value: describe(parsed.value) } : parsed;
  }
  const page = sketch.parse(text);
  if (!page.ok()) {
    return {
      ok: false,
      error: page.problems.map((p) => `line ${p.line + 1}: ${p.message}`).join("\n"),
    };
  }
  return { ok: true, value: describe(page.toSession()) };
}

/** `3 questions: is_urgent (noul), department (choice)` — enough to see the parse landed right. */
function describe(session: Session): string {
  const n = session.questions.length;
  const kinds = session.questions.map(([name, q]) => `${name} (${q.kind})`).join(", ");
  const head = `${n} question${n === 1 ? "" : "s"}${kinds === "" ? "" : `: ${kinds}`}`;
  return session.stateIsEmpty() ? `${head}\nno state — pass --state <text> before sending` : head;
}

/** Why this session cannot be sent yet, if it cannot. */
export function sendable(session: Session): string | undefined {
  if (session.questions.length === 0) return "No questions: the request would ask nothing.";
  if (session.stateIsEmpty()) return "No state: pass --state <text>, or put one above the `---`.";
  return undefined;
}

/** The exact body the SDK would POST. */
export function requestText(session: Session, model: string): string {
  return `${session.requestJson(model)}\n`;
}

/** Simulated answers, the same deterministic ones the REPL shows offline. */
export function mockAnswers(session: Session): Answered[] {
  return session.questions.map(
    ([name, q]) => [name, mock.answer(session.state, name, questionToJson(q))] as Answered,
  );
}

/** The answers a live response carries, lined up with the questions that were asked. */
export function liveAnswers(session: Session, response: SystemOneResponse): Answered[] {
  return session.questions.map(([name]) => [name, response.answers.get(name)] as Answered);
}

/** The answer page: the same bars and labels the REPL draws, minus the colour. */
export function answersText(answers: readonly Answered[], threshold: number): string {
  const out: string[] = [];
  for (const [name, answer] of answers) {
    if (answer) out.push(linesText(answerLines(name, answer, threshold)));
    else out.push(`  ${name}: no answer came back for this question.`);
  }
  return `${out.join("\n")}\n`;
}

/** The raw body, for `--json`: what arrived live, or the shape a mock answer would have arrived in. */
export function answersJson(answers: readonly Answered[], model: string, raw?: Json): string {
  return `${pretty(raw ?? mock.mockBody(answers, model))}\n`;
}

/** The token table, priced when rates were supplied. */
export function costText(session: Session, model: string, rates: Rates | undefined): string {
  const estimate = cost.estimate(session, model);
  const hint = "--price 0.20/1.00 prices it: dollars per million tokens, input then output";
  return `${linesText(costLines(estimate, rates, hint))}\n`;
}

/** The one-line footer under an answer page: tokens, and money when the rates are known. */
export function usageText(
  session: Session,
  model: string,
  rates: Rates | undefined,
  usage: Usage | undefined,
): string {
  const priced = usage === undefined ? undefined : rates && cost.priceUsage(usage, rates);
  if (usage?.inputTokens !== undefined && usage.outputTokens !== undefined) {
    const money = priced === undefined ? "" : ` · ${cost.usd(priced.total)}`;
    return `  ${usage.inputTokens} in / ${usage.outputTokens} out tokens${money}\n`;
  }
  const estimate = cost.estimate(session, model);
  const spent = rates === undefined ? undefined : cost.priceEstimate(estimate, rates);
  const money = spent === undefined ? "" : ` · ${cost.usd(spent.total)}`;
  return `  ≈ ${estimate.inputTokens} in / ${estimate.outputTokens} out tokens${money} — estimated, nothing was counted\n`;
}

/** The session as code, for `jev ts` and `jev rust`. */
export function codeText(
  session: Session,
  language: "ts" | "rust",
  model: string,
  threshold: number,
): string {
  const code =
    language === "ts"
      ? codegen.typescript(session, model, threshold)
      : codegen.rust(session, model, threshold);
  return code.endsWith("\n") ? code : `${code}\n`;
}
