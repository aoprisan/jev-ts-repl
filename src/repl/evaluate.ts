/**
 * Scoring a rubric against states someone has already labelled.
 *
 * One call tells you what the model said about one state; that is what `jev run` is for. It does
 * not tell you where to put the threshold, or how confident a choice has to be before a script may
 * act on it — the README leaves both calls to you, and this is the module that turns them into a
 * table. Feed it a page and a file of labelled states and it reports what the rubric got right,
 * at every threshold worth trying.
 *
 * Everything here is pure: cases come in as text, the answers come from a function you pass, and
 * the report goes out as lines and JSON. Reading files, hashing request bodies and talking to the
 * API belong to the caller.
 */

import type { Json, JsonObject } from "../json.js";
import { compact, isEmptyValue, isObject, parseError, textOf, tryParse } from "../json.js";
import type { ChoiceQuestion, Question } from "../typesafe/questions.js";
import type {
  Answer,
  ChoiceAnswer,
  NoulAnswer,
  ScoreAnswer,
  Usage,
} from "../typesafe/responses.js";
import { roundedLevel } from "../typesafe/responses.js";
import type { Line } from "../tui/style.js";
import { blankLine, line, linesText, span } from "../tui/style.js";
import type { Cost, Rates } from "./cost.js";
import * as cost from "./cost.js";
import { BAD, bold, CHOICE, colorFor, dim, errorLines } from "./format.js";
import type { Answered } from "./headless.js";
import type { Parsed, Session } from "./session.js";

/** One labelled state: what to judge, and what the rubric should say about it. */
export interface Case {
  /** 1-based line in the cases file, for messages. */
  readonly line: number;
  readonly id?: string;
  readonly state: Json;
  /** Question name → expectation, already checked against the session's questions. */
  readonly expect: Readonly<Record<string, Expectation>>;
}

/** What one question is expected to answer, in the shape its kind is scored in. */
export type Expectation =
  | { readonly kind: "noul"; readonly yes: boolean }
  | { readonly kind: "choice"; readonly label: string }
  | { readonly kind: "score"; readonly level: number };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const err = <T>(error: string): Parsed<T> => ({ ok: false, error });

/**
 * Parse JSON Lines into cases, checking every expectation against `session`.
 *
 * Blank lines are skipped and everything else has to be a case, because a file of labels is worth
 * nothing if a typo silently drops a row. The line number travels with the case: it is what the
 * report names a case by, so a bad row is found by the same number that reported it.
 */
export function parseCases(text: string, session: Session): Parsed<Case[]> {
  const cases: Case[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] as string).trim();
    if (raw === "") continue;
    const parsed = parseCase(raw, i + 1, session);
    if (!parsed.ok) return err(`cases line ${i + 1}: ${parsed.error}`);
    cases.push(parsed.value);
  }
  if (cases.length === 0) return err("the cases file holds no cases.");
  return ok(cases);
}

function parseCase(text: string, line: number, session: Session): Parsed<Case> {
  const value = tryParse(text);
  if (value === undefined) return err(`not valid JSON: ${parseError(text)}`);
  if (!isObject(value)) return err("expected a JSON object with `state` and `expect`.");

  const id = value["id"];
  if (id !== undefined && typeof id !== "string") return err("`id` must be a string.");

  const state = value["state"];
  if (state === undefined) return err("missing `state`: a case has to say what to judge.");
  if (isEmptyValue(state)) return err("the `state` is empty: there is nothing to judge.");

  const wanted = value["expect"];
  if (wanted === undefined) return err("missing `expect`: a case has to say what the answer is.");
  if (!isObject(wanted) || Object.keys(wanted).length === 0) {
    return err("`expect` has to name at least one question.");
  }

  const expect: Record<string, Expectation> = {};
  for (const [name, value] of Object.entries(wanted)) {
    const question = session.questions.find(([n]) => n === name)?.[1];
    if (question === undefined) {
      return err(`no question named ${JSON.stringify(name)} on the page.`);
    }
    const expectation = expected(name, question, value);
    if (!expectation.ok) return expectation;
    expect[name] = expectation.value;
  }
  return ok(id === undefined ? { line, state, expect } : { line, id, state, expect });
}

/** Check one expected value against the question it names, and store it the way it is scored. */
function expected(name: string, question: Question, value: Json): Parsed<Expectation> {
  switch (question.kind) {
    case "noul":
      if (typeof value !== "boolean") {
        return err(`${name} is a noul: expected true or false, got ${compact(value)}.`);
      }
      return ok({ kind: "noul", yes: value });
    case "choice": {
      const labels = question.options.map(([label]) => label);
      if (typeof value !== "string" || !labels.includes(value)) {
        return err(`${name} is a choice between ${labels.join(", ")}; got ${compact(value)}.`);
      }
      return ok({ kind: "choice", label: value });
    }
    case "score": {
      const top = question.levels.length - 1;
      if (typeof value === "number") {
        if (!Number.isInteger(value) || value < 0 || value > top) {
          return err(`${name} is a score: expected a level from 0 to ${top}, got ${value}.`);
        }
        return ok({ kind: "score", level: value });
      }
      // A level's own text reads better in a cases file than its index does; the first wins.
      const at = question.levels.findIndex((level) => textOf(level) === textOf(value));
      if (at < 0) {
        return err(
          `${name} is a score: expected a level from 0 to ${top}, or one of its levels; got ${compact(value)}.`,
        );
      }
      return ok({ kind: "score", level: at });
    }
    case "raw":
      return err(`${name} is a raw question: raw questions cannot be scored.`);
  }
}

/** What one case's request came back as. */
export type Outcome =
  | { readonly ok: true; readonly answers: readonly Answered[]; readonly usage?: Usage }
  | { readonly ok: false; readonly error: string };

/**
 * Send every case through `ask`, at most `concurrency` at a time; results are in case order.
 *
 * The workers pull from a shared index rather than being handed a slice each, so a slow case holds
 * up nothing but itself, and a case that throws is recorded and stepped over: a file of a thousand
 * labels should not be lost to one timeout.
 */
export function run(
  session: Session,
  cases: readonly Case[],
  ask: (session: Session) => Promise<Outcome>,
  concurrency: number,
): Promise<Outcome[]> {
  const outcomes: Outcome[] = new Array<Outcome>(cases.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      const one = cases[at];
      if (one === undefined) return;
      try {
        outcomes[at] = await ask(withState(session, one.state));
      } catch (e) {
        outcomes[at] = { ok: false, error: linesText(errorLines(e)).trim() };
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(concurrency), cases.length));
  return Promise.all(Array.from({ length: workers }, () => worker())).then(() => outcomes);
}

/** One row of a noul's threshold sweep: the confusion counts, and what they come to. */
export interface SweepRow {
  readonly threshold: number;
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly accuracy: number;
  /** `undefined` when nothing was predicted a yes, because a rate over nothing is not zero. */
  readonly precision: number | undefined;
  /** `undefined` when nothing was expected to be a yes. */
  readonly recall: number | undefined;
  readonly f1: number;
}

/** One cut of the confidence gate: how much of the set survives it, and how right it is. */
export interface GateRow {
  readonly confidence: number;
  readonly coverage: number;
  /** `undefined` when no case is confident enough to be counted. */
  readonly accuracy: number | undefined;
}

export interface NoulReport {
  readonly name: string;
  readonly kind: "noul";
  readonly cases: number;
  /** Mean squared error of the probability itself, threshold or no threshold. */
  readonly brier: number;
  /** Accuracy at the threshold this run was asked to use. */
  readonly accuracy: number;
  readonly best: { readonly threshold: number; readonly f1: number };
  readonly sweep: readonly SweepRow[];
}

export interface ChoiceReport {
  readonly name: string;
  readonly kind: "choice";
  readonly cases: number;
  readonly accuracy: number;
  /** The page's options, plus `other` when the model answered something else. */
  readonly labels: readonly string[];
  /** Rows expected, columns predicted. */
  readonly confusion: ReadonlyArray<readonly number[]>;
  readonly gate: readonly GateRow[];
}

export interface ScoreReport {
  readonly name: string;
  readonly kind: "score";
  readonly cases: number;
  readonly exact: number;
  readonly withinOne: number;
  readonly mae: number;
  readonly gate: readonly GateRow[];
}

export type QuestionReport = NoulReport | ChoiceReport | ScoreReport;

/** A case that never produced a full set of answers, and why. */
export interface CaseError {
  readonly case: number;
  readonly id?: string;
  readonly message: string;
}

/** The tokens the run spent, counted when the API counted them and estimated when it did not. */
export interface ReportUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimated: boolean;
  readonly cost: Cost | undefined;
}

/** Everything the run found out, with the numbers unrounded. */
export interface Report {
  readonly model: string;
  readonly threshold: number;
  readonly cases: number;
  readonly answered: number;
  readonly errors: readonly CaseError[];
  readonly questions: readonly QuestionReport[];
  readonly usage: ReportUsage;
}

/** The thresholds a sweep always covers; the chosen one joins them when it is not one of these. */
const SWEEP = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/** The cuts the confidence gate is read at. */
const CUTS = [0, 0.2, 0.4, 0.6, 0.8];

/** One case that answered everything it was labelled for. */
interface Scored {
  readonly expect: Readonly<Record<string, Expectation>>;
  readonly answers: ReadonlyMap<string, Answer>;
  readonly usage: Usage | undefined;
}

/**
 * Score the outcomes against the cases.
 *
 * A case either answered everything it was labelled for or it counts as an error: a half-answered
 * case would quietly skew whichever question it did answer, and a rubric is being judged here.
 */
export function report(
  session: Session,
  cases: readonly Case[],
  outcomes: readonly Outcome[],
  options: { model: string; threshold: number; rates: Rates | undefined },
): Report {
  const errors: CaseError[] = [];
  const scored: Scored[] = [];
  cases.forEach((one, at) => {
    const outcome = outcomes[at];
    const failed = (message: string): void => {
      errors.push(
        one.id === undefined
          ? { case: one.line, message }
          : { case: one.line, id: one.id, message },
      );
    };
    if (outcome === undefined) return failed("nothing was sent for this case.");
    if (!outcome.ok) return failed(outcome.error);
    const answers = new Map<string, Answer>();
    for (const [name, answer] of outcome.answers) if (answer) answers.set(name, answer);
    for (const [name, expectation] of Object.entries(one.expect)) {
      const answer = answers.get(name);
      if (answer === undefined) return failed(`no answer came back for ${name}`);
      if (answer.type !== expectation.kind) {
        return failed(`${name} came back as a ${answer.type}, not a ${expectation.kind}`);
      }
    }
    scored.push({ expect: one.expect, answers, usage: outcome.usage });
  });

  const questions: QuestionReport[] = [];
  for (const [name, question] of session.questions) {
    const rows = scored.filter((one) => one.expect[name] !== undefined);
    if (rows.length === 0) continue;
    if (question.kind === "noul") questions.push(noulReport(name, rows, options.threshold));
    else if (question.kind === "choice") questions.push(choiceReport(name, question, rows));
    else if (question.kind === "score") questions.push(scoreReport(name, rows));
  }

  return {
    model: options.model,
    threshold: options.threshold,
    cases: cases.length,
    answered: scored.length,
    errors,
    questions,
    usage: usageOf(session, cases, scored, options.model, options.rates),
  };
}

/** The accuracy `--min-accuracy` holds a question to: exact agreement at the chosen threshold. */
export function accuracyOf(question: QuestionReport): number {
  return question.kind === "score" ? question.exact : question.accuracy;
}

/** Questions whose accuracy is below `bar`, for --min-accuracy. */
export function belowBar(report: Report, bar: number): Array<[name: string, accuracy: number]> {
  const out: Array<[string, number]> = [];
  for (const question of report.questions) {
    const accuracy = accuracyOf(question);
    if (accuracy < bar) out.push([question.name, accuracy]);
  }
  return out;
}

function noulReport(name: string, rows: readonly Scored[], threshold: number): NoulReport {
  const points = rows.map((row) => ({
    p: (row.answers.get(name) as NoulAnswer).noul,
    yes: (row.expect[name] as Extract<Expectation, { kind: "noul" }>).yes,
  }));
  const thresholds = SWEEP.includes(threshold)
    ? SWEEP
    : [...SWEEP, threshold].sort((a, b) => a - b);
  const sweep = thresholds.map((at) => sweepRow(points, at));
  const chosen = sweep.find((row) => row.threshold === threshold) as SweepRow;
  let best = sweep[0] as SweepRow;
  for (const row of sweep) if (row.f1 > best.f1) best = row;
  const brier = mean(points.map(({ p, yes }) => (p - (yes ? 1 : 0)) ** 2));
  return {
    name,
    kind: "noul",
    cases: points.length,
    brier,
    accuracy: chosen.accuracy,
    best: { threshold: best.threshold, f1: best.f1 },
    sweep,
  };
}

function sweepRow(points: ReadonlyArray<{ p: number; yes: boolean }>, threshold: number): SweepRow {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const { p, yes } of points) {
    const predicted = p >= threshold;
    if (predicted && yes) tp += 1;
    else if (predicted && !yes) fp += 1;
    else if (!predicted && yes) fn += 1;
    else tn += 1;
  }
  const f1 = 2 * tp + fp + fn === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
  return {
    threshold,
    tp,
    fp,
    fn,
    tn,
    accuracy: (tp + tn) / points.length,
    precision: tp + fp === 0 ? undefined : tp / (tp + fp),
    recall: tp + fn === 0 ? undefined : tp / (tp + fn),
    f1,
  };
}

function choiceReport(
  name: string,
  question: ChoiceQuestion,
  rows: readonly Scored[],
): ChoiceReport {
  const options = question.options.map(([label]) => label);
  const points = rows.map((row) => {
    const answer = row.answers.get(name) as ChoiceAnswer;
    return {
      predicted: answer.choice,
      expected: (row.expect[name] as Extract<Expectation, { kind: "choice" }>).label,
      confidence: answer.confidence,
      right: answer.choice === (row.expect[name] as Extract<Expectation, { kind: "choice" }>).label,
    };
  });
  // A label the page never offered still has to land somewhere, or the matrix loses cases.
  const other = points.some((point) => !options.includes(point.predicted));
  const labels = other ? [...options, "other"] : options;
  const confusion = options.map((expected) =>
    labels.map(
      (predicted, column) =>
        points.filter(
          (point) =>
            point.expected === expected &&
            (other && column === labels.length - 1
              ? !options.includes(point.predicted)
              : point.predicted === predicted),
        ).length,
    ),
  );
  return {
    name,
    kind: "choice",
    cases: points.length,
    accuracy: mean(points.map((point) => (point.right ? 1 : 0))),
    labels,
    confusion,
    gate: gate(points),
  };
}

function scoreReport(name: string, rows: readonly Scored[]): ScoreReport {
  const points = rows.map((row) => {
    const answer = row.answers.get(name) as ScoreAnswer;
    const expected = (row.expect[name] as Extract<Expectation, { kind: "score" }>).level;
    const off = Math.abs(roundedLevel(answer) - expected);
    return { off, confidence: answer.confidence, right: off === 0 };
  });
  return {
    name,
    kind: "score",
    cases: points.length,
    exact: mean(points.map((point) => (point.right ? 1 : 0))),
    withinOne: mean(points.map((point) => (point.off <= 1 ? 1 : 0))),
    mae: mean(points.map((point) => point.off)),
    gate: gate(points),
  };
}

/** Coverage and accuracy at each cut: what you buy by only acting on confident answers. */
function gate(points: ReadonlyArray<{ confidence: number; right: boolean }>): GateRow[] {
  return CUTS.map((confidence) => {
    const kept = points.filter((point) => point.confidence >= confidence);
    return {
      confidence,
      coverage: points.length === 0 ? 0 : kept.length / points.length,
      accuracy: kept.length === 0 ? undefined : mean(kept.map((point) => (point.right ? 1 : 0))),
    };
  });
}

/** Counted tokens when every answered case carried them; the estimate, marked as one, otherwise. */
function usageOf(
  session: Session,
  cases: readonly Case[],
  scored: readonly Scored[],
  model: string,
  rates: Rates | undefined,
): ReportUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let counted = scored.length > 0;
  for (const one of scored) {
    const usage = one.usage;
    if (usage?.inputTokens === undefined || usage.outputTokens === undefined) {
      counted = false;
      break;
    }
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
  }
  if (!counted) {
    const estimate = preflight(session, cases, model, undefined);
    inputTokens = estimate.inputTokens;
    outputTokens = estimate.outputTokens;
  }
  return {
    inputTokens,
    outputTokens,
    estimated: !counted,
    cost: rates === undefined ? undefined : cost.price(inputTokens, outputTokens, rates),
  };
}

/** The session as one case sends it: the page's questions, the case's state. */
export function withState(session: Session, state: Json): Session {
  const clone = session.clone();
  clone.state = state;
  return clone;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The text report, as lines the terminal and the web can both draw.
 *
 * One block per question, in the page's order: what it scored, the sweep or the gate that says
 * where to set the dial, and — for a choice — the matrix that says what it confuses with what.
 */
export function reportLines(report: Report): Line[] {
  const out: Line[] = [];
  const width = report.questions.reduce((wide, q) => Math.max(wide, [...q.name].length), 0);
  for (const question of report.questions) {
    if (out.length > 0) out.push(blankLine());
    out.push(headerLine(question, width));
    if (question.kind === "noul") out.push(...sweepLines(question, report.threshold));
    else if (question.kind === "choice") {
      out.push(...gateLines(question.gate, "accuracy"));
      out.push(...confusionLines(question));
    } else out.push(...gateLines(question.gate, "exact"));
  }

  if (report.errors.length > 0) {
    if (out.length > 0) out.push(blankLine());
    for (const failed of report.errors) out.push(...errorCaseLines(failed));
  }

  if (out.length > 0) out.push(blankLine());
  const errors = report.errors.length;
  out.push(
    line([
      span("  "),
      bold(`${report.cases} case${report.cases === 1 ? "" : "s"}`),
      dim(` · ${report.answered} answered · ${errors} error${errors === 1 ? "" : "s"}`),
    ]),
  );
  out.push(usageLine(report.usage));
  return out;
}

function headerLine(question: QuestionReport, width: number): Line {
  const count = `${question.cases} case${question.cases === 1 ? "" : "s"}`;
  const summary =
    question.kind === "noul"
      ? `${count} · Brier ${fixed(question.brier)}`
      : question.kind === "choice"
        ? `${count} · accuracy ${fixed(question.accuracy)}`
        : `${count} · exact ${fixed(question.exact)} · within one ${fixed(question.withinOne)} · mae ${fixed(question.mae)}`;
  return line([
    span("  "),
    bold(padEnd(question.name, width)),
    span("  "),
    span(padEnd(question.kind, 8), { fg: colorFor(question.kind) }),
    dim(summary),
  ]);
}

/** The sweep: what the threshold buys, row by row, with a `*` on the one this run used. */
function sweepLines(question: NoulReport, threshold: number): Line[] {
  const out: Line[] = [
    line([
      span("    "),
      dim(padEnd("threshold", 12)),
      dim(padEnd("acc", 6)),
      dim(padEnd("prec", 7)),
      dim(padEnd("rec", 7)),
      dim("f1"),
    ]),
  ];
  for (const row of question.sweep) {
    const chosen = row.threshold === threshold;
    out.push(
      line([
        span("    "),
        span(
          padEnd(`${fixed(row.threshold)}${chosen ? " *" : ""}`, 12),
          chosen ? { bold: true } : {},
        ),
        span(padEnd(fixed(row.accuracy), 6)),
        span(padEnd(rate(row.precision), 7)),
        span(padEnd(rate(row.recall), 7)),
        span(fixed(row.f1)),
      ]),
    );
  }
  out.push(line([span("    "), dim(`best f1 at ${fixed(question.best.threshold)}`)]));
  return out;
}

function gateLines(gate: readonly GateRow[], accuracy: string): Line[] {
  const out: Line[] = [
    line([
      span("    "),
      dim(padEnd("confidence ≥", 15)),
      dim(padEnd("coverage", 10)),
      dim(accuracy),
    ]),
  ];
  for (const row of gate) {
    out.push(
      line([
        span("    "),
        span(padEnd(fixed(row.confidence), 15)),
        span(padEnd(fixed(row.coverage), 10)),
        span(rate(row.accuracy)),
      ]),
    );
  }
  return out;
}

/** The matrix, which is where a rubric's real confusions show: what it calls what. */
function confusionLines(question: ChoiceReport): Line[] {
  const counts = question.confusion.flat().map((n) => String(n).length);
  const column = (label: string): number => Math.max([...label].length, ...counts, 1) + 2;
  const rowWidth =
    question.confusion.reduce(
      (wide, _row, at) => Math.max(wide, [...(question.labels[at] as string)].length),
      0,
    ) + 3;
  const out: Line[] = [
    line([span("    "), dim("confusion, rows expected, columns predicted")]),
    line([
      span(`    ${" ".repeat(rowWidth)}`),
      dim(
        question.labels
          .map((label) => padEnd(label, column(label)))
          .join("")
          .trimEnd(),
      ),
    ]),
  ];
  question.confusion.forEach((row, at) => {
    const expected = question.labels[at] as string;
    out.push(
      line([
        span("    "),
        span(padEnd(expected, rowWidth), { fg: CHOICE }),
        span(
          row
            .map((count, column2) =>
              padEnd(String(count), column(question.labels[column2] as string)),
            )
            .join("")
            .trimEnd(),
        ),
      ]),
    );
  });
  return out;
}

function errorCaseLines(failed: CaseError): Line[] {
  const name = `case ${failed.case}${failed.id === undefined ? "" : ` (${failed.id})`}`;
  const [first, ...rest] = failed.message.split("\n");
  const out: Line[] = [
    line([span("  "), span(`${name}: `, { fg: BAD }), span((first ?? "").trim())]),
  ];
  for (const more of rest) out.push(line([span("    "), dim(more.trim())]));
  return out;
}

function usageLine(usage: ReportUsage): Line {
  const money = usage.cost === undefined ? "" : ` · ${cost.usd(usage.cost.total)}`;
  const tokens = `${usage.inputTokens} in / ${usage.outputTokens} out tokens${money}`;
  return usage.estimated
    ? line([span("  "), dim(`≈ ${tokens} — estimated, nothing was counted`)])
    : line([span("  "), dim(tokens)]);
}

/** The JSON report, ready for `pretty`. Numbers keep their precision; what is undefined is null. */
export function reportJson(report: Report): Json {
  const questions: JsonObject = {};
  for (const question of report.questions) questions[question.name] = questionJson(question);
  const usage: JsonObject = {
    inputTokens: report.usage.inputTokens,
    outputTokens: report.usage.outputTokens,
    estimated: report.usage.estimated,
  };
  if (report.usage.cost !== undefined) usage["cost"] = report.usage.cost.total;
  return {
    model: report.model,
    threshold: report.threshold,
    cases: report.cases,
    answered: report.answered,
    errors: report.errors.map((failed) => {
      const out: JsonObject = { case: failed.case };
      if (failed.id !== undefined) out["id"] = failed.id;
      out["message"] = failed.message;
      return out;
    }),
    questions,
    usage,
  };
}

function questionJson(question: QuestionReport): Json {
  if (question.kind === "noul") {
    return {
      kind: question.kind,
      cases: question.cases,
      brier: question.brier,
      accuracy: question.accuracy,
      best: { threshold: question.best.threshold, f1: question.best.f1 },
      sweep: question.sweep.map((row) => ({
        threshold: row.threshold,
        tp: row.tp,
        fp: row.fp,
        fn: row.fn,
        tn: row.tn,
        accuracy: row.accuracy,
        precision: row.precision ?? null,
        recall: row.recall ?? null,
        f1: row.f1,
      })),
    };
  }
  if (question.kind === "choice") {
    return {
      kind: question.kind,
      cases: question.cases,
      accuracy: question.accuracy,
      labels: question.labels.slice(),
      confusion: question.confusion.map((row) => row.slice()),
      gate: question.gate.map(gateJson),
    };
  }
  return {
    kind: question.kind,
    cases: question.cases,
    exact: question.exact,
    withinOne: question.withinOne,
    mae: question.mae,
    gate: question.gate.map(gateJson),
  };
}

function gateJson(row: GateRow): Json {
  return { confidence: row.confidence, coverage: row.coverage, accuracy: row.accuracy ?? null };
}

/** The preflight estimate: tokens summed over every case, priced when rates are known. */
export function preflight(
  session: Session,
  cases: readonly Case[],
  model: string,
  rates: Rates | undefined,
): { cases: number; inputTokens: number; outputTokens: number; cost: Cost | undefined } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const one of cases) {
    const estimate = cost.estimate(withState(session, one.state), model);
    inputTokens += estimate.inputTokens;
    outputTokens += estimate.outputTokens;
  }
  return {
    cases: cases.length,
    inputTokens,
    outputTokens,
    cost: rates === undefined ? undefined : cost.price(inputTokens, outputTokens, rates),
  };
}

function fixed(n: number): string {
  return n.toFixed(2);
}

/** A rate that was never defined is a dot, not a zero: nothing was measured. */
function rate(n: number | undefined): string {
  return n === undefined ? "·" : fixed(n);
}

function padEnd(text: string, width: number): string {
  const length = [...text].length;
  return length >= width ? text : text + " ".repeat(width - length);
}
