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
import { BAD, bold, CHOICE, colorFor, DIM, dim, errorLines, SCORE } from "./format.js";
import type { Answered } from "./headless.js";
import type { Parsed, Session } from "./session.js";
import { turnsOf, turnsToJson } from "./session.js";

/** One labelled state: what to judge, and what the rubric should say about it. */
export interface Case {
  /** 1-based line in the cases file, for messages. */
  readonly line: number;
  readonly id?: string;
  readonly state: Json;
  /** Question name → expectation, already checked against the session's questions. */
  readonly expect: Readonly<Record<string, Expectation>>;
  /**
   * For a case labelled per turn: which prefix of the conversation this is (1-based), and how many
   * turns the whole conversation has. Such a case is sent once per turn, and each is a case.
   */
  readonly turn?: number;
  readonly turns?: number;
}

/** What one question is expected to answer, in the shape its kind is scored in. */
export type Expectation =
  | {
      readonly kind: "noul";
      readonly yes: boolean;
      /** Set when the label was `{"by_turn": k}`: the turn it becomes true, `null` for never. */
      readonly byTurn?: number | null;
    }
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
  const failed = readCases(text, (one) => {
    const expect: Record<string, Expectation> = {};
    for (const [name, value] of Object.entries(one.wanted)) {
      const question = questionOf(session, name);
      if (question === undefined) return `no question named ${JSON.stringify(name)} on the page.`;
      const expectation = expected(name, question, value, turnCount(one.state));
      if (!expectation.ok) return expectation.error;
      expect[name] = expectation.value;
    }
    cases.push(...casesOf(one, expect));
    return undefined;
  });
  return failed === undefined ? ok(cases) : err(failed);
}

/** What the two pages of a comparison are called in its messages and its report. */
export interface Labels {
  readonly a: string;
  readonly b: string;
}

/**
 * Parse one cases file for two pages at once: a case per page, each holding the expectations for
 * that page's questions.
 *
 * A label may name a question on either page, which is what lets a page that adds a question be
 * compared with one that does not. It is still checked against every page that has the question —
 * a case one page cannot even express is not a paired observation, it is a typo.
 */
export function parseCompareCases(
  text: string,
  a: Session,
  b: Session,
  labels: Labels,
): Parsed<[Case[], Case[]]> {
  const left: Case[] = [];
  const right: Case[] = [];
  const failed = readCases(text, (one) => {
    const expectA: Record<string, Expectation> = {};
    const expectB: Record<string, Expectation> = {};
    for (const [name, value] of Object.entries(one.wanted)) {
      const onA = questionOf(a, name);
      const onB = questionOf(b, name);
      if (onA === undefined && onB === undefined) {
        return `no question named ${JSON.stringify(name)} on either page.`;
      }
      const sides = [
        [onA, expectA, labels.a],
        [onB, expectB, labels.b],
      ] as const;
      for (const [question, into, label] of sides) {
        if (question === undefined) continue;
        const expectation = expected(name, question, value, turnCount(one.state));
        if (!expectation.ok) return `${label}: ${expectation.error}`;
        into[name] = expectation.value;
      }
    }
    left.push(...casesOf(one, expectA));
    right.push(...casesOf(one, expectB));
    return undefined;
  });
  return failed === undefined ? ok([left, right]) : err(failed);
}

/** A line of the cases file that is a case in shape, before its labels meet a page. */
interface RawCase {
  readonly line: number;
  readonly id?: string;
  readonly state: Json;
  readonly wanted: JsonObject;
}

/**
 * Hand every non-blank line to `visit` as a case, stopping at the first line that is not one or
 * that `visit` refuses; the message that comes back already names the line.
 */
function readCases(text: string, visit: (one: RawCase) => string | undefined): string | undefined {
  const lines = text.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] as string).trim();
    if (raw === "") continue;
    const parsed = readCase(raw, i + 1);
    if (!parsed.ok) return `cases line ${i + 1}: ${parsed.error}`;
    const refused = visit(parsed.value);
    if (refused !== undefined) return `cases line ${i + 1}: ${refused}`;
    seen += 1;
  }
  return seen === 0 ? "the cases file holds no cases." : undefined;
}

function readCase(text: string, line: number): Parsed<RawCase> {
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
  return ok(id === undefined ? { line, state, wanted } : { line, id, state, wanted });
}

/**
 * The cases one line becomes: itself, or — when a noul is labelled per turn — one case per prefix
 * of the conversation. A per-turn noul expects `turn >= k` at every prefix; the line's other
 * labels were written about the whole conversation, so they go on the last prefix only. A case
 * left with nothing to score is not sent at all.
 */
function casesOf(one: RawCase, expect: Record<string, Expectation>): Case[] {
  const named = (fields: Omit<Case, "line" | "id">): Case =>
    one.id === undefined
      ? { line: one.line, ...fields }
      : { line: one.line, id: one.id, ...fields };
  const entries = Object.entries(expect);
  if (entries.length === 0) return [];
  const turns = turnsOf(one.state);
  const perTurn = entries.some(([, e]) => e.kind === "noul" && e.byTurn !== undefined);
  if (!perTurn || turns === undefined) return [named({ state: one.state, expect })];
  const out: Case[] = [];
  for (let turn = 1; turn <= turns.length; turn++) {
    const at: Record<string, Expectation> = {};
    for (const [name, e] of entries) {
      if (e.kind === "noul" && e.byTurn !== undefined) {
        at[name] = { kind: "noul", yes: e.byTurn !== null && turn >= e.byTurn, byTurn: e.byTurn };
      } else if (turn === turns.length) {
        at[name] = e;
      }
    }
    if (Object.keys(at).length === 0) continue;
    const state = turnsToJson(turns.slice(0, turn));
    out.push(named({ state, expect: at, turn, turns: turns.length }));
  }
  return out;
}

/** How many turns a state has, when it is a conversation. */
function turnCount(state: Json): number | undefined {
  return turnsOf(state)?.length;
}

function questionOf(session: Session, name: string): Question | undefined {
  return session.questions.find(([n]) => n === name)?.[1];
}

/** Check one expected value against the question it names, and store it the way it is scored. */
function expected(
  name: string,
  question: Question,
  value: Json,
  turns: number | undefined,
): Parsed<Expectation> {
  if (
    question.kind !== "noul" &&
    question.kind !== "raw" &&
    isObject(value) &&
    "by_turn" in value
  ) {
    return err(`by_turn is for a noul, and ${name} is a ${question.kind}.`);
  }
  switch (question.kind) {
    case "noul":
      if (isObject(value)) return byTurn(name, value, turns);
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

/**
 * `{"by_turn": k}`: false before turn `k` of the conversation and true from it on, or never true
 * when `k` is null. It only means something over a conversation, and only for a turn it has.
 */
function byTurn(name: string, value: JsonObject, turns: number | undefined): Parsed<Expectation> {
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "by_turn") {
    return err(
      `${name}: a per-turn expectation is {"by_turn": n}, the turn it becomes true, or null for never; got ${compact(value)}.`,
    );
  }
  if (turns === undefined) {
    return err(`${name} gives by_turn, but the state is not a conversation of turns.`);
  }
  const k = value["by_turn"] as Json;
  if (k === null) return ok({ kind: "noul", yes: false, byTurn: null });
  if (typeof k !== "number" || !Number.isInteger(k) || k < 1 || k > turns) {
    return err(
      `${name} by_turn must be a whole turn from 1 to ${turns}, or null for never; got ${compact(k)}.`,
    );
  }
  return ok({ kind: "noul", yes: false, byTurn: k });
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
export async function run(
  session: Session,
  cases: readonly Case[],
  ask: (session: Session) => Promise<Outcome>,
  concurrency: number,
): Promise<Outcome[]> {
  const [outcomes] = await runLegs([{ session, cases, ask }], concurrency);
  return outcomes ?? [];
}

/** One page's share of a comparison: its session, its cases, and how to ask it. */
export interface Leg {
  readonly session: Session;
  readonly cases: readonly Case[];
  readonly ask: (session: Session) => Promise<Outcome>;
}

/**
 * Both pages of a comparison through one pool of workers: page `a`'s cases first, then `b`'s.
 *
 * One pool rather than one per page, so `--concurrency` still means what it says — that many
 * requests in the air, whichever page they are for.
 */
export async function runCompare(
  a: Leg,
  b: Leg,
  concurrency: number,
): Promise<[Outcome[], Outcome[]]> {
  const [left, right] = await runLegs([a, b], concurrency);
  return [left ?? [], right ?? []];
}

async function runLegs(legs: readonly Leg[], concurrency: number): Promise<Outcome[][]> {
  const outcomes = legs.map((leg) => new Array<Outcome>(leg.cases.length));
  const jobs: Array<[leg: number, at: number]> = [];
  legs.forEach((leg, l) => leg.cases.forEach((_, at) => jobs.push([l, at])));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobs[next++];
      if (job === undefined) return;
      const [l, at] = job;
      const leg = legs[l] as Leg;
      const one = leg.cases[at] as Case;
      const into = outcomes[l] as Outcome[];
      try {
        into[at] = await leg.ask(withState(leg.session, one.state));
      } catch (e) {
        into[at] = { ok: false, error: linesText(errorLines(e)).trim() };
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(concurrency), jobs.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return outcomes;
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
  /** What it was read at: the page's `@threshold`, or the run's threshold when it has none. */
  readonly threshold: number;
  /** Accuracy at that threshold. */
  readonly accuracy: number;
  readonly best: { readonly threshold: number; readonly f1: number };
  readonly sweep: readonly SweepRow[];
  /** When it noticed, for the conversations labelled per turn; absent when none were. */
  readonly latency?: Latency;
}

/** One conversation labelled per turn: the turn it should have said yes, and the turn it did. */
export interface ThreadLatency {
  readonly case: number;
  readonly id?: string;
  /** `by_turn`; `null` when it should never have said yes. */
  readonly expected: number | null;
  /** The first turn at or above the threshold; `null` when there was none. */
  readonly detected: number | null;
  /** `detected − expected`, negative when early; `null` unless both are known. */
  readonly latency: number | null;
}

/** How early or late a noul notices, over the conversations labelled per turn. */
export interface Latency {
  readonly threads: number;
  readonly onTime: number;
  readonly early: number;
  readonly late: number;
  readonly missed: number;
  readonly falseAlarms: number;
  /** Mean latency over the threads that expected a yes and got one; `undefined` when none did. */
  readonly mean: number | undefined;
  readonly cases: readonly ThreadLatency[];
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
  /** The prefix of a per-turn case that failed. */
  readonly turn?: number;
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
  readonly line: number;
  readonly id: string | undefined;
  readonly turn: number | undefined;
  readonly turns: number | undefined;
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
  const { errors, scored } = scoredOf(cases, outcomes);
  const questions: QuestionReport[] = [];
  for (const [name, question] of session.questions) {
    const rows = scored.filter((one) => one.expect[name] !== undefined);
    if (rows.length === 0) continue;
    if (question.kind === "noul") {
      questions.push(noulReport(name, rows, session.thresholdOf(name, options.threshold)));
    } else if (question.kind === "choice") questions.push(choiceReport(name, question, rows));
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

/** Split the outcomes into the cases that can be scored and the ones that are errors. */
function scoredOf(
  cases: readonly Case[],
  outcomes: readonly Outcome[],
): { errors: CaseError[]; scored: Scored[] } {
  const errors: CaseError[] = [];
  const scored: Scored[] = [];
  cases.forEach((one, at) => {
    const outcome = outcomes[at];
    const failed = (message: string): void => {
      const error: CaseError = { case: one.line, message };
      errors.push({
        ...error,
        ...(one.turn === undefined ? {} : { turn: one.turn }),
        ...(one.id === undefined ? {} : { id: one.id }),
      });
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
    scored.push({
      line: one.line,
      id: one.id,
      turn: one.turn,
      turns: one.turns,
      expect: one.expect,
      answers,
      usage: outcome.usage,
    });
  });
  return { errors, scored };
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
  const latency = latencyOf(name, rows, threshold);
  const out: NoulReport = {
    name,
    kind: "noul",
    cases: points.length,
    brier,
    threshold,
    accuracy: chosen.accuracy,
    best: { threshold: best.threshold, f1: best.f1 },
    sweep,
  };
  return latency === undefined ? out : { ...out, latency };
}

/**
 * Detection latency: for each conversation labelled per turn, the first turn the noul said yes,
 * against the turn it should have. A thread with a prefix that errored is left out, because its
 * first yes might be the one that is missing.
 */
function latencyOf(name: string, rows: readonly Scored[], threshold: number): Latency | undefined {
  const threads = new Map<number, Scored[]>();
  for (const row of rows) {
    const expectation = row.expect[name] as Extract<Expectation, { kind: "noul" }>;
    if (expectation.byTurn === undefined || row.turn === undefined) continue;
    const thread = threads.get(row.line) ?? [];
    thread.push(row);
    threads.set(row.line, thread);
  }
  if (threads.size === 0) return undefined;
  const cases: ThreadLatency[] = [];
  let onTime = 0;
  let early = 0;
  let late = 0;
  let missed = 0;
  let falseAlarms = 0;
  const lags: number[] = [];
  for (const [line, thread] of threads) {
    const first = thread[0] as Scored;
    if (thread.length !== first.turns) continue;
    thread.sort((x, y) => (x.turn as number) - (y.turn as number));
    const expected = (first.expect[name] as Extract<Expectation, { kind: "noul" }>).byTurn ?? null;
    const hit = thread.find((row) => (row.answers.get(name) as NoulAnswer).noul >= threshold);
    const detected = hit?.turn ?? null;
    const lag = expected === null || detected === null ? null : detected - expected;
    if (expected === null) {
      if (detected !== null) falseAlarms += 1;
    } else if (lag === null) missed += 1;
    else {
      lags.push(lag);
      if (lag === 0) onTime += 1;
      else if (lag < 0) early += 1;
      else late += 1;
    }
    const base: ThreadLatency = { case: line, expected, detected, latency: lag };
    cases.push(first.id === undefined ? base : { ...base, id: first.id });
  }
  return {
    threads: cases.length,
    onTime,
    early,
    late,
    missed,
    falseAlarms,
    mean: lags.length === 0 ? undefined : mean(lags),
    cases,
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
function gate(
  points: ReadonlyArray<{ confidence: number; right: boolean }>,
  cuts: readonly number[] = CUTS,
): GateRow[] {
  return cuts.map((confidence) => {
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
    if (question.kind === "noul") out.push(...sweepLines(question));
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
function sweepLines(question: NoulReport): Line[] {
  const threshold = question.threshold;
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
  if (question.latency !== undefined) out.push(latencyLine(question.latency));
  return out;
}

/** The one line that says when a noul noticed, over the conversations labelled per turn. */
function latencyLine(latency: Latency): Line {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  const mean =
    latency.mean === undefined
      ? "·"
      : `${signed(latency.mean)} turn${Math.abs(latency.mean) === 1 ? "" : "s"}`;
  return line([
    span("    "),
    dim("by turn  "),
    span(
      [
        plural(latency.threads, "thread"),
        `${latency.onTime} on time`,
        `${latency.early} early`,
        `${latency.late} late`,
        `${latency.missed} missed`,
        plural(latency.falseAlarms, "false alarm"),
        `mean latency ${mean}`,
      ].join(" · "),
    ),
  ]);
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

function errorCaseLines(failed: CaseError, prefix = ""): Line[] {
  const name = `${prefix}${caseName(failed.case, failed.id, failed.turn)}`;
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
      if (failed.turn !== undefined) out["turn"] = failed.turn;
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
      threshold: question.threshold,
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
      ...(question.latency === undefined ? {} : { latency: latencyJson(question.latency) }),
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

function latencyJson(latency: Latency): Json {
  return {
    threads: latency.threads,
    onTime: latency.onTime,
    early: latency.early,
    late: latency.late,
    missed: latency.missed,
    falseAlarms: latency.falseAlarms,
    mean: latency.mean ?? null,
    cases: latency.cases.map((one) => {
      const out: JsonObject = { case: one.case };
      if (one.id !== undefined) out["id"] = one.id;
      out["expected"] = one.expected;
      out["detected"] = one.detected;
      out["latency"] = one.latency;
      return out;
    }),
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

// ---- two pages over the same cases ----------------------------------------------------------

/** One page's run, as a comparison needs it. */
export interface Side {
  /** What the page is called: the path it was read from. */
  readonly label: string;
  readonly session: Session;
  readonly cases: readonly Case[];
  readonly outcomes: readonly Outcome[];
  readonly model: string;
}

/** What the exact McNemar test made of the discordant pairs. */
export type Verdict = "too few" | "better" | "worse" | "same";

export interface McNemar {
  /** Cases one page got right and the other wrong: `fixed + broke`. */
  readonly discordant: number;
  /** Two-sided exact p-value; 1 when there is nothing to test. */
  readonly p: number;
  readonly verdict: Verdict;
}

/** A case the two pages answered differently. */
export interface Flip {
  readonly case: number;
  readonly turn?: number;
  readonly id?: string;
  /** What the case expects, and what each page predicted, in the question's own terms. */
  readonly expected: Json;
  readonly a: Json;
  readonly b: Json;
  /** `fixed`: `b` put right what `a` got wrong. `broke`: the reverse. `changed`: both wrong. */
  readonly status: "fixed" | "broke" | "changed";
}

/** One metric on both sides, and what moved. */
export interface Metric {
  /** The JSON key. */
  readonly key: string;
  /** The row name in the text report. */
  readonly label: string;
  readonly a: number;
  readonly b: number;
  /** Whether a delta means anything: a threshold is a setting, not a result. */
  readonly delta: boolean;
}

/** A question both pages ask the same way, measured on the cases both pages scored. */
export interface Shared {
  readonly name: string;
  readonly kind: "noul" | "choice" | "score";
  readonly paired: number;
  readonly metrics: readonly Metric[];
  readonly fixed: number;
  readonly broke: number;
  readonly changed: number;
  readonly mcnemar: McNemar;
  readonly flips: readonly Flip[];
}

/** Everything a comparison found, with the numbers unrounded. */
export interface Comparison {
  readonly a: { readonly label: string; readonly report: Report };
  readonly b: { readonly label: string; readonly report: Report };
  readonly questions: readonly Shared[];
  readonly onlyA: readonly string[];
  readonly onlyB: readonly string[];
  readonly mismatched: ReadonlyArray<{ name: string; a: string; b: string }>;
  readonly unpaired: readonly string[];
  /** Distinct cases across both pages. */
  readonly cases: number;
  readonly usage: ReportUsage;
}

/** The level McNemar's test is read at. Not a flag: a comparison should mean the same everywhere. */
export const ALPHA = 0.05;

/** Below this many discordant pairs no two-sided exact p can reach {@link ALPHA}: 2 / 2^5 > 0.05. */
export const MIN_DISCORDANT = 6;

/**
 * The exact McNemar test on the discordant pairs of a paired comparison.
 *
 * Under "no difference" each discordant pair is a fair coin, so the p-value is a binomial tail.
 * It is summed in log space because `2^n` stops being a number long before a cases file stops
 * being a reasonable size.
 */
export function mcnemar(fixed: number, broke: number): McNemar {
  const n = fixed + broke;
  let p = 1;
  if (n > 0) {
    const low = Math.min(fixed, broke);
    const ln2n = n * Math.LN2;
    let lnChoose = 0;
    let tail = Math.exp(-ln2n);
    for (let k = 1; k <= low; k++) {
      lnChoose += Math.log(n - k + 1) - Math.log(k);
      tail += Math.exp(lnChoose - ln2n);
    }
    p = Math.min(1, 2 * tail);
  }
  const verdict: Verdict =
    n < MIN_DISCORDANT
      ? "too few"
      : p < ALPHA && fixed > broke
        ? "better"
        : p < ALPHA && broke > fixed
          ? "worse"
          : "same";
  return { discordant: n, p, verdict };
}

/**
 * Put two runs of the same cases side by side.
 *
 * Only the cases both pages scored count, so each delta is measured on the same states: a page
 * that errored on the hard cases must not look better for it. The full reports, over everything
 * each page scored, travel along for the JSON.
 */
export function compare(
  a: Side,
  b: Side,
  options: { threshold: number; rates: Rates | undefined },
): Comparison {
  const reportOf = (side: Side): Report =>
    report(side.session, side.cases, side.outcomes, {
      model: side.model,
      threshold: options.threshold,
      rates: options.rates,
    });
  const left = scoredOf(a.cases, a.outcomes).scored;
  const right = new Map(scoredOf(b.cases, b.outcomes).scored.map((one) => [keyOf(one), one]));

  const kindsB = new Map(b.session.questions.map(([name, q]) => [name, q.kind] as const));
  const namesA = new Set(a.session.questions.map(([name]) => name));
  const questions: Shared[] = [];
  const mismatched: Array<{ name: string; a: string; b: string }> = [];
  const unpaired: string[] = [];
  for (const [name, question] of a.session.questions) {
    const other = kindsB.get(name);
    if (other === undefined) continue;
    if (other !== question.kind || question.kind === "raw") {
      if (other !== question.kind) mismatched.push({ name, a: question.kind, b: other });
      continue;
    }
    const pairs: Array<[Scored, Scored]> = [];
    for (const one of left) {
      const twin = right.get(keyOf(one));
      if (one.expect[name] !== undefined && twin?.expect[name] !== undefined) {
        pairs.push([one, twin]);
      }
    }
    if (pairs.length === 0) {
      // A question nobody labelled is left out, as eval leaves it out; one that was labelled and
      // still has no pair is worth saying so about.
      const labelled = [...a.cases, ...b.cases].some((one) => one.expect[name] !== undefined);
      if (labelled) unpaired.push(name);
      continue;
    }
    questions.push(
      shared(
        name,
        question.kind,
        pairs,
        a.session.thresholdOf(name, options.threshold),
        b.session.thresholdOf(name, options.threshold),
      ),
    );
  }

  const keys = new Set([...a.cases, ...b.cases].map((one) => keyOf(one)));
  const reportA = reportOf(a);
  const reportB = reportOf(b);
  return {
    a: { label: a.label, report: reportA },
    b: { label: b.label, report: reportB },
    questions,
    onlyA: a.session.questions.map(([name]) => name).filter((name) => !kindsB.has(name)),
    onlyB: b.session.questions.map(([name]) => name).filter((name) => !namesA.has(name)),
    mismatched,
    unpaired,
    cases: keys.size,
    usage: sumUsage(reportA.usage, reportB.usage, options.rates),
  };
}

/** Which case a scored row came from, so the same case can be found on the other page. */
function keyOf(one: { readonly line: number; readonly turn?: number | undefined }): string {
  return one.turn === undefined ? String(one.line) : `${one.line}:${one.turn}`;
}

function sumUsage(a: ReportUsage, b: ReportUsage, rates: Rates | undefined): ReportUsage {
  const inputTokens = a.inputTokens + b.inputTokens;
  const outputTokens = a.outputTokens + b.outputTokens;
  return {
    inputTokens,
    outputTokens,
    estimated: a.estimated || b.estimated,
    cost: rates === undefined ? undefined : cost.price(inputTokens, outputTokens, rates),
  };
}

/** One paired observation: what each side predicted, and whether it was right. */
interface Pair {
  readonly one: Scored;
  readonly expected: Json;
  readonly a: Json;
  readonly b: Json;
  readonly rightA: boolean;
  readonly rightB: boolean;
}

function shared(
  name: string,
  kind: "noul" | "choice" | "score",
  pairs: ReadonlyArray<[Scored, Scored]>,
  thresholdA: number,
  thresholdB: number,
): Shared {
  let metrics: Metric[];
  let observed: Pair[];
  if (kind === "noul") {
    const points = (side: 0 | 1): Array<{ p: number; yes: boolean }> =>
      pairs.map((pair) => ({
        p: (pair[side].answers.get(name) as NoulAnswer).noul,
        yes: (pair[side].expect[name] as Extract<Expectation, { kind: "noul" }>).yes,
      }));
    const left = points(0);
    const right = points(1);
    const brier = (list: typeof left): number =>
      mean(list.map(({ p, yes }) => (p - (yes ? 1 : 0)) ** 2));
    const rowA = sweepRow(left, thresholdA);
    const rowB = sweepRow(right, thresholdB);
    metrics = [
      { key: "threshold", label: "threshold", a: thresholdA, b: thresholdB, delta: false },
      { key: "brier", label: "brier", a: brier(left), b: brier(right), delta: true },
      { key: "accuracy", label: "accuracy", a: rowA.accuracy, b: rowB.accuracy, delta: true },
      { key: "f1", label: "f1", a: rowA.f1, b: rowB.f1, delta: true },
    ];
    observed = pairs.map(([one], at) => {
      const yes = (left[at] as { yes: boolean }).yes;
      const predA = (left[at] as { p: number }).p >= thresholdA;
      const predB = (right[at] as { p: number }).p >= thresholdB;
      return {
        one,
        expected: yes,
        a: predA,
        b: predB,
        rightA: predA === yes,
        rightB: predB === yes,
      };
    });
  } else if (kind === "choice") {
    observed = pairs.map(([one, twin]) => {
      const expected = (one.expect[name] as Extract<Expectation, { kind: "choice" }>).label;
      const a = (one.answers.get(name) as ChoiceAnswer).choice;
      const b = (twin.answers.get(name) as ChoiceAnswer).choice;
      return { one, expected, a, b, rightA: a === expected, rightB: b === expected };
    });
    metrics = [
      {
        key: "accuracy",
        label: "accuracy",
        a: mean(observed.map((pair) => (pair.rightA ? 1 : 0))),
        b: mean(observed.map((pair) => (pair.rightB ? 1 : 0))),
        delta: true,
      },
    ];
  } else {
    observed = pairs.map(([one, twin]) => {
      const expected = (one.expect[name] as Extract<Expectation, { kind: "score" }>).level;
      const a = roundedLevel(one.answers.get(name) as ScoreAnswer);
      const b = roundedLevel(twin.answers.get(name) as ScoreAnswer);
      return { one, expected, a, b, rightA: a === expected, rightB: b === expected };
    });
    const off = (pair: Pair, side: "a" | "b"): number =>
      Math.abs((pair[side] as number) - (pair.expected as number));
    const both = (f: (pair: Pair, side: "a" | "b") => number): { a: number; b: number } => ({
      a: mean(observed.map((pair) => f(pair, "a"))),
      b: mean(observed.map((pair) => f(pair, "b"))),
    });
    metrics = [
      { key: "exact", label: "exact", ...both((p, s) => (off(p, s) === 0 ? 1 : 0)), delta: true },
      {
        key: "withinOne",
        label: "within one",
        ...both((p, s) => (off(p, s) <= 1 ? 1 : 0)),
        delta: true,
      },
      { key: "mae", label: "mae", ...both(off), delta: true },
    ];
  }

  const flips: Flip[] = [];
  let fixed = 0;
  let broke = 0;
  let changed = 0;
  for (const pair of observed) {
    if (pair.a === pair.b) continue;
    const status: Flip["status"] =
      !pair.rightA && pair.rightB ? "fixed" : pair.rightA ? "broke" : "changed";
    if (status === "fixed") fixed += 1;
    else if (status === "broke") broke += 1;
    else changed += 1;
    flips.push({
      case: pair.one.line,
      ...(pair.one.turn === undefined ? {} : { turn: pair.one.turn }),
      ...(pair.one.id === undefined ? {} : { id: pair.one.id }),
      expected: pair.expected,
      a: pair.a,
      b: pair.b,
      status,
    });
  }
  return {
    name,
    kind,
    paired: pairs.length,
    metrics,
    fixed,
    broke,
    changed,
    mcnemar: mcnemar(fixed, broke),
    flips,
  };
}

/** The questions `b` is significantly worse at, for `--fail-on-regression`. */
export function regressions(comparison: Comparison): Shared[] {
  return comparison.questions.filter((q) => q.mcnemar.verdict === "worse");
}

/** How many flipped cases the text report lists per question before it points at the JSON. */
const FLIPS_SHOWN = 10;

/** The comparison as lines: a legend, a block per shared question, what could not be compared. */
export function compareLines(comparison: Comparison): Line[] {
  const out: Line[] = [];
  const sides = [
    ["a", comparison.a],
    ["b", comparison.b],
  ] as const;
  const labelWidth = Math.max(...sides.map(([, side]) => [...side.label].length));
  for (const [letter, side] of sides) {
    const n = side.report.cases;
    out.push(
      line([
        span("  "),
        bold(letter),
        span("  "),
        span(padEnd(side.label, labelWidth)),
        span("  "),
        dim(`${side.report.model} · ${n} case${n === 1 ? "" : "s"}`),
      ]),
    );
  }

  const width = comparison.questions.reduce((wide, q) => Math.max(wide, [...q.name].length), 0);
  for (const question of comparison.questions) {
    out.push(blankLine());
    out.push(...sharedLines(question, width));
  }

  const lists: Line[] = [];
  if (comparison.onlyA.length > 0) {
    lists.push(line([span("  "), dim("only in a: "), span(comparison.onlyA.join(", "))]));
  }
  if (comparison.onlyB.length > 0) {
    lists.push(line([span("  "), dim("only in b: "), span(comparison.onlyB.join(", "))]));
  }
  for (const odd of comparison.mismatched) {
    lists.push(
      line([
        span("  "),
        dim("mismatched: "),
        span(`${odd.name} is a ${odd.a} in a and a ${odd.b} in b`),
      ]),
    );
  }
  for (const name of comparison.unpaired) {
    lists.push(
      line([
        span("  "),
        dim("unpaired: "),
        span(`${name} — no case was scored for it on both pages`),
      ]),
    );
  }
  if (lists.length > 0) out.push(blankLine(), ...lists);

  const failures: Line[] = [];
  for (const [letter, side] of sides) {
    for (const failed of side.report.errors) failures.push(...errorCaseLines(failed, `${letter} `));
  }
  if (failures.length > 0) out.push(blankLine(), ...failures);

  out.push(blankLine());
  const tally = (report: Report): string => {
    const errors = report.errors.length;
    return `${report.answered} answered, ${errors} error${errors === 1 ? "" : "s"}`;
  };
  out.push(
    line([
      span("  "),
      bold(`${comparison.cases} case${comparison.cases === 1 ? "" : "s"}`),
      dim(` · a ${tally(comparison.a.report)} · b ${tally(comparison.b.report)}`),
    ]),
  );
  out.push(usageLine(comparison.usage));
  return out;
}

function sharedLines(question: Shared, width: number): Line[] {
  const n = question.paired;
  const out: Line[] = [
    line([
      span("  "),
      bold(padEnd(question.name, width)),
      span("  "),
      span(padEnd(question.kind, 8), { fg: colorFor(question.kind) }),
      dim(`${n} paired case${n === 1 ? "" : "s"}`),
    ]),
    line([span(`    ${" ".repeat(14)}`), dim(`${padEnd("a", 8)}${padEnd("b", 8)}Δ`)]),
  ];
  for (const metric of question.metrics) {
    const cells = [fixed(metric.a), fixed(metric.b)];
    if (metric.delta) cells.push(signed(metric.b - metric.a));
    out.push(
      line([
        span("    "),
        span(padEnd(metric.label, 14)),
        span(
          cells
            .map((cell) => padEnd(cell, 8))
            .join("")
            .trimEnd(),
        ),
      ]),
    );
  }
  out.push(
    line([
      span("    "),
      span(`${question.fixed} fixed · ${question.broke} broke · ${question.changed} changed`),
    ]),
  );
  const verdict = question.mcnemar.verdict;
  out.push(
    line([
      span("    "),
      verdict === "better" || verdict === "worse"
        ? span(mcnemarText(question.mcnemar), { fg: verdict === "better" ? SCORE : BAD })
        : dim(mcnemarText(question.mcnemar)),
    ]),
  );

  const shown = question.flips.slice(0, FLIPS_SHOWN);
  const names = shown.map((flip) => caseName(flip.case, flip.id, flip.turn));
  const moves = shown.map(
    (flip) => `${reading(question.kind, flip.a)} → ${reading(question.kind, flip.b)}`,
  );
  const nameWidth = names.reduce((wide, name) => Math.max(wide, [...name].length), 0);
  const moveWidth = moves.reduce((wide, move) => Math.max(wide, [...move].length), 0);
  shown.forEach((flip, at) => {
    out.push(
      line([
        span("    "),
        span(padEnd(names[at] as string, nameWidth)),
        span("   "),
        span(padEnd(moves[at] as string, moveWidth)),
        span("   "),
        span(flip.status, {
          fg: flip.status === "fixed" ? SCORE : flip.status === "broke" ? BAD : DIM,
        }),
      ]),
    );
  });
  const more = question.flips.length - shown.length;
  if (more > 0)
    out.push(line([span("    "), dim(`… ${more} more flipped; --json lists them all`)]));
  return out;
}

/** The significance line, which says in words what the p-value allows and what it does not. */
function mcnemarText(test: McNemar): string {
  if (test.discordant === 0) return "McNemar: no discordant pairs, nothing to test";
  if (test.verdict === "too few") {
    return `McNemar: too few discordant pairs to call (${test.discordant}; ${MIN_DISCORDANT} are needed for p < ${ALPHA})`;
  }
  const head = `McNemar p ${test.p.toFixed(3)} over ${test.discordant} discordant pairs: `;
  if (test.verdict === "better") return `${head}b is significantly better`;
  if (test.verdict === "worse") return `${head}b is significantly worse`;
  return `${head}no significant difference`;
}

/** A prediction as the report says it: yes or no, a label, a level. */
function reading(kind: "noul" | "choice" | "score", value: Json): string {
  if (kind === "noul") return value === true ? "yes" : "no";
  if (kind === "score") return `level ${compact(value)}`;
  return typeof value === "string" ? value : compact(value);
}

/**
 * `case 7 turn 2 (t-007)`: the line in the cases file, the prefix of a case labelled per turn, and
 * the id when the case has one.
 */
function caseName(line: number, id: string | undefined, turn?: number): string {
  return `case ${line}${turn === undefined ? "" : ` turn ${turn}`}${id === undefined ? "" : ` (${id})`}`;
}

/** A change, signed either way, so a regression reads as one. */
function signed(n: number): string {
  const text = n.toFixed(2);
  if (text === "-0.00") return "+0.00";
  return text.startsWith("-") ? text : `+${text}`;
}

/** The comparison as JSON, ready for `pretty`: both reports whole, and what moved between them. */
export function compareJson(comparison: Comparison): Json {
  const side = (letter: "a" | "b"): Json => {
    const one = comparison[letter];
    return { page: one.label, ...(reportJson(one.report) as JsonObject) };
  };
  const questions: JsonObject = {};
  for (const question of comparison.questions) {
    const pick = (f: (metric: Metric) => number | undefined): JsonObject => {
      const out: JsonObject = {};
      for (const metric of question.metrics) {
        const value = f(metric);
        if (value !== undefined) out[metric.key] = value;
      }
      return out;
    };
    questions[question.name] = {
      kind: question.kind,
      paired: question.paired,
      a: pick((metric) => metric.a),
      b: pick((metric) => metric.b),
      delta: pick((metric) => (metric.delta ? metric.b - metric.a : undefined)),
      fixed: question.fixed,
      broke: question.broke,
      changed: question.changed,
      mcnemar: {
        discordant: question.mcnemar.discordant,
        p: question.mcnemar.p,
        verdict: question.mcnemar.verdict,
      },
      flips: question.flips.map((flip) => {
        const out: JsonObject = { case: flip.case };
        if (flip.turn !== undefined) out["turn"] = flip.turn;
        if (flip.id !== undefined) out["id"] = flip.id;
        out["expected"] = flip.expected;
        out["a"] = flip.a;
        out["b"] = flip.b;
        out["status"] = flip.status;
        return out;
      }),
    };
  }
  const usage: JsonObject = {
    inputTokens: comparison.usage.inputTokens,
    outputTokens: comparison.usage.outputTokens,
    estimated: comparison.usage.estimated,
  };
  if (comparison.usage.cost !== undefined) usage["cost"] = comparison.usage.cost.total;
  return {
    a: side("a"),
    b: side("b"),
    questions,
    onlyA: comparison.onlyA.slice(),
    onlyB: comparison.onlyB.slice(),
    mismatched: comparison.mismatched.map((odd) => ({ name: odd.name, a: odd.a, b: odd.b })),
    unpaired: comparison.unpaired.slice(),
    regressions: regressions(comparison).map((q) => q.name),
    usage,
  };
}

// ---- writing the bars back ------------------------------------------------------------------

/** The accuracy a choice's or score's bar has to reach when `--target-accuracy` is not given. */
export const DEFAULT_TARGET = 0.9;

/**
 * The confidence bars calibration tries, `k / 20` for `k` from 0 to 19: finer than the report's
 * gate, and computed by division so each prints as the short decimal it is.
 */
export const CALIBRATION_CUTS: readonly number[] = Array.from({ length: 20 }, (_, k) => k / 20);

/** What calibration made of one question: the bar it found, or why it left the question alone. */
export interface CalibratedQuestion {
  readonly name: string;
  readonly kind: "noul" | "choice" | "score";
  /** The new bar; `undefined` when the question is left alone. */
  readonly bar: number | undefined;
  /** The bar the page had before. */
  readonly was: number | undefined;
  /** For a noul: the F1 at the new threshold. */
  readonly f1?: number;
  /** For a choice or a score: the accuracy over the cases that clear the new bar, and how many do. */
  readonly accuracy?: number;
  readonly coverage?: number;
  /** Why the question was left alone. */
  readonly reason?: string;
}

export interface Calibration {
  readonly target: number;
  readonly questions: readonly CalibratedQuestion[];
  /** Only the bars that changed: what `sketch.setBars` has to write. */
  readonly changed: ReadonlyMap<string, number>;
}

/**
 * The bars a run supports, one per scored question.
 *
 * A noul gets the threshold with the best F1, which the report has already found. A choice or a
 * score gets the lowest confidence bar at which the answers it lets through are right at least
 * `target` of the time: the lowest, because every step up sends more of the work to a person.
 */
export function calibrate(
  session: Session,
  cases: readonly Case[],
  outcomes: readonly Outcome[],
  scoredReport: Report,
  target: number,
): Calibration {
  const { scored } = scoredOf(cases, outcomes);
  const questions: CalibratedQuestion[] = [];
  const changed = new Map<string, number>();
  for (const question of scoredReport.questions) {
    const was = session.bar(question.name);
    let found: CalibratedQuestion;
    if (question.kind === "noul") {
      found =
        question.best.f1 > 0
          ? { ...base(question, was), bar: question.best.threshold, f1: question.best.f1 }
          : { ...base(question, was), reason: "no threshold gives an F1 above 0" };
    } else {
      const name = question.name;
      const points = scored
        .filter((one) => one.expect[name] !== undefined)
        .map((one) => {
          const answer = one.answers.get(name) as ChoiceAnswer | ScoreAnswer;
          const expectation = one.expect[name] as Expectation;
          const right =
            answer.type === "choice"
              ? answer.choice === (expectation as Extract<Expectation, { kind: "choice" }>).label
              : roundedLevel(answer) ===
                (expectation as Extract<Expectation, { kind: "score" }>).level;
          return { confidence: answer.confidence, right };
        });
      const rows = gate(points, CALIBRATION_CUTS);
      const reached = rows.find((row) => row.accuracy !== undefined && row.accuracy >= target);
      if (reached !== undefined) {
        found = {
          ...base(question, was),
          bar: reached.confidence,
          accuracy: reached.accuracy as number,
          coverage: reached.coverage,
        };
      } else {
        let best: GateRow | undefined;
        for (const row of rows) {
          if (
            row.accuracy !== undefined &&
            (best === undefined || row.accuracy > (best.accuracy as number))
          ) {
            best = row;
          }
        }
        const reason =
          best === undefined
            ? `no confidence bar reaches accuracy ${fixed(target)}`
            : `no confidence bar reaches accuracy ${fixed(target)} (best ${fixed(best.accuracy as number)} at ${fixed(best.confidence)})`;
        found = { ...base(question, was), reason };
      }
    }
    questions.push(found);
    if (found.bar !== undefined && found.bar !== was) changed.set(found.name, found.bar);
  }
  return { target, questions, changed };
}

/** Why a run with errors writes nothing back: the bars would be fitted to the cases that worked. */
export function notCalibrating(errors: number): string {
  return `not calibrating: ${errors} case${errors === 1 ? " came" : "s came"} back with errors, so the numbers are incomplete.`;
}

function base(
  question: QuestionReport,
  was: number | undefined,
): { name: string; kind: QuestionReport["kind"]; bar: undefined; was: number | undefined } {
  return { name: question.name, kind: question.kind, bar: undefined, was };
}

/** The directive a question's bar is written with. */
function directiveOf(kind: CalibratedQuestion["kind"]): string {
  return kind === "noul" ? "@threshold" : "@confidence";
}

/**
 * What calibration changed, as lines for under the report: one per question, the new directive as
 * it now reads on the page, what it replaced, and the evidence for it.
 */
export function calibrationLines(calibration: Calibration, page: string): Line[] {
  const out: Line[] = [
    line([span("  "), bold("calibration"), dim(`  target accuracy ${fixed(calibration.target)}`)]),
  ];
  const width = calibration.questions.reduce((wide, q) => Math.max(wide, [...q.name].length), 0);
  for (const question of calibration.questions) {
    const spans = [span("    "), bold(padEnd(question.name, width)), span("  ")];
    if (question.bar === undefined) {
      spans.push(dim(padEnd("left alone", 19)), dim(question.reason ?? ""));
    } else {
      const was =
        question.was === question.bar
          ? "unchanged"
          : `was ${question.was === undefined ? "none" : String(question.was)}`;
      const evidence =
        question.kind === "noul"
          ? `f1 ${fixed(question.f1 ?? 0)}`
          : `accuracy ${fixed(question.accuracy ?? 0)} over ${fixed(question.coverage ?? 0)} of cases`;
      spans.push(
        span(padEnd(`${directiveOf(question.kind)} ${String(question.bar)}`, 19), {
          fg: colorFor(question.kind),
        }),
        dim(padEnd(was, 11)),
        span(evidence),
      );
    }
    out.push(line(spans));
  }
  const n = calibration.changed.size;
  out.push(
    line([
      span("  "),
      n === 0
        ? dim(`nothing to write: ${page} already holds these bars`)
        : span(`wrote ${n} bar${n === 1 ? "" : "s"} to ${page}`),
    ]),
  );
  return out;
}

/** The calibration as JSON, for the report's `calibration` key. */
export function calibrationJson(calibration: Calibration, page: string): JsonObject {
  const questions: JsonObject = {};
  for (const question of calibration.questions) {
    const out: JsonObject = {
      kind: question.kind,
      bar: question.bar ?? null,
      was: question.was ?? null,
    };
    if (question.f1 !== undefined) out["f1"] = question.f1;
    if (question.accuracy !== undefined) out["accuracy"] = question.accuracy;
    if (question.coverage !== undefined) out["coverage"] = question.coverage;
    if (question.reason !== undefined) out["reason"] = question.reason;
    questions[question.name] = out;
  }
  return {
    page,
    target: calibration.target,
    written: calibration.changed.size > 0,
    questions,
  };
}
