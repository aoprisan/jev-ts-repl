/** Answers and response metadata. */

import type { Json, JsonObject } from "../json.js";
import { isObject } from "../json.js";
import { REQUEST_ID_HEADER } from "./constants.js";
import type { Headers } from "./errors.js";

/** A yes/no answer. */
export interface NoulAnswer {
  readonly type: "noul";
  /** Probability of "yes", from 0 to 1. */
  readonly noul: number;
}

/** A selected option with its distribution. */
export interface ChoiceAnswer {
  readonly type: "choice";
  /** The highest-probability option. */
  readonly choice: string;
  /** Every option mapped to its probability, in server order. */
  readonly probabilities: Readonly<Record<string, number>>;
  /** Certainty derived from the distribution, 0 to 1. */
  readonly confidence: number;
}

/** An expected score with its rubric and distribution. */
export interface ScoreAnswer {
  readonly type: "score";
  /** Probability-weighted level; may fall between levels. */
  readonly score: number;
  /** Certainty derived from the distribution, 0 to 1. */
  readonly confidence: number;
  /** Level index → the description you supplied. */
  readonly legend: ReadonlyMap<number, Json>;
  /** Level index → probability. */
  readonly probabilities: ReadonlyMap<number, number>;
}

/** An answer to one question. */
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** `noul >= threshold`. */
export function isYes(answer: NoulAnswer, threshold: number): boolean {
  return answer.noul >= threshold;
}

/** Labels ordered by descending probability. */
export function ranked(answer: ChoiceAnswer): Array<[string, number]> {
  return Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
}

/** The single most likely level (argmax of `probabilities`), as opposed to the weighted `score`. */
export function mostLikelyLevel(answer: ScoreAnswer): number | undefined {
  let best: number | undefined;
  let bestP = -Infinity;
  for (const [level, p] of answer.probabilities) {
    if (p > bestP) {
      bestP = p;
      best = level;
    }
  }
  return best;
}

/** `score` rounded to the nearest level. */
export function roundedLevel(answer: ScoreAnswer): number {
  return Math.max(0, Math.round(answer.score));
}

/** Confidence, for answer types that report it. */
export function answerConfidence(answer: Answer): number | undefined {
  return answer.type === "noul" ? undefined : answer.confidence;
}

/** Token usage. The API reports these when available; absent counts are `undefined`. */
export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** Metadata of the HTTP exchange that produced a response. */
export interface ResponseMeta {
  /** HTTP status. */
  readonly status: number;
  /** Response headers, lowercased. */
  readonly headers: Headers;
  /** Number of attempts made, including the successful one. */
  readonly attempts: number;
}

/** The result of a System One call. */
export interface SystemOneResponse {
  /** The model that answered. */
  readonly model: string;
  /** Token usage. */
  readonly usage: Usage;
  /**
   * Answers keyed by question name, in server order. Answer types unknown to this SDK version are
   * skipped and remain visible in {@link SystemOneResponse.raw}.
   */
  readonly answers: ReadonlyMap<string, Answer>;
  /** The full decoded body. */
  readonly raw: Json;
  /** HTTP metadata. */
  readonly meta: ResponseMeta;
  /** The `x-typesafe-request-id` header. */
  readonly requestId?: string;
  /** The answer to `name`, if it is a noul. */
  noul(name: string): NoulAnswer | undefined;
  /** The answer to `name`, if it is a choice. */
  choice(name: string): ChoiceAnswer | undefined;
  /** The answer to `name`, if it is a score. */
  score(name: string): ScoreAnswer | undefined;
}

/** One available model. */
export interface ModelMetadata {
  readonly name: string;
  readonly description: string;
  readonly release_date: string;
}

/** The models available to the account. */
export interface ListModelsResponse {
  readonly models: readonly ModelMetadata[];
  readonly raw: Json;
  readonly meta: ResponseMeta;
}

/** A decode failure with a dotted path to the offending field. */
export class DecodeFailure {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {}
}

function fail(path: string, detail: string): never {
  throw new DecodeFailure(path, detail);
}

function at(prefix: string, key: string): string {
  return prefix === "" ? key : `${prefix}.${key}`;
}

function requireNumber(v: Json | undefined, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(
      path,
      v === undefined ? `missing field \`${path.split(".").pop()}\`` : "expected a number",
    );
  }
  return v;
}

function requireString(v: Json | undefined, path: string): string {
  if (typeof v !== "string") {
    fail(
      path,
      v === undefined ? `missing field \`${path.split(".").pop()}\`` : "expected a string",
    );
  }
  return v;
}

function requireObject(v: Json | undefined, path: string): JsonObject {
  if (!isObject(v)) {
    fail(
      path,
      v === undefined ? `missing field \`${path.split(".").pop()}\`` : "expected an object",
    );
  }
  return v;
}

function numberMap(v: Json | undefined, path: string): Record<string, number> {
  const obj = requireObject(v, path);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(obj)) out[key] = requireNumber(value, at(path, key));
  return out;
}

function levelMap<T>(
  v: Json | undefined,
  path: string,
  read: (value: Json | undefined, path: string) => T,
): Map<number, T> {
  const obj = requireObject(v, path);
  const out = new Map<number, T>();
  for (const [key, value] of Object.entries(obj)) {
    const level = Number(key);
    if (!Number.isInteger(level) || level < 0) fail(at(path, key), "expected a level index");
    out.set(level, read(value, at(path, key)));
  }
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
}

function decodeAnswer(value: Json, prefix: string): Answer | undefined {
  const obj = requireObject(value, prefix);
  const type = obj["type"];
  if (typeof type !== "string") {
    fail(at(prefix, "type"), "missing or non-string answer type");
  }
  switch (type) {
    case "noul":
      return { type: "noul", noul: requireNumber(obj["noul"], at(prefix, "noul")) };
    case "choice":
      return {
        type: "choice",
        choice: requireString(obj["choice"], at(prefix, "choice")),
        probabilities: numberMap(obj["probabilities"], at(prefix, "probabilities")),
        confidence: requireNumber(obj["confidence"], at(prefix, "confidence")),
      };
    case "score":
      return {
        type: "score",
        score: requireNumber(obj["score"], at(prefix, "score")),
        confidence: requireNumber(obj["confidence"], at(prefix, "confidence")),
        legend: levelMap(obj["legend"], at(prefix, "legend"), (v) => v ?? null),
        probabilities: levelMap(obj["probabilities"], at(prefix, "probabilities"), (v, p) =>
          requireNumber(v, p),
        ),
      };
    default:
      // An answer type this version does not model: it stays visible in `raw`.
      return undefined;
  }
}

/** Build the response object the client hands back, with its typed lookups. */
export function makeSystemOneResponse(
  model: string,
  usage: Usage,
  answers: Map<string, Answer>,
  raw: Json,
  meta: ResponseMeta,
): SystemOneResponse {
  const typed = <T extends Answer>(name: string, type: Answer["type"]): T | undefined => {
    const answer = answers.get(name);
    return answer?.type === type ? (answer as T) : undefined;
  };
  return {
    model,
    usage,
    answers,
    raw,
    meta,
    requestId: meta.headers[REQUEST_ID_HEADER],
    noul: (name) => typed<NoulAnswer>(name, "noul"),
    choice: (name) => typed<ChoiceAnswer>(name, "choice"),
    score: (name) => typed<ScoreAnswer>(name, "score"),
  };
}

/** Decode a System One body, throwing {@link DecodeFailure} with the path of the bad field. */
export function decodeSystemOne(text: string): {
  model: string;
  usage: Usage;
  answers: Map<string, Answer>;
  raw: Json;
} {
  let body: Json;
  try {
    body = JSON.parse(text) as Json;
  } catch (e) {
    fail("", e instanceof Error ? e.message : String(e));
  }
  const obj = requireObject(body, "");
  const model = requireString(obj["model"], "model");
  const usageRaw = obj["usage"];
  const usage: Usage = {};
  if (isObject(usageRaw)) {
    const input = usageRaw["input_tokens"];
    const output = usageRaw["output_tokens"];
    if (typeof input === "number") (usage as { inputTokens?: number }).inputTokens = input;
    if (typeof output === "number") (usage as { outputTokens?: number }).outputTokens = output;
  }
  const answersRaw = requireObject(obj["answers"], "answers");
  const answers = new Map<string, Answer>();
  for (const [name, value] of Object.entries(answersRaw)) {
    const answer = decodeAnswer(value, `answers.${name}`);
    if (answer) answers.set(name, answer);
  }
  return { model, usage, answers, raw: body };
}

/** Decode a models list, throwing {@link DecodeFailure} with the path of the bad field. */
export function decodeModels(text: string): { models: ModelMetadata[]; raw: Json } {
  let body: Json;
  try {
    body = JSON.parse(text) as Json;
  } catch (e) {
    fail("", e instanceof Error ? e.message : String(e));
  }
  const obj = requireObject(body, "");
  const list = obj["models"];
  if (!Array.isArray(list)) fail("models", "expected an array");
  const models = list.map((entry, i) => {
    const prefix = `models[${i}]`;
    const m = requireObject(entry, prefix);
    return {
      name: requireString(m["name"], at(prefix, "name")),
      description: requireString(m["description"], at(prefix, "description")),
      release_date: requireString(m["release_date"], at(prefix, "release_date")),
    };
  });
  return { models, raw: body };
}
