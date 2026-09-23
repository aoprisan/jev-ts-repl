/**
 * Typed questions: noul, choice and score.
 *
 * Instructions, option descriptions and score levels accept any JSON value (a string, or an
 * object/array for structured rubrics), per the API's "advanced structure" support.
 */

import type { Json, JsonObject } from "../json.js";
import { isObject } from "../json.js";
import { InvalidRequestError } from "./errors.js";

/** What a yes (`true`) and a no (`false`) mean for a {@link NoulQuestion}. */
export interface NoulCriteria {
  yes?: Json;
  no?: Json;
}

/** A yes/no question; the answer is the probability of "yes". */
export interface NoulQuestion {
  readonly kind: "noul";
  readonly instructions?: Json;
  readonly criteria?: NoulCriteria;
}

/** One option of a {@link ChoiceQuestion}: a label and its description (`null` when undescribed). */
export type ChoiceOption<L extends string = string> = readonly [label: L, description: Json | null];

/**
 * Pick one option from a set you define. `L` is the union of its labels when they were written
 * out literally, so a {@link rubric} can type the answer's `choice` as one of them.
 */
export interface ChoiceQuestion<L extends string = string> {
  readonly kind: "choice";
  readonly instructions?: Json;
  /** Options in the order they were added; answers report every label. */
  readonly options: readonly ChoiceOption<L>[];
}

/** Rate the state along ordered levels; the answer is a probability-weighted level index. */
export interface ScoreQuestion {
  readonly kind: "score";
  readonly instructions?: Json;
  /** Ordered level descriptions; level `i` is index `i`. */
  readonly levels: readonly Json[];
}

/** A hand-built JSON question object, for fields this SDK version does not model yet. */
export interface RawQuestion {
  readonly kind: "raw";
  readonly value: Json;
}

/** Any question. */
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion | RawQuestion;

/** Named questions, in the order they will be sent. Answers come back under the same names. */
export type Questions =
  Readonly<Record<string, Question>> | ReadonlyArray<readonly [string, Question]>;

/** A yes/no question. `criteria` sharpens it: what a yes requires, what a no looks like. */
export function noul(instructions?: Json, criteria?: NoulCriteria): NoulQuestion {
  const q: { kind: "noul"; instructions?: Json; criteria?: NoulCriteria } = { kind: "noul" };
  if (instructions !== undefined) q.instructions = instructions;
  const yes = criteria?.yes;
  const no = criteria?.no;
  if (yes !== undefined || no !== undefined) {
    q.criteria = {};
    if (yes !== undefined) q.criteria.yes = yes;
    if (no !== undefined) q.criteria.no = no;
  }
  return q;
}

/**
 * A choice between labels. Options are given as `{label: description}` (use `null` for an
 * undescribed label) or as ordered `[label, description]` pairs.
 */
export function choice<const L extends string = string>(
  instructions: Json,
  options: Readonly<Record<L, Json | null>> | readonly ChoiceOption<L>[] = [],
): ChoiceQuestion<L> {
  const pairs: ChoiceOption<L>[] = Array.isArray(options)
    ? (options as readonly ChoiceOption<L>[]).map(([label, desc]) => [label, desc] as const)
    : (Object.entries(options) as Array<[L, Json | null]>).map(
        ([label, desc]) => [label, desc] as const,
      );
  return { kind: "choice", instructions, options: pairs };
}

/** A score over ordered levels, lowest first. */
export function score(instructions: Json, levels: readonly Json[]): ScoreQuestion {
  return { kind: "score", instructions, levels };
}

/** A question object sent as it is; it needs a non-empty string `type`. */
export function raw(value: Json): RawQuestion {
  return { kind: "raw", value };
}

/** Add or replace an option, keeping insertion order. */
export function withOption(
  q: ChoiceQuestion,
  label: string,
  description: Json | null,
): ChoiceQuestion {
  const options = q.options.slice();
  const at = options.findIndex(([l]) => l === label);
  if (at >= 0) options[at] = [label, description];
  else options.push([label, description]);
  return { ...q, options };
}

/** The question as it goes on the wire. */
export function questionToJson(q: Question): Json {
  switch (q.kind) {
    case "noul": {
      const out: JsonObject = { type: "noul" };
      if (q.instructions !== undefined) out["instructions"] = q.instructions;
      if (q.criteria) {
        const criteria: JsonObject = {};
        if (q.criteria.yes !== undefined) criteria["true"] = q.criteria.yes;
        if (q.criteria.no !== undefined) criteria["false"] = q.criteria.no;
        if (Object.keys(criteria).length > 0) out["criteria"] = criteria;
      }
      return out;
    }
    case "choice": {
      const out: JsonObject = { type: "choice" };
      if (q.instructions !== undefined) out["instructions"] = q.instructions;
      const criteria: JsonObject = {};
      for (const [label, desc] of q.options) criteria[label] = desc;
      out["criteria"] = criteria;
      return out;
    }
    case "score": {
      const out: JsonObject = { type: "score" };
      if (q.instructions !== undefined) out["instructions"] = q.instructions;
      out["criteria"] = q.levels.slice();
      return out;
    }
    case "raw":
      return q.value;
  }
}

/** The wire `type` tag: the question's kind, or whatever a raw question declares. */
export function questionType(q: Question): string {
  if (q.kind !== "raw") return q.kind;
  const v = q.value;
  if (isObject(v) && typeof v["type"] === "string") return v["type"];
  return "raw";
}

/** Map a wire question back to a typed one; anything unfamiliar stays a {@link RawQuestion}. */
export function questionFromJson(v: Json): Question {
  if (!isObject(v)) return raw(v);
  const instructions = v["instructions"];
  const criteria = v["criteria"];
  switch (v["type"]) {
    case "noul": {
      const c: NoulCriteria = {};
      if (isObject(criteria)) {
        if (criteria["true"] !== undefined) c.yes = criteria["true"];
        if (criteria["false"] !== undefined) c.no = criteria["false"];
      }
      return noul(instructions, c);
    }
    case "choice": {
      const options: ChoiceOption[] = isObject(criteria)
        ? Object.entries(criteria).map(([label, desc]) => [label, desc] as const)
        : [];
      return { kind: "choice", instructions: instructions ?? null, options };
    }
    case "score":
      return {
        kind: "score",
        instructions: instructions ?? null,
        levels: Array.isArray(criteria) ? criteria : [],
      };
    default:
      return raw(v);
  }
}

/** Named questions as ordered pairs, whichever shape they were given in. */
export function questionEntries(questions: Questions): Array<readonly [string, Question]> {
  return Array.isArray(questions)
    ? (questions as ReadonlyArray<readonly [string, Question]>).slice()
    : Object.entries(questions as Record<string, Question>);
}

/** The `questions` object of the request body, in order. */
export function questionsToJson(questions: Questions): JsonObject {
  const out: JsonObject = {};
  for (const [name, q] of questionEntries(questions)) out[name] = questionToJson(q);
  return out;
}

/** Reject what the other SDKs reject locally; everything else is left to server validation. */
export function validateQuestions(questions: Questions): void {
  const entries = questionEntries(questions);
  if (entries.length === 0) {
    throw new InvalidRequestError("At least one question is required.");
  }
  for (const [name, q] of entries) {
    if (q.kind === "score" && q.levels.length === 0) throw emptyScore(name);
    if (q.kind === "choice" && q.options.length === 0) throw emptyChoice(name);
    if (q.kind === "raw") validateRaw(name, q.value);
  }
}

function emptyScore(name: string): InvalidRequestError {
  return new InvalidRequestError(
    `Score question "${name}" has no criteria; at least one score is required.`,
  );
}

function emptyChoice(name: string): InvalidRequestError {
  return new InvalidRequestError(
    `Choice question "${name}" has no criteria; at least one option is required.`,
  );
}

function validateRaw(name: string, v: Json): void {
  const type = isObject(v) ? v["type"] : undefined;
  if (typeof type !== "string" || type === "") {
    throw new InvalidRequestError(
      `Question "${name}" must be a question object or a JSON object with a nonempty string "type".`,
    );
  }
  if (type !== "choice" && type !== "score") return;
  const criteria = (v as JsonObject)["criteria"];
  if (criteria === undefined) {
    throw new InvalidRequestError(`Question "${name}" requires "criteria".`);
  }
  const empty =
    criteria === null ||
    criteria === false ||
    criteria === 0 ||
    criteria === "" ||
    (Array.isArray(criteria) && criteria.length === 0) ||
    (isObject(criteria) && Object.keys(criteria).length === 0);
  if (empty) throw type === "score" ? emptyScore(name) : emptyChoice(name);
}
