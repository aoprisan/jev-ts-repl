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

import type { Json } from "../json.js";
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
import { linesText } from "../tui/style.js";
import type { Cost, Rates } from "./cost.js";
import * as cost from "./cost.js";
import { errorLines } from "./format.js";
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
    inputTokens = 0;
    outputTokens = 0;
    for (const one of cases) {
      const estimate = cost.estimate(withState(session, one.state), model);
      inputTokens += estimate.inputTokens;
      outputTokens += estimate.outputTokens;
    }
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
