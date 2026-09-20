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
import type { Question } from "../typesafe/questions.js";
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
