/** The thing you are building in the REPL: a `state`, some named questions, a model. */

import type { Json, JsonObject } from "../json.js";
import { compact, isEmptyValue, isObject, pretty, tryParse } from "../json.js";
import type { Question } from "../typesafe/questions.js";
import {
  choice as makeChoice,
  noul as makeNoul,
  questionFromJson,
  questionToJson,
  raw as makeRaw,
  score as makeScore,
  withOption,
} from "../typesafe/questions.js";

/** A question under construction, kept in the order it was added. */
export type Entry = [name: string, question: Question];

/** Either a parsed value, or the message explaining what to type instead. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const err = <T>(error: string): Parsed<T> => ({ ok: false, error });

/** Everything the next `:ask` will send. */
export class Session {
  /** The text or JSON the model reasons about. */
  state: Json = "";
  /** Named questions, in insertion order. */
  questions: Entry[] = [];
  /** Per-session model override; `undefined` means the client default. */
  model: string | undefined;

  static from(parts: { state: Json; questions: Entry[]; model?: string | undefined }): Session {
    const session = new Session();
    session.state = parts.state;
    session.questions = parts.questions;
    session.model = parts.model;
    return session;
  }

  stateIsEmpty(): boolean {
    return isEmptyValue(this.state);
  }

  /** One-line preview of the state for the side panel. */
  statePreview(): string {
    return typeof this.state === "string" ? this.state : compact(this.state);
  }

  /** Add a question, or replace one of the same name in place. Returns whether it replaced one. */
  insert(name: string, question: Question): boolean {
    const at = this.questions.findIndex(([n]) => n === name);
    if (at >= 0) {
      this.questions[at] = [name, question];
      return true;
    }
    this.questions.push([name, question]);
    return false;
  }

  remove(name: string): boolean {
    const before = this.questions.length;
    this.questions = this.questions.filter(([n]) => n !== name);
    return this.questions.length !== before;
  }

  indexOf(name: string): number {
    const at = this.questions.findIndex(([n]) => n === name);
    return at < 0 ? 0 : at;
  }

  /** The `questions` object, in insertion order. */
  questionsJson(): JsonObject {
    const out: JsonObject = {};
    for (const [name, question] of this.questions) out[name] = questionToJson(question);
    return out;
  }

  /**
   * The exact JSON body the SDK will POST to `/v1/systemone`. Field and question order survive,
   * which is the whole point of showing it.
   */
  requestJson(model: string): string {
    return pretty({ state: this.state, model, questions: this.questionsJson() });
  }

  clone(): Session {
    return Session.from({
      state: this.state,
      questions: this.questions.map(([name, q]) => [name, q] as Entry),
      model: this.model,
    });
  }
}

/** `name instructions [| yes: ...] [| no: ...]` */
export function parseNoul(args: string): Parsed<Entry> {
  const split = splitName(args, ":noul is_urgent The message conveys urgency");
  if (!split.ok) return split;
  const [name, rest] = split.value;
  const parts = rest.split("|").map((p) => p.trim());
  const instructions = parts.shift() ?? "";
  if (instructions === "") {
    return err("A noul needs instructions: :noul is_urgent The message conveys urgency");
  }
  let question = makeNoul(value(instructions));
  for (const part of parts) {
    const at = part.indexOf(":");
    if (at === -1) {
      return err(`Expected \`yes: …\` or \`no: …\`, got ${JSON.stringify(part)}.`);
    }
    const tag = part.slice(0, at).trim().toLowerCase();
    const text = part.slice(at + 1).trim();
    if (tag === "yes" || tag === "true") {
      question = makeNoul(question.instructions, { ...question.criteria, yes: value(text) });
    } else if (tag === "no" || tag === "false") {
      question = makeNoul(question.instructions, { ...question.criteria, no: value(text) });
    } else {
      return err(`Unknown criterion ${JSON.stringify(tag)}; use \`yes:\` or \`no:\`.`);
    }
  }
  return ok([name, question]);
}

/** `name instructions | label=description | bare_label | …` */
export function parseChoice(args: string): Parsed<Entry> {
  const split = splitName(
    args,
    ":choice department Which team handles this | billing=Payments | technical=Bugs",
  );
  if (!split.ok) return split;
  const [name, rest] = split.value;
  const parts = rest.split("|").map((p) => p.trim());
  const instructions = parts.shift() ?? "";
  if (instructions === "") return err("A choice needs instructions before the first `|`.");
  let question = makeChoice(value(instructions));
  let count = 0;
  for (const part of parts.filter((p) => p !== "")) {
    const at = part.indexOf("=");
    question =
      at === -1
        ? withOption(question, part, null)
        : withOption(question, part.slice(0, at).trim(), value(part.slice(at + 1).trim()));
    count += 1;
  }
  if (count < 2) {
    return err("A choice needs at least two options: … | billing=Payments | technical=Bugs");
  }
  return ok([name, question]);
}

/** `name instructions | level | level | …` */
export function parseScore(args: string): Parsed<Entry> {
  const split = splitName(
    args,
    ":score frustration How frustrated they are | Calm | Annoyed | Furious",
  );
  if (!split.ok) return split;
  const [name, rest] = split.value;
  const parts = rest.split("|").map((p) => p.trim());
  const instructions = parts.shift() ?? "";
  if (instructions === "") return err("A score needs instructions before the first `|`.");
  const levels = parts.filter((p) => p !== "").map(value);
  if (levels.length < 2) {
    return err("A score needs at least two ordered levels: … | Calm | Annoyed | Furious");
  }
  return ok([name, makeScore(value(instructions), levels)]);
}

/** `name {json}` — a hand-built question object. */
export function parseRaw(args: string): Parsed<Entry> {
  const split = splitName(args, ':raw tone {"type": "noul", "instructions": "Polite?"}');
  if (!split.ok) return split;
  const [name, rest] = split.value;
  try {
    return ok([name, makeRaw(JSON.parse(rest) as Json)]);
  } catch (e) {
    return err(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function splitName(args: string, example: string): Parsed<[string, string]> {
  const trimmed = args.trim();
  const at = trimmed.search(/\s/);
  if (at === -1) return err(`Missing name or body. Try: ${example}`);
  const name = trimmed.slice(0, at);
  if (name === "") return err(`Missing a question name. Try: ${example}`);
  return ok([name, trimmed.slice(at + 1).trim()]);
}

/**
 * Instructions, descriptions and levels accept any JSON, so `{…}`/`[…]` is parsed as such and
 * anything else is sent as a plain string.
 */
export function value(text: string): Json {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    const parsed = tryParse(t);
    if (parsed !== undefined) return parsed;
  }
  return t;
}

/**
 * Rebuild a session from a saved request body (`:open`), keeping typed questions where the `type`
 * is one this SDK models.
 */
export function fromBody(text: string): Parsed<Session> {
  let body: Json;
  try {
    body = JSON.parse(text) as Json;
  } catch (e) {
    return err(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(body)) return err("Expected a JSON object.");
  const questions = body["questions"];
  if (!isObject(questions)) return err("Expected a `questions` object.");
  const model = body["model"];
  return ok(
    Session.from({
      state: body["state"] ?? null,
      questions: Object.entries(questions).map(([name, q]) => [name, questionFromJson(q)] as Entry),
      model: typeof model === "string" ? model : undefined,
    }),
  );
}
